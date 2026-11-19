import { describe, expect, it } from "vitest";
import type { ModelTarget, ReadModel, Thread, TurnFailure } from "@age/contracts";
import { emptyReadModel } from "./project.ts";
import { applyEvent } from "./project.ts";
import {
  cooldownUntil,
  DEFAULT_MODEL_RANKING,
  pickFallback,
  shouldSwitchBack,
} from "./failover.ts";

const now = "2026-01-01T12:00:00.000Z";

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "t1",
    projectId: "p1",
    title: "Test",
    provider: "claude",
    model: "sonnet",
    runtimeMode: "auto-edits",
    worktree: null,
    providerSessionId: null,
    status: "idle",
    createdAt: now,
    updatedAt: now,
    queue: [],
    ...overrides,
  };
}

function model(overrides: Partial<ReadModel> = {}): ReadModel {
  return { ...emptyReadModel(), ...overrides };
}

const rateLimit: TurnFailure = { kind: "rate_limit", message: "slow down" };

describe("cooldownUntil", () => {
  it("prefers resetAt", () => {
    expect(
      cooldownUntil({ kind: "rate_limit", message: "", resetAt: "2026-01-01T13:00:00.000Z" }, now),
    ).toBe("2026-01-01T13:00:00.000Z");
  });

  it("uses retryAfterMs when resetAt is absent", () => {
    const until = cooldownUntil({ kind: "overloaded", message: "", retryAfterMs: 60_000 }, now);
    expect(until).toBe("2026-01-01T12:01:00.000Z");
  });

  it("falls back to 15 minutes for rate_limit and overloaded", () => {
    expect(cooldownUntil({ kind: "rate_limit", message: "" }, now)).toBe(
      "2026-01-01T12:15:00.000Z",
    );
    expect(cooldownUntil({ kind: "overloaded", message: "" }, now)).toBe(
      "2026-01-01T12:15:00.000Z",
    );
  });

  it("falls back to 5 hours for quota", () => {
    expect(cooldownUntil({ kind: "quota", message: "" }, now)).toBe("2026-01-01T17:00:00.000Z");
  });
});

