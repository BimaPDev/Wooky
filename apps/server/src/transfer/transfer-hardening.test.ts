import { describe, expect, it } from "vitest";
import { DeviceSettings, type AgeEvent, type Command, type PendingEvent } from "@wooky/contracts";
import type { Effect } from "../orchestrator/effects.ts";
import { ServiceError } from "../errors.ts";
import { createNoopGitService } from "../git/noop.ts";
import { createDemoAdapter } from "../providers/demo/adapter.ts";
import { createProviderRegistry } from "../providers/registry.ts";
import { createThemeStore } from "../settings/themes.ts";
import { openEventStore } from "../store/event-store.ts";
import { tempDir, testContext } from "../testing.ts";
import { createEffectRunner } from "../effects/runner.ts";
import { createRequestAuth } from "../remote/auth.ts";
import type { PeerDirectory } from "../remote/peers.ts";
import { guardTransferCommand } from "./guard.ts";
import { MAX_TURN_BYTES, validateHistoryTurns } from "./history-validation.ts";
import { acceptReplicaEvents } from "./replicas.ts";
import { CHECKPOINT_TTL_MS, CLAIM_TTL_MS, createTransferService } from "./service.ts";

const AT = "2026-01-01T00:00:00.000Z";
const LATER = new Date(Date.parse(AT) + 400 * 24 * 3_600_000).toISOString();

const thread = (overrides: Record<string, unknown> = {}) => ({
  id: "remote-t",
  projectId: "p1",
  title: "Remote work",
  provider: "demo" as const,
  model: "demo",
  runtimeMode: "approve" as const,
  worktree: null,
  providerSessionId: null,
  ownerDeviceId: null,
  movedTo: null,
  movedFrom: null,
  pullRequest: null,
  queue: [],
  status: "idle" as const,
  createdAt: AT,
  updatedAt: AT,
  ...overrides,
});

function ownerEvents(options: { runtimeMode?: "approve" | "full"; releasedTo?: string } = {}) {
  const events: AgeEvent[] = [
    {
      seq: 1,
      at: AT,
      commandId: "c1",
      type: "thread.created",
      thread: thread({ runtimeMode: options.runtimeMode ?? "approve" }),
    },
    {
      seq: 2,
      at: AT,
      commandId: "c2",
      type: "turn.started",
      threadId: "remote-t",
      turnId: "u1",
      prompt: "Do the work",
      provider: "demo",
      model: "demo",
      checkpointBefore: "refs/wooky/checkpoints/remote-t/u1/before",
    },
    {
      seq: 3,
      at: AT,
      commandId: null,
      type: "turn.finished",
      threadId: "remote-t",
      turnId: "u1",
      status: "completed",
      checkpointAfter: "refs/wooky/../../../etc/passwd",
      changedFiles: ["src/a.ts", "../../etc/passwd", "/abs/path"],
      usage: null,
      error: null,
    },
  ];
  if (options.releasedTo) {
    events.push({
      seq: 4,
      at: AT,
      commandId: "rel",
      type: "thread.released",
      threadId: "remote-t",
      toDeviceId: options.releasedTo,
    });
  }
  return events;
}

function claimEvents(
  claimId: string,
  ownerThreadId = "remote-t",
): { events: PendingEvent[]; effects: Effect[] } {
  return {
    events: [
      {
        type: "thread.claimRequested",
        commandId: claimId,
        claimId,
        ownerDeviceId: "owner",
        ownerThreadId,
        projectId: "p1",
      },
    ],
    effects: [
      {
        kind: "claimThread",
        threadId: claimId,
        claimId,
        ownerDeviceId: "owner",
        ownerThreadId,
        projectId: "p1",
      },
    ],
  };
}

const offlinePeers: PeerDirectory = {
  list: () => [],
  get: () => undefined,
};

async function harness(now: () => string = () => AT) {
  const home = await tempDir("hardening");
  const ctx = { ...testContext(), now };
  const store = openEventStore(home, ctx.now);
  const themes = createThemeStore(home);
  themes.putSettings({
    sync: {
      enabled: true,
      peers: ["owner"],
      categories: { files: true, threads: true, settings: false, themes: false },
    },
  });
  store.appendInternal([
    {
      type: "project.added",
      commandId: null,
      project: {
        id: "p1",
        name: "p",
        root: home,
        createdAt: AT,
        settings: { scripts: [], sharedPaths: [], prompts: [] },
      },
    },
  ]);
  const transfer = createTransferService({
    home,
    store,
    themes,
    deviceId: "local",
    peers: offlinePeers,
    authenticate: createRequestAuth({ addressOf: () => undefined, lookup: () => null })
      .authenticateRequest,
    syncNow: async () => {},
    dispatch: () => ({ accepted: false, duplicate: false, seq: store.model.seq }),
    newId: ctx.newId,
    now: ctx.now,
    hasProvider: () => true,
    broadcastSync: () => {},
  });
  const runner = createEffectRunner({
    store,
    providers: createProviderRegistry([createDemoAdapter({ stepMs: 0 })]),
    git: createNoopGitService(),
    newId: ctx.newId,
    runClaimThread: (effect) => transfer.runClaimThread(effect),
    recoverClaims: () => transfer.recoverClaims(),
  });
  return { home, store, themes, transfer, runner };
}

