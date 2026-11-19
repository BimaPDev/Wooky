import type { EffortLevel, ProviderStatus } from "@age/contracts";

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
