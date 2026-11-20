import { describe, expect, it } from "vitest";
import type { AgeEvent } from "@wooky/contracts";
import { createNoopGitService } from "../git/noop.ts";
import { createDemoAdapter } from "../providers/demo/adapter.ts";
import { createProviderRegistry } from "../providers/registry.ts";
import { createThemeStore } from "../settings/themes.ts";
import { openEventStore } from "../store/event-store.ts";
import { tempDir, testContext, waitForEvent } from "../testing.ts";
import { createEffectRunner } from "../effects/runner.ts";
import { createRequestAuth } from "../remote/auth.ts";
import type { PeerDirectory } from "../remote/peers.ts";
import { createTransferService } from "./service.ts";

const AT = "2026-01-01T00:00:00.000Z";

function ownerReplicaEvents(releasedTo?: string): AgeEvent[] {
  const events: AgeEvent[] = [
    {
      seq: 1,
      at: AT,
      commandId: "c1",
      type: "thread.created",
      thread: {
        id: "remote-t",
        projectId: "p1",
        title: "Remote work",
        provider: "demo",
        model: "demo",
        runtimeMode: "approve",
        worktree: null,
        providerSessionId: null,
        ownerDeviceId: null,
        movedTo: null,
        movedFrom: null,
        pullRequest: null,
        queue: [],
        status: "idle",
        createdAt: AT,
        updatedAt: AT,
      },
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
      checkpointBefore: null,
    },
    {
      seq: 3,
      at: AT,
      commandId: null,
      type: "turn.finished",
      threadId: "remote-t",
      turnId: "u1",
      status: "completed",
      checkpointAfter: null,
      changedFiles: [],
      usage: null,
      error: null,
    },
  ];
  if (releasedTo) {
    events.push({
      seq: 4,
      at: AT,
      commandId: "rel-1",
      type: "thread.released",
      threadId: "remote-t",
      toDeviceId: releasedTo,
    });
  }
  return events;
}