const importedEvents = (store: { eventsAfter(seq: number): AgeEvent[] }) =>
  store.eventsAfter(0).filter((event) => event.type === "thread.imported");

describe("claim import", () => {
  it("imports exactly once when the runner and startup recovery both run the claim", async () => {
    const { store, runner, transfer } = await harness();
    store.appendReplicaEvents("owner", ownerEvents({ releasedTo: "local" }));
    const { events, effects } = claimEvents("claim-1");
    store.commit({ commandId: "claim-1", events, effects });
    store.markClaimReleased("claim-1");

    runner.recover();
    await runner.idle();
    expect(importedEvents(store)).toHaveLength(1);

    runner.recover();
    transfer.recoverClaims();
    await transfer.runClaimThread({
      kind: "claimThread",
      threadId: "claim-1",
      claimId: "claim-1",
      ownerDeviceId: "owner",
      ownerThreadId: "remote-t",
      projectId: "p1",
    });
    await runner.idle();
    expect(importedEvents(store)).toHaveLength(1);
    expect(Object.values(store.model.threads).filter((item) => item.movedFrom)).toHaveLength(1);
    expect(store.isClaimReleased("claim-1")).toBe(false);
    store.close();
  });

  it("caps an imported thread at approve and clears checkpoints and unsafe paths", async () => {
    const { store, runner } = await harness();
    store.appendReplicaEvents("owner", ownerEvents({ runtimeMode: "full", releasedTo: "local" }));
    const { events, effects } = claimEvents("claim-2");
    store.commit({ commandId: "claim-2", events, effects });
    store.markClaimReleased("claim-2");
    runner.recover();
    await runner.idle();

    const imported = Object.values(store.model.threads).find((item) => item.movedFrom);
    expect(imported?.runtimeMode).toBe("approve");
    const turn = store.model.turns[imported?.id ?? ""]?.[0];
    expect(turn?.checkpointBefore).toBeNull();
    expect(turn?.checkpointAfter).toBeNull();
    expect(turn?.changedFiles).toEqual(["src/a.ts"]);
    store.close();
  });
});

