import { describe, expect, it } from "vitest";
import type { DeviceSettings, ProviderStatus } from "@wooky/contracts";
import {
  AGENT_PRESETS,
  agentFromPreset,
  agentProblem,
  checkNewModelId,
  defaultModelFor,
  emptyProviderSettings,
  envKeyProblem,
  envToRows,
  groupModels,
  listToRows,
  nextRowId,
  pickerModels,
  removeRow,
  rowsToEnv,
  rowsToList,
  slugify,
  uniqueSlug,
  updateProviderSettings,
} from "./helpers.ts";

const status = (
  models: ProviderStatus["models"],
  modelsSource?: ProviderStatus["modelsSource"],
) => ({
  kind: "claude" as const,
  models,
  ...(modelsSource ? { modelsSource } : {}),
});

describe("groupModels", () => {
  it("groups by source in a fixed order and omits empty groups", () => {
    const groups = groupModels(
      status(
        [
          { id: "a", label: "A" },
          { id: "b", label: "B", modelsSource: "static" },
        ],
        "live",
      ),
      ["mine"],
    );
    expect(groups.map((group) => [group.title, group.models.map((model) => model.id)])).toEqual([
      ["Reported by the CLI", ["a"]],
      ["Built in", ["b"]],
      ["Added by you", ["mine"]],
    ]);
  });

  it("counts a model with no source anywhere as built in", () => {
    expect(groupModels(status([{ id: "x", label: "X" }]), [])).toEqual([
      { source: "static", title: "Built in", models: [{ id: "x", label: "X" }] },
    ]);
  });

  it("takes custom chips from settings, not from the probe, and drops duplicates", () => {
    const groups = groupModels(
      status([{ id: "old", label: "old", modelsSource: "custom" }], "live"),
      ["new", "new"],
    );
    expect(groups).toEqual([
      { source: "custom", title: "Added by you", models: [{ id: "new", label: "new" }] },
    ]);
  });

  it("returns nothing without a status or custom models", () => {
    expect(groupModels(undefined, [])).toEqual([]);
  });
});

describe("checkNewModelId", () => {
  it("trims and accepts a fresh id", () => {
    expect(checkNewModelId("  gpt-x ", ["a"], [])).toEqual({ ok: true, id: "gpt-x" });
  });

  it("rejects blank, long, duplicate and too many", () => {
    expect(checkNewModelId("  ", [], [])).toMatchObject({ ok: false });
    expect(checkNewModelId("x".repeat(201), [], [])).toMatchObject({ ok: false });
    expect(checkNewModelId("a", ["a"], [])).toMatchObject({ ok: false, message: /already listed/ });
    expect(checkNewModelId("a", [], ["a"])).toMatchObject({ ok: false, message: /already added/ });
    const full = Array.from({ length: 50 }, (_, i) => `m${i}`);
    expect(checkNewModelId("new", [], full)).toMatchObject({ ok: false, message: /At most 50/ });
  });
});

describe("updateProviderSettings", () => {
  it("sets fields, trims text and keeps other providers", () => {
    const base = { codex: { ...emptyProviderSettings(), defaultModel: "keep" } };
    const next = updateProviderSettings(base, "claude", {
      binaryPath: "  /opt/claude ",
      customModels: ["m"],
    });
    expect(next).toEqual({
      codex: { customModels: [], extraArgs: [], env: {}, defaultModel: "keep" },
      claude: { customModels: ["m"], extraArgs: [], env: {}, binaryPath: "/opt/claude" },
    });
  });

  it("drops blank or undefined optional fields and removes a provider left empty", () => {
    const set = updateProviderSettings({}, "cursor", { binaryPath: "/x" });
    expect(updateProviderSettings(set, "cursor", { binaryPath: "   " })).toEqual({});
    expect(updateProviderSettings(set, "cursor", { binaryPath: undefined })).toEqual({});
  });
});