describe("claim crash recovery", () => {
  it("retries a pending claim after restart", async () => {
    const home = await tempDir("crash");
    const ctx = testContext();
    const store = openEventStore(home, ctx.now);
    const themes = createThemeStore(home);
    themes.putSettings({
      sync: {
        enabled: true,
        peers: ["owner"],
        categories: { files: true, threads: true, settings: false, themes: false },
      },
    });
    const peers: PeerDirectory = {
      list: () => [
        {
          deviceId: "owner",
          name: "Owner",
          baseUrl: "http://127.0.0.1:9",
          token: "tok",
        },
      ],
      get: (id) => peers.list().find((peer) => peer.deviceId === id),
    };

    createTransferService({
      home,
      store,
      themes,
      deviceId: "local",
      peers,
      authenticate: createRequestAuth({
        addressOf: (req) => req.socket.remoteAddress,
        lookup: (token) => (token === "tok" ? "owner" : null),
      }).authenticateRequest,
      syncNow: async () => {},
      dispatch: (command) => {
        void command;
        return { accepted: true, duplicate: false, seq: store.model.seq };
      },
      newId: ctx.newId,
      now: ctx.now,
      hasProvider: () => true,
      broadcastSync: () => {},
    });

    store.commit({
      commandId: "claim-1",
      events: [
        {
          type: "thread.claimRequested",
          commandId: "claim-1",
          claimId: "claim-1",
          ownerDeviceId: "owner",
          ownerThreadId: "remote-t",
          projectId: "p1",
        },
      ],
      effects: [
        {
          kind: "claimThread",
          threadId: "claim-1",
          claimId: "claim-1",
          ownerDeviceId: "owner",
          ownerThreadId: "remote-t",
          projectId: "p1",
        },
      ],
    });

    store.close();

    const store2 = openEventStore(home, ctx.now);
    const themes2 = createThemeStore(home);
    const transfer2 = createTransferService({
      home,
      store: store2,
      themes: themes2,
      deviceId: "local",
      peers,
      authenticate: createRequestAuth({
        addressOf: (req) => req.socket.remoteAddress,
        lookup: () => null,
      }).authenticateRequest,
      syncNow: async () => {},
      dispatch: () => ({ accepted: false, duplicate: false, seq: store2.model.seq }),
      newId: ctx.newId,
      now: ctx.now,
      hasProvider: () => true,
      broadcastSync: () => {},
    });
    const runner2 = createEffectRunner({
      store: store2,
      providers: createProviderRegistry([createDemoAdapter({ stepMs: 0 })]),
      git: createNoopGitService(),
      newId: ctx.newId,
      runClaimThread: (effect) => transfer2.runClaimThread(effect),
      recoverClaims: () => transfer2.recoverClaims(),
    });

    runner2.recover();
    await runner2.idle();

    const failed = await waitForEvent(store2, "thread.claimFailed", () => true, 0).catch(
      () => null,
    );
    expect(
      failed?.type === "thread.claimFailed" || Object.keys(store2.model.pendingClaims).length,
    ).toBeTruthy();
    store2.close();
  });

  it("imports after crash when local claimReleased checkpoint is recorded", async () => {
    const home = await tempDir("crash-checkpoint");
    const ctx = testContext();
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
        project: { id: "p1", name: "p", root: home, createdAt: AT, settings: { scripts: [] } },
      },
    ]);
    store.appendReplicaEvents("owner", ownerReplicaEvents());
    store.commit({
      commandId: "claim-cp",
      events: [
        {
          type: "thread.claimRequested",
          commandId: "claim-cp",
          claimId: "claim-cp",
          ownerDeviceId: "owner",
          ownerThreadId: "remote-t",
          projectId: "p1",
        },
      ],
      effects: [
        {
          kind: "claimThread",
          threadId: "claim-cp",
          claimId: "claim-cp",
          ownerDeviceId: "owner",
          ownerThreadId: "remote-t",
          projectId: "p1",
        },
      ],
    });
    store.markClaimReleased("claim-cp");
    store.close();

    // Owner is unreachable after restart, proving recovery does not re-release.
    const peers: PeerDirectory = {
      list: () => [
        { deviceId: "owner", name: "Owner", baseUrl: "http://127.0.0.1:9", token: "tok" },
      ],
      get: (id) => peers.list().find((peer) => peer.deviceId === id),
    };
    const store2 = openEventStore(home, ctx.now);
    const transfer2 = createTransferService({
      home,
      store: store2,
      themes: createThemeStore(home),
      deviceId: "local",
      peers,
      authenticate: createRequestAuth({
        addressOf: (req) => req.socket.remoteAddress,
        lookup: () => null,
      }).authenticateRequest,
      syncNow: async () => {},
      dispatch: () => ({ accepted: false, duplicate: false, seq: store2.model.seq }),
      newId: ctx.newId,
      now: ctx.now,
      hasProvider: () => true,
      broadcastSync: () => {},
    });
    const runner2 = createEffectRunner({
      store: store2,
      providers: createProviderRegistry([createDemoAdapter({ stepMs: 0 })]),
      git: createNoopGitService(),
      newId: ctx.newId,
      runClaimThread: (effect) => transfer2.runClaimThread(effect),
      recoverClaims: () => transfer2.recoverClaims(),
    });

    runner2.recover();
    await runner2.idle();

    const imported = Object.values(store2.model.threads).find(
      (thread) => thread.movedFrom?.threadId === "remote-t",
    );
    expect(imported).toBeDefined();
    expect(store2.model.turns[imported?.id ?? ""]?.length).toBe(1);
    expect(store2.model.pendingClaims).toEqual({});
    expect(store2.isClaimReleased("claim-cp")).toBe(false);
    expect(store2.eventsAfter(0).some((event) => event.type === "thread.claimFailed")).toBe(false);
    store2.close();
  });

  it("imports after crash when owner already released to this device before checkpoint", async () => {
    const home = await tempDir("crash-owner-released");
    const ctx = testContext();
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
        project: { id: "p1", name: "p", root: home, createdAt: AT, settings: { scripts: [] } },
      },
    ]);
    // Replica already shows the owner released this thread to "local", no local checkpoint saved.
    store.appendReplicaEvents("owner", ownerReplicaEvents("local"));
    store.commit({
      commandId: "claim-rel",
      events: [
        {
          type: "thread.claimRequested",
          commandId: "claim-rel",
          claimId: "claim-rel",
          ownerDeviceId: "owner",
          ownerThreadId: "remote-t",
          projectId: "p1",
        },
      ],
      effects: [
        {
          kind: "claimThread",
          threadId: "claim-rel",
          claimId: "claim-rel",
          ownerDeviceId: "owner",
          ownerThreadId: "remote-t",
          projectId: "p1",
        },
      ],
    });
    store.close();

    const peers: PeerDirectory = {
      list: () => [],
      get: () => undefined,
    };
    const store2 = openEventStore(home, ctx.now);
    const transfer2 = createTransferService({
      home,
      store: store2,
      themes: createThemeStore(home),
      deviceId: "local",
      peers,
      authenticate: createRequestAuth({
        addressOf: (req) => req.socket.remoteAddress,
        lookup: () => null,
      }).authenticateRequest,
      syncNow: async () => {},
      dispatch: () => ({ accepted: false, duplicate: false, seq: store2.model.seq }),
      newId: ctx.newId,
      now: ctx.now,
      hasProvider: () => true,
      broadcastSync: () => {},
    });
    const runner2 = createEffectRunner({
      store: store2,
      providers: createProviderRegistry([createDemoAdapter({ stepMs: 0 })]),
      git: createNoopGitService(),
      newId: ctx.newId,
      runClaimThread: (effect) => transfer2.runClaimThread(effect),
      recoverClaims: () => transfer2.recoverClaims(),
    });

    runner2.recover();
    await runner2.idle();

    const imported = Object.values(store2.model.threads).find(
      (thread) => thread.movedFrom?.threadId === "remote-t",
    );
    expect(imported).toBeDefined();
    expect(store2.model.pendingClaims).toEqual({});
    expect(store2.eventsAfter(0).some((event) => event.type === "thread.claimFailed")).toBe(false);
    store2.close();
  });
});
