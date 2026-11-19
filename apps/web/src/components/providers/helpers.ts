import type {
  AcpAgentConfig,
  DeviceSettings,
  ModelsSource,
  ProviderKind,
  ProviderSettings,
  ProviderStatus,
} from "@wooky/contracts";

/** Limits from `ProviderSettings` and `AcpAgentConfig`. The server rejects anything above them. */
export const LIMITS = {
  models: 50,
  modelId: 200,
  args: 20,
  arg: 4096,
  env: 20,
  envValue: 16_384,
  binaryPath: 500,
  agents: 20,
  agentName: 40,
  agentId: 32,
  command: 200,
} as const;

export type ModelChip = { id: string; label: string };

export type ModelGroup = { source: ModelsSource; title: string; models: ModelChip[] };

const GROUP_TITLES: Record<ModelsSource, string> = {
  live: "Reported by the CLI",
  static: "Built in",
  custom: "Added by you",
};

const GROUP_ORDER: ModelsSource[] = ["live", "static", "custom"];

/**
 * Group a provider's models by where the id came from. A model's own source wins over the
 * provider's; with neither it counts as built in. The user's own ids come from their settings,
 * not the probe, so a model they just added shows before the next refresh. Empty groups are omitted.
 */
export function groupModels(
  status: Pick<ProviderStatus, "models" | "modelsSource"> | undefined,
  customModels: readonly string[],
): ModelGroup[] {
  const buckets: Record<ModelsSource, ModelChip[]> = { live: [], static: [], custom: [] };
  for (const model of status?.models ?? []) {
    const source = model.modelsSource ?? status?.modelsSource ?? "static";
    if (source === "custom") continue;
    buckets[source].push({ id: model.id, label: model.label });
  }
  const seen = new Set<string>();
  for (const id of customModels) {
    if (seen.has(id)) continue;
    seen.add(id);
    buckets.custom.push({ id, label: id });
  }
  return GROUP_ORDER.filter((source) => buckets[source].length > 0).map((source) => ({
    source,
    title: GROUP_TITLES[source],
    models: buckets[source],
  }));
}

export type ModelIdCheck = { ok: true; id: string } | { ok: false; message: string };

/** Whether a typed model id can be added next to the ones already listed. */
export function checkNewModelId(
  raw: string,
  existing: readonly string[],
  custom: readonly string[],
): ModelIdCheck {
  const id = raw.trim();
  if (id === "") return { ok: false, message: "Type a model id." };
  if (id.length > LIMITS.modelId) {
    return { ok: false, message: `Model ids are at most ${LIMITS.modelId} characters.` };
  }
  if (custom.includes(id)) return { ok: false, message: "You already added this model." };
  if (existing.includes(id)) return { ok: false, message: "This model is already listed." };
  if (custom.length >= LIMITS.models) {
    return { ok: false, message: `At most ${LIMITS.models} custom models.` };
  }
  return { ok: true, id };
}

export const emptyProviderSettings = (): ProviderSettings => ({
  customModels: [],
  extraArgs: [],
  env: {},
});

const isEmptySettings = (settings: ProviderSettings) =>
  settings.binaryPath === undefined &&
  settings.defaultModel === undefined &&
  settings.customModels.length === 0 &&
  settings.extraArgs.length === 0 &&
  Object.keys(settings.env).length === 0;

/**
 * Replace one provider's settings in the whole record. Fields set to `undefined` or blank are
 * dropped, and a provider left with nothing set is removed so the file stays small.
 */
export function updateProviderSettings(
  record: DeviceSettings["providers"],
  kind: ProviderKind,
  patch: Partial<ProviderSettings>,
): DeviceSettings["providers"] {
  const merged = { ...(record[kind] ?? emptyProviderSettings()), ...patch };
  const binaryPath = merged.binaryPath?.trim();
  const defaultModel = merged.defaultModel?.trim();
  const { binaryPath: _b, defaultModel: _d, ...rest } = merged;
  const next: ProviderSettings = {
    ...rest,
    ...(binaryPath ? { binaryPath } : {}),
    ...(defaultModel ? { defaultModel } : {}),
  };
  const { [kind]: _removed, ...others } = record;
  return isEmptySettings(next) ? others : { ...others, [kind]: next };
}

