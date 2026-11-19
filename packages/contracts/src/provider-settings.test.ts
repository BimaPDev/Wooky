import { describe, expect, it } from "vitest";
import { DeviceSettings } from "./appearance.ts";
import { ModelTarget } from "./failover.ts";
import { ModelsSource, ProviderKind, ProviderStatus } from "./model.ts";
import { AcpAgentConfig, parseAcpModel, ProviderSettings } from "./provider-settings.ts";

const agent = {
  id: "gemini",
  name: "Gemini CLI",
  command: "gemini",
  enabled: true,
};

describe("DeviceSettings provider defaults", () => {
  it("fills an empty providers record and an empty ACP agent list", () => {
    const settings = DeviceSettings.parse({});
    expect(settings.providers).toEqual({});
    expect(settings.acpAgents).toEqual([]);
    expect(settings.disabledProviders).toEqual([]);
  });

  it("keeps a partial providers record and fills provider defaults", () => {
    const settings = DeviceSettings.parse({
      providers: { opencode: { binaryPath: "/usr/local/bin/opencode" } },
    });
    expect(settings.providers.opencode).toEqual({
      binaryPath: "/usr/local/bin/opencode",
      customModels: [],
      extraArgs: [],
      env: {},
    });
    expect(settings.providers.claude).toBeUndefined();
  });

  it("rejects an unknown provider key", () => {
    expect(DeviceSettings.safeParse({ providers: { nope: {} } }).success).toBe(false);
  });

  it("rejects duplicate ACP agent ids and more than 20 agents", () => {
    expect(
      DeviceSettings.safeParse({
        acpAgents: [agent, { ...agent, name: "Other" }],
      }).success,
    ).toBe(false);
    expect(
      DeviceSettings.safeParse({
        acpAgents: Array.from({ length: 21 }, (_, index) => ({
          ...agent,
          id: `agent-${index}`,
        })),
      }).success,
    ).toBe(false);
  });
});

describe("AcpAgentConfig", () => {
  it("defaults args and env and leaves models unset", () => {
    expect(AcpAgentConfig.parse(agent)).toEqual({
      ...agent,
      args: [],
      env: {},
    });
  });

  it("accepts a 32-character id, 40-character name and 200-character command", () => {
    const parsed = AcpAgentConfig.parse({
      ...agent,
      id: `a${"b".repeat(31)}`,
      name: "n".repeat(40),
      command: "c".repeat(200),
      args: ["--acp"],
      env: { GEMINI_API_KEY: "secret" },
      models: ["gemini-2.5-pro"],
    });
    expect(parsed.id).toHaveLength(32);
    expect(parsed.models).toEqual(["gemini-2.5-pro"]);
  });

  it("rejects a bad id, an empty name, a long command, and oversized lists", () => {
    expect(AcpAgentConfig.safeParse({ ...agent, id: "Gemini" }).success).toBe(false);
    expect(AcpAgentConfig.safeParse({ ...agent, id: "-gemini" }).success).toBe(false);
    expect(AcpAgentConfig.safeParse({ ...agent, id: `a${"b".repeat(32)}` }).success).toBe(false);
    expect(AcpAgentConfig.safeParse({ ...agent, name: "" }).success).toBe(false);
    expect(AcpAgentConfig.safeParse({ ...agent, name: "n".repeat(41) }).success).toBe(false);
    expect(AcpAgentConfig.safeParse({ ...agent, command: "" }).success).toBe(false);
    expect(AcpAgentConfig.safeParse({ ...agent, command: "c".repeat(201) }).success).toBe(false);
    expect(AcpAgentConfig.safeParse({ ...agent, enabled: "yes" }).success).toBe(false);
    expect(
      AcpAgentConfig.safeParse({ ...agent, args: Array.from({ length: 21 }, () => "-v") }).success,
    ).toBe(false);
    const env = Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`K${index}`, "v"]));
    expect(AcpAgentConfig.safeParse({ ...agent, env }).success).toBe(false);
    expect(AcpAgentConfig.safeParse({ ...agent, env: { "": "x" } }).success).toBe(false);
    expect(
      AcpAgentConfig.safeParse({
        ...agent,
        models: Array.from({ length: 51 }, (_, index) => `m${index}`),
      }).success,
    ).toBe(false);
  });
});

describe("ProviderSettings", () => {
  it("caps the binary path at 500 characters", () => {
    expect(ProviderSettings.parse({ binaryPath: "a".repeat(500) }).binaryPath).toHaveLength(500);
    expect(ProviderSettings.safeParse({ binaryPath: "" }).success).toBe(false);
    expect(ProviderSettings.safeParse({ binaryPath: "a".repeat(501) }).success).toBe(false);
    expect(
      ProviderSettings.safeParse({ customModels: Array.from({ length: 51 }, () => "m") }).success,
    ).toBe(false);
    expect(
      ProviderSettings.safeParse({ extraArgs: Array.from({ length: 21 }, () => "-v") }).success,
    ).toBe(false);
  });
});

describe("parseAcpModel", () => {
  it("reads an agent id, or an agent id and a model id", () => {
    expect(parseAcpModel("gemini")).toEqual({ agentId: "gemini" });
    expect(parseAcpModel("gemini/gemini-2.5-pro")).toEqual({
      agentId: "gemini",
      modelId: "gemini-2.5-pro",
    });
    expect(parseAcpModel("gemini/google/gemini-2.5-pro")).toEqual({
      agentId: "gemini",
      modelId: "google/gemini-2.5-pro",
    });
  });

  it("rejects a bad agent id, an empty model id, and a model id over 200 characters", () => {
    expect(parseAcpModel("")).toBeNull();
    expect(parseAcpModel("Gemini")).toBeNull();
    expect(parseAcpModel("-gemini")).toBeNull();
    expect(parseAcpModel("gemini/")).toBeNull();
    expect(parseAcpModel("/gemini-2.5-pro")).toBeNull();
    expect(parseAcpModel(`a${"b".repeat(32)}`)).toBeNull();
    expect(parseAcpModel(`ok/${"m".repeat(201)}`)).toBeNull();
    expect(parseAcpModel(`a${"b".repeat(31)}`)).toEqual({ agentId: `a${"b".repeat(31)}` });
  });
});

describe("ProviderStatus modelsSource", () => {
  const status = {
    kind: "opencode" as const,
    label: "OpenCode",
    installed: true,
    authenticated: null,
    version: null,
    models: [{ id: "opencode/big-pickle", label: "Big Pickle" }],
    problem: null,
  };

  it("stays optional so an older probe still parses", () => {
    expect(ProviderStatus.parse(status).modelsSource).toBeUndefined();
    expect(ModelsSource.parse("live")).toBe("live");
    const parsed = ProviderStatus.parse({
      ...status,
      modelsSource: "live",
      models: [{ id: "opencode/big-pickle", label: "Big Pickle", modelsSource: "custom" }],
    });
    expect(parsed.modelsSource).toBe("live");
    expect(parsed.models[0]?.modelsSource).toBe("custom");
    expect(ProviderStatus.safeParse({ ...status, modelsSource: "bundled" }).success).toBe(false);
  });
});

describe("ModelTarget", () => {
  it("uses the same provider kinds as ProviderKind", () => {
    expect(ModelTarget.shape.provider.options).toEqual(ProviderKind.options);
  });
});