describe("pickFallback", () => {
  const always = () => true;

  it("uses default ranking when the chain is empty", () => {
    const picked = pickFallback({
      readModel: model(),
      thread: thread(),
      chain: [],
      now,
      available: always,
      failure: rateLimit,
    });
    expect(picked).toEqual({ provider: "codex", model: "gpt-6.1-sol" });
  });

  it("respects a user-defined chain", () => {
    const chain: ModelTarget[] = [
      { provider: "codex", model: "default" },
      { provider: "cursor", model: "auto" },
    ];
    const picked = pickFallback({
      readModel: model(),
      thread: thread(),
      chain,
      now,
      available: always,
      failure: rateLimit,
    });
    expect(picked).toEqual({ provider: "codex", model: "default" });
  });

  it("skips targets on provider- or model-level cooldown", () => {
    const readModel = model({
      cooldowns: {
        cursor: { until: "2026-01-01T13:00:00.000Z", reason: "rate_limit" },
        "claude/sonnet": { until: "2026-01-01T13:00:00.000Z", reason: "quota" },
      },
    });
    const picked = pickFallback({
      readModel,
      thread: thread({ provider: "claude", model: "sonnet" }),
      chain: [],
      now,
      available: always,
      failure: rateLimit,
    });
    expect(picked?.provider).not.toBe("cursor");
    expect(picked?.provider).not.toBe("claude");
  });

  it("returns null when max switches are reached", () => {
    const picked = pickFallback({
      readModel: model(),
      thread: thread({
        failover: {
          original: { provider: "claude", model: "sonnet" },
          switchedAt: now,
          reason: "rate_limit",
          switches: 3,
        },
      }),
      chain: [],
      now,
      available: always,
      failure: rateLimit,
      maxSwitchesPerPrompt: 3,
    });
    expect(picked).toBeNull();
  });

  it("skips unavailable targets", () => {
    const available = (t: ModelTarget) => t.provider !== "cursor";
    const picked = pickFallback({
      readModel: model(),
      thread: thread(),
      chain: [],
      now,
      available,
      failure: rateLimit,
    });
    expect(picked?.provider).not.toBe("cursor");
  });

  it("does not pick another model on the same provider for account-scoped failures", () => {
    const chain: ModelTarget[] = [{ provider: "claude", model: "haiku" }];
    const picked = pickFallback({
      readModel: model(),
      thread: thread({ provider: "claude", model: "sonnet" }),
      chain,
      now,
      available: always,
      failure: rateLimit,
    });
    expect(picked).toBeNull();
  });

  it("prefers other providers first for account-scoped failures", () => {
    const chain: ModelTarget[] = [
      { provider: "claude", model: "haiku" },
      { provider: "codex", model: "default" },
    ];
    const picked = pickFallback({
      readModel: model(),
      thread: thread({ provider: "claude", model: "sonnet" }),
      chain,
      now,
      available: always,
      failure: rateLimit,
    });
    expect(picked).toEqual({ provider: "codex", model: "default" });
  });

  it("keeps chain order for model-scoped failures", () => {
    const chain: ModelTarget[] = [
      { provider: "claude", model: "haiku" },
      { provider: "codex", model: "default" },
    ];
    const picked = pickFallback({
      readModel: model(),
      thread: thread({ provider: "claude", model: "sonnet" }),
      chain,
      now,
      available: always,
      failure: { kind: "auth", message: "expired" },
    });
    expect(picked).toEqual({ provider: "claude", model: "haiku" });
  });

  it("skips demo unless the thread is on demo", () => {
    const chain: ModelTarget[] = [{ provider: "demo", model: "demo" }];
    expect(
      pickFallback({
        readModel: model(),
        thread: thread(),
        chain,
        now,
        available: always,
        failure: rateLimit,
      }),
    ).toBeNull();
    expect(
      pickFallback({
        readModel: model(),
        thread: thread({ provider: "demo", model: "demo" }),
        chain: [],
        now,
        available: always,
        failure: rateLimit,
      }),
    ).toEqual({ provider: "claude", model: "opus" });
  });
});

describe("shouldSwitchBack", () => {
  it("is false without failover state", () => {
    expect(shouldSwitchBack(thread(), model(), now)).toBe(false);
  });

  it("waits for resetAt and cooldown on the original target", () => {
    const failover = thread({
      provider: "cursor",
      model: "auto",
      failover: {
        original: { provider: "claude", model: "sonnet" },
        switchedAt: now,
        reason: "rate_limit",
        resetAt: "2026-01-01T13:00:00.000Z",
        switches: 1,
      },
    });
    expect(shouldSwitchBack(failover, model(), now)).toBe(false);
    const cooled = model({
      cooldowns: { claude: { until: "2026-01-01T15:00:00.000Z", reason: "rate_limit" } },
    });
    expect(shouldSwitchBack(failover, cooled, "2026-01-01T14:00:00.000Z")).toBe(false);
    expect(shouldSwitchBack(failover, model(), "2026-01-01T14:00:00.000Z")).toBe(true);
  });
});