/** Lowercase letters, digits and single hyphens. Empty when the name has none of them. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, LIMITS.agentId)
    .replace(/-+$/, "");
  return slug;
}

/** `base`, or `base-2`, `base-3`... the first one not in `taken`, within the id length limit. */
export function uniqueSlug(base: string, taken: ReadonlySet<string>): string {
  const root = base === "" ? "agent" : base;
  if (!taken.has(root)) return root;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${root.slice(0, LIMITS.agentId - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** What is wrong with an agent draft, or null when it can be saved. */
export function agentProblem(
  agent: Pick<AcpAgentConfig, "id" | "name" | "command">,
  otherIds: ReadonlySet<string>,
): string | null {
  if (agent.name.trim() === "") return "Give the agent a name.";
  if (agent.name.length > LIMITS.agentName) {
    return `Names are at most ${LIMITS.agentName} characters.`;
  }
  if (!AGENT_ID_PATTERN.test(agent.id)) {
    return "The id uses lowercase letters, digits and hyphens, and starts with a letter or digit.";
  }
  if (otherIds.has(agent.id)) return "Another agent already uses this id.";
  if (agent.command.trim() === "") return "Enter the command that starts the agent.";
  return null;
}

export type AgentPreset = {
  id: string;
  name: string;
  command: string;
  args: string[];
};

/** One-click templates. The flags change between releases, so the UI tells people to check the docs. */
export const AGENT_PRESETS: readonly AgentPreset[] = [
  { id: "gemini", name: "Gemini CLI", command: "gemini", args: ["--experimental-acp"] },
  { id: "goose", name: "Goose", command: "goose", args: ["acp"] },
  { id: "kiro", name: "Kiro", command: "kiro-cli", args: ["acp"] },
  { id: "opencode", name: "OpenCode (ACP)", command: "opencode", args: ["acp"] },
];

/** A new agent from a preset, with an id that does not collide with `taken`. */
export function agentFromPreset(preset: AgentPreset, taken: ReadonlySet<string>): AcpAgentConfig {
  return {
    id: uniqueSlug(preset.id, taken),
    name: preset.name,
    command: preset.command,
    args: [...preset.args],
    env: {},
    enabled: true,
  };
}

export type EnvRow = { id: number; key: string; value: string };

export function envToRows(env: Readonly<Record<string, string>>, firstId = 1): EnvRow[] {
  return Object.entries(env).map(([key, value], index) => ({ id: firstId + index, key, value }));
}

/** Rows with a key become the record. A later row wins over an earlier one with the same key. */
export function rowsToEnv(rows: readonly EnvRow[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key !== "") env[key] = row.value;
  }
  return env;
}

/** Names the shell and the OS treat as one word. Not enforced by the server, so this only warns. */
export function envKeyProblem(key: string, rows: readonly EnvRow[]): string | null {
  const trimmed = key.trim();
  if (trimmed === "") return null;
  if (/[=\s]/.test(trimmed)) return "A name cannot contain spaces or =.";
  if (rows.filter((row) => row.key.trim() === trimmed).length > 1) return "Duplicate name.";
  return null;
}

export type ListRow = { id: number; value: string };

export const listToRows = (list: readonly string[], firstId = 1): ListRow[] =>
  list.map((value, index) => ({ id: firstId + index, value }));

/** Non-blank rows only, in order. Blank rows are for typing and never reach settings. */
export const rowsToList = (rows: readonly ListRow[]): string[] =>
  rows.filter((row) => row.value.trim() !== "").map((row) => row.value);

export const removeRow = <T extends { id: number }>(rows: readonly T[], id: number): T[] =>
  rows.filter((row) => row.id !== id);

export const nextRowId = (rows: readonly { id: number }[]): number =>
  rows.reduce((max, row) => Math.max(max, row.id), 0) + 1;

export type PickerModel = {
  id: string;
  label: string;
  isDefault: boolean;
  /** Set for ACP agents: the agent's name, so rows can sit under a heading. */
  group?: string;
};

/**
 * Models the picker offers for one provider, in order: what the provider reported, then the
 * user's own ids. For `acp`, each enabled agent is a row of its own (`<agentId>`), followed by
 * its listed models (`<agentId>/<modelId>`). The default is the id in `providers[kind].defaultModel`.
 */
export function pickerModels(
  status: Pick<ProviderStatus, "kind" | "models"> | undefined,
  settings: Pick<DeviceSettings, "providers" | "acpAgents"> | null,
): PickerModel[] {
  const kind = status?.kind;
  const own = kind ? settings?.providers[kind] : undefined;
  const defaultId = own?.defaultModel;
  const out: PickerModel[] = [];
  const seen = new Set<string>();
  const add = (id: string, label: string, group?: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, label, isDefault: id === defaultId, ...(group ? { group } : {}) });
  };
  if (kind === "acp") {
    for (const agent of settings?.acpAgents ?? []) {
      if (!agent.enabled) continue;
      add(agent.id, agent.name, agent.name);
      for (const modelId of agent.models ?? []) add(`${agent.id}/${modelId}`, modelId, agent.name);
    }
  }
  for (const model of status?.models ?? []) add(model.id, model.label);
  for (const id of own?.customModels ?? []) add(id, id);
  return out;
}

/**
 * The model a new thread starts on when `kind` is picked: the user's default for that provider
 * when it is still listed, else the first model listed.
 */
export function defaultModelFor(
  status: Pick<ProviderStatus, "kind" | "models"> | undefined,
  settings: Pick<DeviceSettings, "providers" | "acpAgents"> | null,
): string {
  const listed = pickerModels(status, settings);
  return listed.find((model) => model.isDefault)?.id ?? listed[0]?.id ?? "";
}
