import { describe, expect, it } from "vitest";
import type { ProviderStatus } from "@age/contracts";
import { createProviderRegistry } from "./registry.ts";
import type { ProviderAdapter } from "./types.ts";

const status: ProviderStatus = {
  kind: "demo",
  label: "Demo",
  installed: true,
  authenticated: true,
  version: "1",
  models: [],
  problem: null,
};

describe("provider registry", () => {
  it("does not stack probes while an earlier one is still unsettled", async () => {
    const probes: ((value: ProviderStatus) => void)[] = [];
    const settled: Promise<ProviderStatus>[] = [];
    const adapter: ProviderAdapter = {
      kind: "demo",
      probe() {
        const probe = new Promise<ProviderStatus>((resolve) => probes.push(resolve));
        settled.push(probe);
        return probe;
      },
      runTurn: () => {
        throw new Error("not used");
      },
    };
    const registry = createProviderRegistry([adapter], { probeTimeoutMs: 1, cacheMs: -1 });

    expect(await registry.list()).toMatchObject([{ installed: false, problem: /in time/ }]);
    expect(await registry.list()).toMatchObject([{ installed: false, problem: /in time/ }]);
    expect(probes).toHaveLength(1);

    probes[0]?.(status);
    await settled[0];
    const next = registry.list();
    expect(probes).toHaveLength(2);
    probes[1]?.(status);
    expect(await next).toEqual([status]);
  });

  it("reports a probe that throws synchronously", async () => {
    const adapter: ProviderAdapter = {
      kind: "demo",
      probe: () => {
        throw new Error("boom");
      },
      runTurn: () => {
        throw new Error("not used");
      },
    };
    const registry = createProviderRegistry([adapter]);
    expect(await registry.list()).toMatchObject([{ installed: false, problem: /boom/ }]);
  });
});
