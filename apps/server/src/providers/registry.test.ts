import { describe, expect, it } from "vitest";
import type { ProviderStatus } from "@wooky/contracts";
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

describe("provider registry settings", () => {
  const codex = (probe: () => Promise<ProviderStatus>): ProviderAdapter => ({
    kind: "codex",
    probe,
    runTurn: () => {
      throw new Error("not used");
    },
  });
  const codexStatus: ProviderStatus = {
    ...status,
    kind: "codex",
    label: "Codex",
    models: [{ id: "default", label: "Default" }],
    modelsSource: "static",
  };

  it("appends custom models to the probed list", async () => {
    const registry = createProviderRegistry([codex(async () => codexStatus)], {
      settings: () => ({ customModels: ["gpt-x", "default"], extraArgs: [], env: {} }),
    });
    const [listed] = await registry.list();
    expect(listed?.models).toEqual([
      { id: "default", label: "Default" },
      { id: "gpt-x", label: "gpt-x", modelsSource: "custom" },
    ]);
  });

  it("shows a clear problem and skips the probe when the binary path is invalid", async () => {
    let probed = 0;
    const registry = createProviderRegistry(
      [
        codex(async () => {
          probed += 1;
          return codexStatus;
        }),
      ],
      {
        settings: () => ({
          binaryPath: "relative/codex",
          customModels: ["gpt-x"],
          extraArgs: [],
          env: {},
        }),
      },
    );
    const [listed] = await registry.list();
    expect(probed).toBe(0);
    expect(listed).toMatchObject({
      kind: "codex",
      installed: false,
      problem: /Codex path must be absolute/,
      models: [{ id: "gpt-x", modelsSource: "custom" }],
    });
  });

  it("does not validate binaryPath for kinds it does not replace", async () => {
    const demo: ProviderAdapter = {
      kind: "demo",
      probe: async () => status,
      runTurn: () => {
        throw new Error("not used");
      },
    };
    const registry = createProviderRegistry([demo], {
      settings: () => ({ binaryPath: "nope", customModels: [], extraArgs: [], env: {} }),
    });
    expect(await registry.list()).toEqual([status]);
  });

  it("invalidate makes the next list probe again with the new settings", async () => {
    let probes = 0;
    let custom: string[] = [];
    const registry = createProviderRegistry(
      [
        codex(async () => {
          probes += 1;
          return codexStatus;
        }),
      ],
      { settings: () => ({ customModels: custom, extraArgs: [], env: {} }) },
    );
    expect((await registry.list())[0]?.models).toHaveLength(1);
    expect((await registry.list())[0]?.models).toHaveLength(1);
    expect(probes).toBe(1);

    custom = ["later"];
    registry.invalidate();
    expect((await registry.list())[0]?.models.map((model) => model.id)).toEqual([
      "default",
      "later",
    ]);
    expect(probes).toBe(2);
  });

  it("invalidate does not reuse a probe that started under the old settings", async () => {
    const resolvers: ((value: ProviderStatus) => void)[] = [];
    const registry = createProviderRegistry(
      [codex(() => new Promise<ProviderStatus>((resolve) => resolvers.push(resolve)))],
      { probeTimeoutMs: 1_000 },
    );
    const first = registry.list();
    registry.invalidate();
    const second = registry.list();
    expect(resolvers).toHaveLength(2);
    resolvers[0]?.(codexStatus);
    resolvers[1]?.(codexStatus);
    await Promise.all([first, second]);
  });
});