describe("history validation", () => {
  const turn = (overrides: Record<string, unknown> = {}) => ({
    id: "u1",
    threadId: "t",
    prompt: "p",
    provider: "demo",
    model: "demo",
    status: "completed",
    items: [],
    startedAt: AT,
    endedAt: AT,
    checkpointBefore: "refs/wooky/checkpoints/t/u1/before",
    checkpointAfter: "refs/wooky/../escape",
    changedFiles: ["ok.ts", "a/../../b", "C:\\win", "", "x\0y"],
    usage: null,
    error: null,
    nativeRef: "demo:u1",
    ...overrides,
  });

  it("clears refs and native ids, and drops unsafe changed files", () => {
    const [kept] = validateHistoryTurns([turn()]);
    expect(kept?.checkpointBefore).toBeNull();
    expect(kept?.checkpointAfter).toBeNull();
    expect(kept?.nativeRef).toBeNull();
    expect(kept?.changedFiles).toEqual(["ok.ts"]);
  });

  it("drops running turns, malformed turns and oversized turns", () => {
    const big = turn({
      id: "big",
      items: [{ kind: "message", id: "m", role: "assistant", text: "x".repeat(MAX_TURN_BYTES) }],
    });
    const kept = validateHistoryTurns([
      turn({ id: "a" }),
      turn({ id: "run", status: "running" }),
      { nonsense: true },
      big,
      turn({ id: "b" }),
    ]);
    expect(kept.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("keeps at most 500 turns, the newest", () => {
    const many = Array.from({ length: 600 }, (_, index) => turn({ id: `u${index}` }));
    const kept = validateHistoryTurns(many);
    expect(kept).toHaveLength(500);
    expect(kept.at(-1)?.id).toBe("u599");
    expect(validateHistoryTurns("nope")).toEqual([]);
  });
});

describe("replica intake", () => {
  it("accepts only thread and turn events in increasing order", () => {
    const [created] = ownerEvents();
    const project: AgeEvent = {
      seq: 5,
      at: AT,
      commandId: "x",
      type: "project.removed",
      projectId: "p1",
    };
    const accepted = acceptReplicaEvents(
      [created, project, { seq: "nope" }, { ...created, seq: 1 }, { ...created, seq: 7 }],
      0,
    );
    expect(accepted.map((event) => event.seq)).toEqual([1, 7]);
    expect(acceptReplicaEvents([{ ...created, seq: 3 }], 3)).toEqual([]);
  });
});

describe("transfer guard", () => {
  const settings = DeviceSettings.parse({
    sync: {
      enabled: true,
      categories: { files: true, threads: true, settings: true, themes: true },
      peers: ["dev-b"],
    },
  });
  const release = (toDeviceId: string): Command => ({
    commandId: "r",
    type: "thread.release",
    threadId: "t",
    toDeviceId,
  });
  const claim: Command = {
    commandId: "c",
    type: "thread.claim",
    ownerDeviceId: "dev-b",
    ownerThreadId: "t",
    projectId: "p",
  };
  const peer = { deviceId: "dev-b", local: false };

  it("lets a paired peer release only to itself", () => {
    expect(() => guardTransferCommand(release("dev-b"), peer, settings)).not.toThrow();
    expect(() => guardTransferCommand(release("dev-c"), peer, settings)).toThrow(ServiceError);
  });

  it("refuses a paired device that is not a sync peer, or when sync is off", () => {
    const stranger = { deviceId: "dev-x", local: false };
    expect(() => guardTransferCommand(release("dev-x"), stranger, settings)).toThrow(/peer/);
    const off = DeviceSettings.parse({});
    expect(() => guardTransferCommand(release("dev-b"), peer, off)).toThrow(/peer/);
  });

  it("refuses claim and import from a peer, allows them from the operator", () => {
    expect(() => guardTransferCommand(claim, peer, settings)).toThrow(/this machine/);
    const operator = { deviceId: "local", local: true };
    expect(() => guardTransferCommand(claim, operator, settings)).not.toThrow();
    expect(() => guardTransferCommand(release("anyone"), operator, settings)).not.toThrow();
  });
});

describe("housekeeping", () => {
  it("fails a stale claim that never released, and keeps one that did", async () => {
    let clock = AT;
    const { store, transfer } = await harness(() => clock);
    for (const id of ["stale", "released"]) {
      const { events, effects } = claimEvents(id, `t-${id}`);
      store.commit({ commandId: id, events, effects });
    }
    store.markClaimReleased("released");
    transfer.housekeeping();
    expect(Object.keys(store.model.pendingClaims).sort()).toEqual(["released", "stale"]);
    clock = new Date(Date.parse(AT) + CLAIM_TTL_MS + 1000).toISOString();
    transfer.housekeeping();
    expect(Object.keys(store.model.pendingClaims)).toEqual(["released"]);
    expect(
      store.eventsAfter(0).filter((event) => event.type === "thread.claimFailed"),
    ).toHaveLength(1);
    store.close();
  });

  it("drops a leftover release marker with no pending claim after a day", async () => {
    let clock = AT;
    const { store, transfer } = await harness(() => clock);
    store.markClaimReleased("old");
    transfer.housekeeping();
    expect(store.isClaimReleased("old")).toBe(true);
    clock = new Date(Date.parse(AT) + CHECKPOINT_TTL_MS + 1000).toISOString();
    transfer.housekeeping();
    expect(store.isClaimReleased("old")).toBe(false);
    store.close();
  });

  it("forgets owners that are no longer peers", async () => {
    const { store, themes, transfer } = await harness();
    store.appendReplicaEvents("owner", ownerEvents());
    store.appendReplicaEvents("gone", ownerEvents());
    transfer.replicas.foldOwner("owner");
    transfer.replicas.foldOwner("gone");
    expect(Object.keys(transfer.replicas.model.replicas).sort()).toEqual(["gone", "owner"]);
    transfer.housekeeping();
    expect(store.replicaOwners()).toEqual(["owner"]);
    expect(Object.keys(transfer.replicas.model.replicas)).toEqual(["owner"]);
    expect(themes.getSettings().sync.peers).toEqual(["owner"]);
    store.close();
  });

  it("drops the replica of a thread that now lives here, but keeps the pull cursor", async () => {
    const { store, runner, transfer } = await harness();
    store.appendReplicaEvents("owner", ownerEvents({ releasedTo: "local" }));
    const { events, effects } = claimEvents("claim-h");
    store.commit({ commandId: "claim-h", events, effects });
    store.markClaimReleased("claim-h");
    runner.recover();
    await runner.idle();
    expect(importedEvents(store)).toHaveLength(1);
    expect(transfer.replicas.model.replicas.owner?.threads["remote-t"]).toBeDefined();

    transfer.housekeeping();
    expect(store.replicaEventsAfter("owner", 0)).toEqual([]);
    expect(transfer.replicas.model.replicas.owner?.threads["remote-t"]).toBeUndefined();
    expect(store.replicaHighWater("owner")).toBe(4);
    store.close();
  });

  it("drops replica events of a thread the owner removed", async () => {
    const { store, transfer } = await harness();
    store.appendReplicaEvents("owner", [
      ...ownerEvents(),
      { seq: 4, at: AT, commandId: "rm", type: "thread.removed", threadId: "remote-t" },
    ]);
    transfer.replicas.foldOwner("owner");
    transfer.housekeeping();
    expect(store.replicaEventsAfter("owner", 0)).toEqual([]);
    store.close();
  });

  it("forgets an idle replicated thread nobody touched for 90 days", async () => {
    let clock = AT;
    const { store, transfer } = await harness(() => clock);
    store.appendReplicaEvents("owner", ownerEvents());
    transfer.replicas.foldOwner("owner");
    transfer.housekeeping();
    expect(store.replicaEventsAfter("owner", 0)).toHaveLength(3);
    clock = LATER;
    transfer.housekeeping();
    expect(store.replicaEventsAfter("owner", 0)).toEqual([]);
    store.close();
  });
});