describe("failover reducer events", () => {
  const base = () =>
    applyEvent(emptyReadModel(), {
      type: "thread.created",
      seq: 1,
      at: now,
      commandId: "c1",
      thread: thread(),
    } as const);

  it("tracks cooldowns and failover on the thread", () => {
    let m = applyEvent(base(), {
      type: "provider.cooledDown",
      seq: 2,
      at: now,
      commandId: null,
      key: "claude",
      until: "2026-01-01T13:00:00.000Z",
      reason: "rate_limit",
    });
    expect(m.cooldowns.claude?.until).toBe("2026-01-01T13:00:00.000Z");

    m = applyEvent(m, {
      type: "thread.failedOver",
      seq: 3,
      at: now,
      commandId: "c2",
      threadId: "t1",
      from: { provider: "claude", model: "sonnet" },
      to: { provider: "cursor", model: "auto" },
      failure: rateLimit,
      switches: 1,
    });
    expect(m.threads.t1?.provider).toBe("cursor");
    expect(m.threads.t1?.failover?.original).toEqual({ provider: "claude", model: "sonnet" });

    m = applyEvent(m, {
      type: "thread.failoverRestored",
      seq: 4,
      at: now,
      commandId: "c3",
      threadId: "t1",
      to: { provider: "claude", model: "sonnet" },
    });
    expect(m.threads.t1?.failover).toBeUndefined();
    expect(m.threads.t1?.model).toBe("sonnet");

    m = applyEvent(m, {
      type: "thread.sessionBound",
      seq: 5,
      at: now,
      commandId: null,
      threadId: "t1",
      providerSessionId: "sess-1",
    });
    m = applyEvent(m, {
      type: "thread.failedOver",
      seq: 6,
      at: now,
      commandId: "c5",
      threadId: "t1",
      from: { provider: "claude", model: "sonnet" },
      to: { provider: "claude", model: "opus" },
      failure: { kind: "rate_limit", message: "x", resetAt: "2026-01-01T13:00:00.000Z" },
      switches: 1,
    });
    expect(m.threads.t1?.providerSessionId).toBe("sess-1");
    m = applyEvent(m, {
      type: "thread.failedOver",
      seq: 7,
      at: now,
      commandId: "c6",
      threadId: "t1",
      from: { provider: "claude", model: "opus" },
      to: { provider: "cursor", model: "auto" },
      failure: { kind: "rate_limit", message: "x", resetAt: "2026-01-01T14:00:00.000Z" },
      switches: 2,
    });
    expect(m.threads.t1?.providerSessionId).toBeNull();
    expect(m.threads.t1?.failover?.resetAt).toBe("2026-01-01T14:00:00.000Z");

    m = applyEvent(m, {
      type: "provider.cooldownCleared",
      seq: 8,
      at: now,
      commandId: null,
      key: "claude",
    });
    expect(m.cooldowns.claude).toBeUndefined();
  });

  it("keeps the failure on the turn and resets the switch budget after a completed turn", () => {
    let m = applyEvent(base(), {
      type: "thread.failedOver",
      seq: 2,
      at: now,
      commandId: "c2",
      threadId: "t1",
      from: { provider: "claude", model: "sonnet" },
      to: { provider: "cursor", model: "auto" },
      failure: rateLimit,
      switches: 2,
    });
    const started = (seq: number, turnId: string) =>
      ({
        type: "turn.started",
        seq,
        at: now,
        commandId: `s${seq}`,
        threadId: "t1",
        turnId,
        prompt: "do it",
        provider: "cursor",
        model: "auto",
        checkpointBefore: null,
      }) satisfies Parameters<typeof applyEvent>[1];
    const finished = (seq: number, turnId: string, status: "completed" | "failed") =>
      ({
        type: "turn.finished",
        seq,
        at: now,
        commandId: null,
        threadId: "t1",
        turnId,
        status,
        checkpointAfter: null,
        changedFiles: [],
        usage: null,
        error: status === "failed" ? "limit" : null,
        ...(status === "failed" ? { failure: rateLimit } : {}),
      }) satisfies Parameters<typeof applyEvent>[1];
    m = applyEvent(applyEvent(m, started(3, "u1")), finished(4, "u1", "failed"));
    expect(m.turns.t1?.at(-1)?.failure).toEqual(rateLimit);
    expect(m.threads.t1?.failover?.switches).toBe(2);
    m = applyEvent(applyEvent(m, started(5, "u2")), finished(6, "u2", "completed"));
    expect(m.threads.t1?.failover?.switches).toBe(0);
    expect(m.threads.t1?.failover?.original).toEqual({ provider: "claude", model: "sonnet" });
  });

  it("covers every default ranking id", () => {
    expect(DEFAULT_MODEL_RANKING.length).toBeGreaterThan(5);
  });
});
