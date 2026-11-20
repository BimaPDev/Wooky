import { describe, expect, it } from "vitest";
import {
  DeviceSettings,
  FailoverSettings,
  type ModelTarget,
  type ProviderStatus,
  type TurnFailure,
} from "@wooky/contracts";
import { emptyReadModel, handoffTranscript, pickFallback } from "@wooky/domain";
import { cooledDownIfNeeded } from "./cooldown.ts";
import { buildAvailable } from "./availability.ts";
import { failoverCommandId, maybeFailoverAfterTurn } from "./policy.ts";
import type { ProviderAdapter } from "../providers/types.ts";

const now = "2026-01-01T12:00:00.000Z";
const rateLimit: TurnFailure = { kind: "rate_limit", message: "slow" };

describe("failover review fixes", () => {
  it("enforces a 60s minimum cooldown for trigger failures", () => {
    const cooled = cooledDownIfNeeded(
      emptyReadModel(),
      { provider: "claude", model: "sonnet" },
      { kind: "rate_limit", message: "x", retryAfterMs: 0 },
      now,
    );
    expect(cooled?.until).toBe("2026-01-01T12:01:00.000Z");
  });

  it("treats authenticated null as usable when models are listed", () => {
    const statuses: ProviderStatus[] = [
      {
        kind: "codex",
        label: "Codex",
        installed: true,
        authenticated: null,
        version: null,
        models: [{ id: "gpt-6.1-sol", label: "Sol" }],
        problem: null,
      },
    ];
    const thread = {
      id: "t1",
      projectId: "p1",
      title: "T",
      provider: "claude" as const,
      model: "sonnet",
      runtimeMode: "full" as const,
      worktree: null,
      providerSessionId: null,
      ownerDeviceId: null,
      movedTo: null,
      movedFrom: null,
      pullRequest: null,
      status: "idle" as const,
      createdAt: now,
      updatedAt: now,
      queue: [],
    };
    const available = buildAvailable(statuses, { disabledProviders: [] }, thread);
    expect(available({ provider: "codex", model: "gpt-6.1-sol" })).toBe(true);
    expect(available({ provider: "codex", model: "missing" })).toBe(false);
  });

  it("skips codex for plan-mode threads", () => {
    const statuses: ProviderStatus[] = [
      {
        kind: "claude",
        label: "Claude",
        installed: true,
        authenticated: true,
        version: null,
        models: [{ id: "sonnet", label: "Sonnet" }],
        problem: null,
        capabilities: { planMode: true },
      },
      {
        kind: "codex",
        label: "Codex",
        installed: true,
        authenticated: true,
        version: null,
        models: [{ id: "gpt-6.1-sol", label: "Sol" }],
        problem: null,
        capabilities: { planMode: false },
      },
    ];
    const thread = {
      id: "t1",
      projectId: "p1",
      title: "T",
      provider: "claude" as const,
      model: "sonnet",
      runtimeMode: "full" as const,
      interactionMode: "plan" as const,
      worktree: null,
      providerSessionId: null,
      ownerDeviceId: null,
      movedTo: null,
      movedFrom: null,
      pullRequest: null,
      status: "idle" as const,
      createdAt: now,
      updatedAt: now,
      queue: [],
    };
    const available = buildAvailable(statuses, { disabledProviders: [] }, thread);
    expect(available({ provider: "codex", model: "gpt-6.1-sol" })).toBe(false);
  });

  it("includes trimmed tool output in failover handoff transcripts", () => {
    const model = {
      ...emptyReadModel(),
      threads: {
        t1: {
          id: "t1",
          projectId: "p1",
          title: "T",
          provider: "claude" as const,
          model: "sonnet",
          runtimeMode: "full" as const,
          worktree: null,
          providerSessionId: null,
          ownerDeviceId: null,
          movedTo: null,
          movedFrom: null,
          pullRequest: null,
          status: "idle" as const,
          createdAt: now,
          updatedAt: now,
          queue: [],
        },
      },
      turns: {
        t1: [
          {
            id: "u1",
            threadId: "t1",
            prompt: "run",
            provider: "claude" as const,
            model: "sonnet",
            status: "failed" as const,
            items: [
              {
                kind: "tool" as const,
                id: "tool-1",
                tool: "command" as const,
                title: "bash",
                name: "bash",
                status: "done" as const,
                output: "x".repeat(3_000),
              },
            ],
            startedAt: now,
            endedAt: now,
            checkpointBefore: null,
            checkpointAfter: null,
            changedFiles: [],
            usage: null,
            error: "rate",
          },
        ],
      },
    };
    const text = handoffTranscript(model, "t1", 50_000, { failoverToolOutput: true });
    expect(text).toContain("Tool bash:");
    expect(text.length).toBeLessThan(4_000);
  });

  it("aborts failover dispatch when the thread moved during probe", async () => {
    const status: ProviderStatus = {
      kind: "codex",
      label: "Codex",
      installed: true,
      authenticated: true,
      version: null,
      models: [{ id: "gpt-6.1-sol", label: "Sol" }],
      problem: null,
    };
    const adapter: ProviderAdapter = {
      kind: "codex",
      probe: async () => status,
      runTurn: async function* () {
        yield { type: "done", status: "completed", error: null };
      },
    };
    const model = {
      ...emptyReadModel(),
      projects: {
        p1: {
          id: "p1",
          name: "p",
          root: "/p",
          createdAt: now,
          settings: { scripts: [], sharedPaths: [], prompts: [] },
        },
      },
      threads: {
        t1: {
          id: "t1",
          projectId: "p1",
          title: "T",
          provider: "codex" as const,
          model: "gpt-6.1-sol",
          runtimeMode: "full" as const,
          worktree: null,
          providerSessionId: null,
          ownerDeviceId: null,
          movedTo: null,
          movedFrom: null,
          pullRequest: null,
          status: "idle" as const,
          createdAt: now,
          updatedAt: now,
          queue: [],
        },
      },
      turns: {
        t1: [
          {
            id: "u1",
            threadId: "t1",
            prompt: "hi",
            provider: "claude" as const,
            model: "sonnet",
            status: "failed" as const,
            items: [],
            startedAt: now,
            endedAt: now,
            checkpointBefore: null,
            checkpointAfter: null,
            changedFiles: [],
            usage: null,
            error: "rate",
          },
        ],
      },
    };
    const cooled: unknown[] = [];
    await maybeFailoverAfterTurn({
      model,
      finished: {
        type: "turn.finished",
        seq: 2,
        at: now,
        commandId: null,
        threadId: "t1",
        turnId: "u1",
        status: "failed",
        checkpointAfter: null,
        changedFiles: [],
        usage: null,
        error: "rate",
        failure: rateLimit,
      },
      settings: DeviceSettings.parse({
        failover: FailoverSettings.parse({
          chain: [{ provider: "codex", model: "gpt-6.1-sol" }],
        }),
      }),
      providers: {
        get: (kind) => (kind === "codex" ? adapter : null),
        list: async () => [status],
        invalidate: () => undefined,
      },
      dispatch: () => {
        throw new Error("should not dispatch");
      },
      recordCooldown: (events) => {
        cooled.push(...events);
      },
      now,
      readModel: () => model,
    });
    expect(cooled.some((event) => (event as { type: string }).type === "provider.cooledDown")).toBe(
      true,
    );
  });

  it("uses deterministic failover command ids", () => {
    expect(failoverCommandId("turn-9")).toBe("failover:turn-9");
  });

  it("never picks a sibling model for account-scoped failures", () => {
    const always = (target: ModelTarget) =>
      target.provider === "claude" || target.provider === "codex";
    const picked = pickFallback({
      readModel: emptyReadModel(),
      thread: {
        id: "t1",
        projectId: "p1",
        title: "T",
        provider: "claude",
        model: "sonnet",
        runtimeMode: "full",
        worktree: null,
        providerSessionId: null,
        ownerDeviceId: null,
        movedTo: null,
        movedFrom: null,
        pullRequest: null,
        status: "idle",
        createdAt: now,
        updatedAt: now,
        queue: [],
      },
      chain: [{ provider: "claude", model: "haiku" }],
      now,
      available: always,
      failure: rateLimit,
    });
    expect(picked).toBeNull();
  });
});
