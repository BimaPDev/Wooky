import { describe, expect, it } from "vitest";
import type { ProviderLimits } from "@wooky/contracts";
import { createLimitsService } from "./limits.ts";

function row(
  provider: ProviderLimits["provider"],
  patch: Partial<ProviderLimits> = {},
): ProviderLimits {
  return {
    provider,
    available: true,
    plan: null,
    windows: [],
    checkedAt: "2026-11-17T12:00:00.000Z",
    problem: null,
    ...patch,
  };
}

describe("createLimitsService", () => {
  it("caches results within 60s and refresh bypasses the cache", async () => {
    let now = 1_000_000;
    let claudeCalls = 0;
    const service = createLimitsService({
      now: () => now,
      cacheTtlMs: 60_000,
      probes: {
        claude: async () => {
          claudeCalls += 1;
          return row("claude", {
            plan: `call-${claudeCalls}`,
            checkedAt: new Date(now).toISOString(),
          });
        },
        codex: async () => row("codex", { checkedAt: new Date(now).toISOString() }),
      },
    });

    const first = await service.get();
    const second = await service.get();
    expect(claudeCalls).toBe(1);
    expect(first.find((entry) => entry.provider === "claude")?.plan).toBe("call-1");
    expect(second.find((entry) => entry.provider === "claude")?.plan).toBe("call-1");

    now += 30_000;
    await service.get();
    expect(claudeCalls).toBe(1);

    const refreshed = await service.get({ refresh: true });
    expect(claudeCalls).toBe(2);
    expect(refreshed.find((entry) => entry.provider === "claude")?.plan).toBe("call-2");
  });

  it("turns a failing probe into available: false", async () => {
    const service = createLimitsService({
      now: () => 1_000_000,
      probes: {
        claude: async () => {
          throw new Error("claude cli missing");
        },
        codex: async () => row("codex"),
      },
    });

    const rows = await service.get();
    const claude = rows.find((entry) => entry.provider === "claude");
    expect(claude).toMatchObject({
      available: false,
      problem: "claude cli missing",
      windows: [],
    });
    expect(rows.find((entry) => entry.provider === "cursor")?.available).toBe(false);
    expect(rows.find((entry) => entry.provider === "demo")?.available).toBe(false);
  });

  it("merges a rate_limit_event into the matching Claude window", async () => {
    let now = 2_000_000;
    const service = createLimitsService({
      now: () => now,
      probes: {
        claude: async () =>
          row("claude", {
            windows: [
              {
                id: "five_hour",
                label: "5-hour",
                usedPercent: 20,
                resetsAt: "2026-11-17T18:00:00.000Z",
              },
            ],
          }),
        codex: async () => row("codex"),
      },
    });

    await service.get();
    now += 1_000;
    service.ingestClaudeRateLimit({
      status: "allowed",
      rateLimitType: "five_hour",
      utilization: 91,
      resetsAt: 1_764_111_111,
    });

    const rows = await service.get();
    expect(rows.find((entry) => entry.provider === "claude")?.windows).toEqual([
      {
        id: "five_hour",
        label: "5-hour",
        usedPercent: 91,
        resetsAt: new Date(1_764_111_111 * 1000).toISOString(),
      },
    ]);
  });
});
