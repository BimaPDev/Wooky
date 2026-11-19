import type {
  DeviceSettings,
  EffortLevel,
  ModelTarget,
  ProviderKind,
  ProviderStatus,
} from "@age/contracts";
import { isAvailable } from "../components/labels.ts";
import { pickerModels } from "../components/providers/helpers.ts";

const SMALL_WORDS = new Set(["gpt", "ai"]);

function titleWord(word: string): string {
  if (SMALL_WORDS.has(word)) return word.toUpperCase();
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** `[1m]` and similar context suffixes, shown as a trailing "1M". */
function splitContextSuffix(id: string): { base: string; suffix: string } {
  const match = /^(.*?)\[(\w+)\]$/.exec(id);
  return match?.[1]
    ? { base: match[1], suffix: match[2]?.toUpperCase() ?? "" }
    : { base: id, suffix: "" };
}

/**
 * Short, human name for a model id: `claude-opus-5-5` → "Opus 5.5", `opus[1m]` → "Opus 1M",
 * `gpt-5.5-codex` → "GPT 5.5 codex". Date stamps (`-20250929`) and the `claude-` prefix are dropped.
 */
export function shortModelName(id: string): string {
  const { base, suffix } = splitContextSuffix(id.trim());
  const name = base.includes("/") ? (base.split("/").at(-1) ?? base) : base;
  const parts = name
    .replace(/^claude-/, "")
    .split(/[-_\s]+/)
    .filter((part) => part !== "" && !/^\d{8}$/.test(part));
  const words: string[] = [];
  for (const part of parts) {
    const last = words.at(-1);
    if (/^\d+$/.test(part) && last !== undefined && /^\d+(\.\d+)*$/.test(last)) {
      words[words.length - 1] = `${last}.${part}`;
    } else words.push(/^\d/.test(part) ? part : titleWord(part));
  }
  const joined = words.join(" ");
  const out = suffix ? `${joined} ${suffix}` : joined;
  return out || id;
}

const isAlias = (id: string) => /^[a-z]+(\[\w+\])?$/.test(id);

function modelEntry(status: Pick<ProviderStatus, "models"> | undefined, id: string) {
  return status?.models.find((entry) => entry.id === id);
}

/** A label like "Default (recommended)" without the parenthesised hint. */
function plainLabel(label: string): string {
  return label.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

/**
 * What the model chip shows. An alias such as "default" or "opus" shows the model it maps to when
 * the provider status says so; "default" without that answer shows "Default".
 */
export function chipModelName(
  status: Pick<ProviderStatus, "models"> | undefined,
  modelId: string,
): string {
  const entry = modelEntry(status, modelId);
  if (entry?.resolvedModel) return shortModelName(entry.resolvedModel);
  if (modelId === "default") return "Default";
  if (isAlias(modelId) && !modelId.includes("[")) return shortModelName(modelId);
  const label = entry ? plainLabel(entry.label) : "";
  if (label && label.toLowerCase() !== modelId.toLowerCase() && label.length <= 28) return label;
  return shortModelName(modelId);
}

/** The status row that answers for this model: its own, or the one its alias resolves to. */
function effortSource(status: Pick<ProviderStatus, "models"> | undefined, modelId: string) {
  const entry = modelEntry(status, modelId);
  if (entry?.efforts?.length) return entry;
  const resolved = entry?.resolvedModel;
  return resolved ? modelEntry(status, resolved) : undefined;
}

/** Effort levels the model accepts. Empty when it has no effort setting. */
export function effortsFor(
  status: Pick<ProviderStatus, "models"> | undefined,
  modelId: string,
): EffortLevel[] {
  return effortSource(status, modelId)?.efforts ?? [];
}

export const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export const effortLabel = (level: EffortLevel) => EFFORT_LABELS[level];

/** Opus 5.5 starts on medium; every other model keeps its own default (no value sent). */
export function defaultEffortFor(
  status: Pick<ProviderStatus, "models"> | undefined,
  modelId: string,
): EffortLevel | undefined {
  if (effortsFor(status, modelId).length === 0) return undefined;
  const resolved = modelEntry(status, modelId)?.resolvedModel ?? modelId;
  return /opus-5-5/.test(resolved) ? "medium" : undefined;
}

/** The effort the chip shows: the pick when this model accepts it, else the model's default, else none. */
export function shownEffort(
  status: Pick<ProviderStatus, "models"> | undefined,
  modelId: string,
  picked: EffortLevel | undefined,
): EffortLevel | undefined {
  const accepted = effortsFor(status, modelId);
  if (accepted.length === 0) return undefined;
  if (picked && accepted.includes(picked)) return picked;
  return defaultEffortFor(status, modelId);
}

export const PROVIDER_SHORT_NAMES: Record<ProviderKind, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
  acp: "ACP",
  demo: "Demo",
};

/**
 * The providers the picker's tab row offers: usable now (installed, not signed out, enabled, and
 * with at least one model listed). Demo counts only when `showDemo` is set, or when nothing else
 * is usable. The provider a thread is already on stays, so its current model is never hidden.
 */
export function pickerProviders(
  providers: readonly ProviderStatus[],
  disabled: ReadonlySet<ProviderKind>,
  settings: Pick<DeviceSettings, "providers" | "acpAgents"> | null,
  options: { showDemo: boolean; current: ProviderKind },
): ProviderStatus[] {
  const usable = (entry: ProviderStatus) =>
    isAvailable(entry, disabled) && pickerModels(entry, settings).length > 0;
  const others = providers.filter((entry) => entry.kind !== "demo" && usable(entry));
  return providers.filter((entry) => {
    if (entry.kind === options.current) return true;
    if (entry.kind === "demo") {
      return usable(entry) && (options.showDemo || others.length === 0);
    }
    return usable(entry);
  });
}

/** The model row's full display name: Claude's own models carry the family prefix. */
export function fullModelName(kind: ProviderKind, label: string, id: string): string {
  const plain = label.trim() || id;
  if (kind !== "claude" || id === "default" || /^claude\b/i.test(plain)) return plain;
  return `Claude ${plain}`;
}

/** Whether the model, or the model its alias maps to, has the flag (fast mode, ultracode). */
export function modelHasFlag(
  status: Pick<ProviderStatus, "models"> | undefined,
  modelId: string,
  flag: "fastMode" | "ultracode",
): boolean {
  const entry = status?.models.find((model) => model.id === modelId);
  if (entry?.[flag]) return true;
  const resolved = entry?.resolvedModel;
  return resolved ? status?.models.find((model) => model.id === resolved)?.[flag] === true : false;
}

export const MAX_FAVORITE_MODELS = 30;

export const isFavoriteModel = (
  favorites: readonly ModelTarget[],
  provider: ProviderKind,
  model: string,
) => favorites.some((entry) => entry.provider === provider && entry.model === model);

/** Add the model to the favourites, or remove it. A full list takes no more. */
export function toggleFavoriteModel(
  favorites: readonly ModelTarget[],
  target: ModelTarget,
): ModelTarget[] {
  if (isFavoriteModel(favorites, target.provider, target.model)) {
    return favorites.filter(
      (entry) => !(entry.provider === target.provider && entry.model === target.model),
    );
  }
  if (favorites.length >= MAX_FAVORITE_MODELS) return [...favorites];
  return [...favorites, target];
}

export interface PickerRow {
  provider: ProviderKind;
  id: string;
  label: string;
  isDefault: boolean;
}

/** The rows of one provider's tab. */
export function providerRows(
  status: ProviderStatus,
  settings: Pick<DeviceSettings, "providers" | "acpAgents"> | null,
): PickerRow[] {
  return pickerModels(status, settings).map((model) => ({
    provider: status.kind,
    id: model.id,
    label: fullModelName(status.kind, model.label, model.id),
    isDefault: model.isDefault,
  }));
}

/** The rows of the Favorites tab: starred models across the providers that can be used now. */
export function favoriteRows(
  favorites: readonly ModelTarget[],
  visible: readonly ProviderStatus[],
  settings: Pick<DeviceSettings, "providers" | "acpAgents"> | null,
): PickerRow[] {
  const rows: PickerRow[] = [];
  for (const favorite of favorites) {
    const status = visible.find((entry) => entry.kind === favorite.provider);
    if (!status) continue;
    const row = providerRows(status, settings).find((entry) => entry.id === favorite.model);
    rows.push(
      row ?? {
        provider: favorite.provider,
        id: favorite.model,
        label: fullModelName(favorite.provider, favorite.model, favorite.model),
        isDefault: false,
      },
    );
  }
  return rows;
}