describe("slugify and uniqueSlug", () => {
  it("makes a valid agent id from a name", () => {
    expect(slugify("Gemini CLI")).toBe("gemini-cli");
    expect(slugify("  Kiro!! (beta) ")).toBe("kiro-beta");
    expect(slugify("Café Ünï")).toBe("cafe-uni");
    expect(slugify("日本語")).toBe("");
    expect(slugify("-a-")).toBe("a");
  });

  it("never exceeds 32 characters or ends on a hyphen", () => {
    const slug = slugify(`${"a".repeat(31)} bbbb`);
    expect(slug.length).toBeLessThanOrEqual(32);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("finds a free id", () => {
    expect(uniqueSlug("goose", new Set())).toBe("goose");
    expect(uniqueSlug("goose", new Set(["goose", "goose-2"]))).toBe("goose-3");
    expect(uniqueSlug("", new Set())).toBe("agent");
    const long = "a".repeat(32);
    const next = uniqueSlug(long, new Set([long]));
    expect(next).toBe(`${"a".repeat(30)}-2`);
    expect(next).toHaveLength(32);
  });
});

describe("agentProblem", () => {
  const ok = { id: "gemini", name: "Gemini", command: "gemini" };
  it("accepts a valid agent", () => {
    expect(agentProblem(ok, new Set())).toBeNull();
  });
  it("names what is wrong", () => {
    expect(agentProblem({ ...ok, name: " " }, new Set())).toMatch(/name/);
    expect(agentProblem({ ...ok, id: "Bad Id" }, new Set())).toMatch(/id/);
    expect(agentProblem({ ...ok, id: "" }, new Set())).toMatch(/id/);
    expect(agentProblem(ok, new Set(["gemini"]))).toMatch(/already uses/);
    expect(agentProblem({ ...ok, command: "" }, new Set())).toMatch(/command/);
  });
});

describe("presets", () => {
  it("carries the commands the providers doc lists", () => {
    expect(AGENT_PRESETS.map((p) => [p.command, ...p.args].join(" "))).toEqual([
      "gemini --experimental-acp",
      "goose acp",
      "kiro-cli acp",
      "opencode acp",
    ]);
  });

  it("builds an enabled agent with a free id and its own args array", () => {
    const preset = AGENT_PRESETS[0] ?? { id: "", name: "", command: "", args: [] };
    const agent = agentFromPreset(preset, new Set(["gemini"]));
    expect(agent).toMatchObject({ id: "gemini-2", name: "Gemini CLI", enabled: true, env: {} });
    expect(agent.args).toEqual(preset.args);
    expect(agent.args).not.toBe(preset.args);
    expect(agentProblem(agent, new Set(["gemini"]))).toBeNull();
  });
});

describe("env rows", () => {
  it("round-trips the record and ignores keyless rows", () => {
    const rows = envToRows({ A: "1", B: "2" });
    expect(rows).toEqual([
      { id: 1, key: "A", value: "1" },
      { id: 2, key: "B", value: "2" },
    ]);
    expect(
      rowsToEnv([...rows, { id: 3, key: "  ", value: "x" }, { id: 4, key: "A", value: "9" }]),
    ).toEqual({
      A: "9",
      B: "2",
    });
  });

  it("flags names the OS cannot use and duplicates", () => {
    const rows = [
      { id: 1, key: "A", value: "" },
      { id: 2, key: "A", value: "" },
      { id: 3, key: "B C", value: "" },
    ];
    expect(envKeyProblem("A", rows)).toBe("Duplicate name.");
    expect(envKeyProblem("B C", rows)).toMatch(/spaces/);
    expect(envKeyProblem("X=1", rows)).toMatch(/spaces/);
    expect(envKeyProblem("", rows)).toBeNull();
    expect(envKeyProblem("OK", rows)).toBeNull();
  });
});

describe("list editors", () => {
  it("keeps blank rows for typing but saves only non-blank values, in order", () => {
    const rows = [...listToRows(["--a", "b"]), { id: 3, value: "  " }, { id: 4, value: "c" }];
    expect(rowsToList(rows)).toEqual(["--a", "b", "c"]);
  });

  it("hands out fresh ids and removes by id", () => {
    const rows = listToRows(["x", "y", "z"]);
    expect(nextRowId(rows)).toBe(4);
    expect(nextRowId([])).toBe(1);
    const left = removeRow(rows, 2);
    expect(left.map((row) => row.value)).toEqual(["x", "z"]);
    expect(nextRowId(left)).toBe(4);
  });
});

const settings = (partial: Partial<DeviceSettings>) =>
  ({ providers: {}, acpAgents: [], ...partial }) as Pick<DeviceSettings, "providers" | "acpAgents">;

const agent = (id: string, name: string, enabled: boolean, models?: string[]) => ({
  id,
  name,
  command: id,
  args: [],
  env: {},
  enabled,
  ...(models ? { models } : {}),
});

describe("pickerModels and defaultModelFor", () => {
  it("appends the user's custom ids, marks the default and dedupes", () => {
    const list = pickerModels(
      status([{ id: "default", label: "Default" }]),
      settings({
        providers: {
          claude: {
            ...emptyProviderSettings(),
            customModels: ["mine", "default"],
            defaultModel: "mine",
          },
        },
      }),
    );
    expect(list).toEqual([
      { id: "default", label: "Default", isDefault: false },
      { id: "mine", label: "mine", isDefault: true },
    ]);
  });

  it("lists enabled ACP agents and their models in thread form, grouped by agent", () => {
    const list = pickerModels(
      { kind: "acp", models: [] },
      settings({
        acpAgents: [
          agent("gemini", "Gemini CLI", true, ["google/pro", "flash"]),
          agent("off", "Off", false),
        ],
        providers: { acp: { ...emptyProviderSettings(), defaultModel: "gemini/flash" } },
      }),
    );
    expect(list.map((model) => [model.id, model.label, model.group, model.isDefault])).toEqual([
      ["gemini", "Gemini CLI", "Gemini CLI", false],
      ["gemini/google/pro", "google/pro", "Gemini CLI", false],
      ["gemini/flash", "flash", "Gemini CLI", true],
    ]);
  });

  it("starts a new thread on the default, else the first listed model", () => {
    const s = status([
      { id: "default", label: "Default" },
      { id: "opus", label: "Opus" },
    ]);
    expect(defaultModelFor(s, null)).toBe("default");
    expect(defaultModelFor(s, settings({}))).toBe("default");
    expect(
      defaultModelFor(
        s,
        settings({ providers: { claude: { ...emptyProviderSettings(), defaultModel: "opus" } } }),
      ),
    ).toBe("opus");
    expect(
      defaultModelFor(
        s,
        settings({ providers: { claude: { ...emptyProviderSettings(), defaultModel: "gone" } } }),
      ),
    ).toBe("default");
    expect(defaultModelFor(undefined, null)).toBe("");
    expect(defaultModelFor({ kind: "codex", models: [] }, null)).toBe("");
  });
});
