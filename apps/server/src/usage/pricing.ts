import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, stat as statFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { UsageHistoryPricing } from "@wooky/contracts";
import { z } from "zod";
import { parseJsonSafely } from "./safe-input.ts";

/** USD per token. Cache rates fall back to `input` when the table has none. */
export interface ModelRate {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** 1-hour cache writes. Falls back to 2× input, then `cacheWrite`. */
  cacheWrite1h?: number;
  /**
   * Higher rates once prompt tokens (uncached + cache read + cache write)
   * exceed the threshold. Highest matching threshold wins. LiteLLM encodes
   * these as `input_cost_per_token_above_Nk_tokens`.
   */
  contextTiers?: readonly ContextTier[];
}

export interface ContextTier {
  thresholdTokens: number;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
}

/** Keyed by `normalizeModelId`. Plain data, so it can cross to the worker. */
export type RateTable = Record<string, ModelRate>;

export interface Priced {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** Reported cost the rates could not explain. */
  other: number;
  savings: number;
  /** False when the model has no rate and the agent reported no cost. */
  priced: boolean;
}

export type Pricer = (
  model: string,
  inputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
  outputTokens: number,
  reportedCostUsd: number | undefined,
  cacheWrite1hTokens?: number,
) => Priced;

const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const RATES_FILE = "usage-model-rates.json";
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;

/** Reads a response body as text, stopping and cancelling the stream past `maxBytes`. */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("rate table response is too large");
  }
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("rate table response had no body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("rate table response is too large");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

const ALIASES: Readonly<Record<string, string>> = {
  "claude-4-sonnet": "claude-sonnet-4",
  "claude-4-opus": "claude-opus-4",
  "claude-sonnet-4-0": "claude-sonnet-4",
  "claude-opus-4-0": "claude-opus-4",
  "claude-4-5-sonnet": "claude-sonnet-4-5",
  "claude-4-5-haiku": "claude-haiku-4-5",
  "claude-4-1-opus": "claude-opus-4-1",
  "claude-5-opus": "claude-opus-5",
  "claude-5-sonnet": "claude-sonnet-5",
  "claude-5-5-opus": "claude-opus-5-5",
  "claude-5-5-sonnet": "claude-sonnet-5-5",
  "claude-5-5-haiku": "claude-haiku-5-5",
  "gpt-5-codex-mini": "gpt-5-mini",
};

const REGION_PROVIDER_PREFIX =
  /^(?:(?:us|eu|apac|global|au|jp)\.)?(?:anthropic|meta|amazon|mistral|cohere|ai21|deepseek|openai)\./;

/**
 * Collapses the many spellings of one model onto one key: provider prefixes
 * (`anthropic/`, `us.anthropic.`), `[1m]` variants, date suffixes and `-latest`.
 */
export function normalizeModelId(raw: string): string {
  let id = raw.trim().toLowerCase();
  id = id.replace(/\[[^\]]*\]$/, "");
  id = id.slice(id.lastIndexOf("/") + 1);
  id = id.replace(REGION_PROVIDER_PREFIX, "");
  id = id.replace(/-v\d+:\d+$/, "");
  id = id.replace(/@\d{8}$/, "");
  id = id.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  id = id.replace(/-\d{8}$/, "");
  id = id.replace(/-latest$/, "");
  if (id.startsWith("claude")) id = id.replace(/(\d)\.(\d)/g, "$1-$2");
  id = id.replace(/^cursor-/, "");
  id = id.replace(/-thinking(?=-|$)/g, "");
  id = id.replace(/-(?:none|minimal|low|medium|high|xhigh|max)(?:-fast)?$/, "");
  id = id.replace(/-fast$/, "");
  return ALIASES[id] ?? id;
}

function lookupRate(table: RateTable, model: string): ModelRate | undefined {
  const key = normalizeModelId(model);
  if (Object.hasOwn(table, key)) return table[key];
  const plain = model.trim().toLowerCase();
  return Object.hasOwn(table, plain) ? table[plain] : undefined;
}

const perMillion = (
  input: number,
  output: number,
  cacheRead?: number,
  cacheWrite?: number,
  cacheWrite1h?: number,
) => {
  const rate: ModelRate = { input: input / 1e6, output: output / 1e6 };
  if (cacheRead !== undefined) rate.cacheRead = cacheRead / 1e6;
  if (cacheWrite !== undefined) rate.cacheWrite = cacheWrite / 1e6;
  if (cacheWrite1h !== undefined) rate.cacheWrite1h = cacheWrite1h / 1e6;
  return rate;
};

const millionTier = (
  thresholdK: number,
  input: number,
  output: number,
  cacheRead?: number,
  cacheWrite?: number,
  cacheWrite1h?: number,
): ContextTier => {
  const tier: ContextTier = {
    thresholdTokens: thresholdK * 1000,
    input: input / 1e6,
    output: output / 1e6,
  };
  if (cacheRead !== undefined) tier.cacheRead = cacheRead / 1e6;
  if (cacheWrite !== undefined) tier.cacheWrite = cacheWrite / 1e6;
  if (cacheWrite1h !== undefined) tier.cacheWrite1h = cacheWrite1h / 1e6;
  return tier;
};

const withTiers = (rate: ModelRate, ...tiers: ContextTier[]): ModelRate => ({
  ...rate,
  contextTiers: tiers,
});

/**
 * Offline snapshot of common models, in USD per million tokens. The LiteLLM table
 * overrides it whenever one is available. Models missing here price as unknown.
 */
export const BUNDLED_RATES: RateTable = {
  "claude-opus-5-5": perMillion(4, 20, 0.2, 5, 8),
  "claude-opus-5": perMillion(5, 25, 0.5, 6.25, 10),
  "claude-opus-4-8": perMillion(5, 25, 0.5, 6.25, 10),
  "claude-opus-4-6": perMillion(5, 25, 0.5, 6.25, 10),
  "claude-opus-4-5": perMillion(5, 25, 0.5, 6.25, 10),
  "claude-opus-4-1": perMillion(15, 75, 1.5, 18.75, 30),
  "claude-opus-4": perMillion(15, 75, 1.5, 18.75, 30),
  "claude-sonnet-5-5": perMillion(2, 10, 0.1, 2.5, 4),
  "claude-sonnet-5": perMillion(2, 10, 0.2, 2.5, 4),
  "claude-sonnet-4-6": perMillion(3, 15, 0.3, 3.75, 6),
  "claude-sonnet-4-5": perMillion(3, 15, 0.3, 3.75, 6),
  "claude-sonnet-4": perMillion(3, 15, 0.3, 3.75, 6),
  "claude-3-7-sonnet": perMillion(3, 15, 0.3, 3.75, 6),
  "claude-3-5-sonnet": perMillion(3, 15, 0.3, 3.75, 6),
  "claude-haiku-5-5": withTiers(
    perMillion(0.1, 0.5, 0.01, 0.125, 0.2),
    millionTier(100, 0.5, 2.5, 0.05, 0.625, 1),
  ),
  "claude-haiku-4-5": perMillion(1, 5, 0.1, 1.25, 2),
  "claude-3-5-haiku": perMillion(0.8, 4, 0.08, 1, 1.6),
  "claude-fable-5-2": perMillion(8, 40, 0.2, 10, 16),
  "claude-fable-5": perMillion(10, 50, 1, 12.5, 20),
  "gpt-5.6-sol": withTiers(perMillion(4, 20, 0.4, 5), millionTier(272, 8, 40, 0.8, 10)),
  "gpt-5.6": withTiers(perMillion(4, 20, 0.4, 5), millionTier(272, 8, 40, 0.8, 10)),
  "gpt-5": perMillion(1.25, 10, 0.125),
  "gpt-5-codex": perMillion(1.25, 10, 0.125),
  "gpt-5-mini": perMillion(0.25, 2, 0.025),
  "gpt-5-nano": perMillion(0.05, 0.4, 0.005),
  "gpt-4-1": perMillion(2, 8, 0.5),
  "gpt-4.1": perMillion(2, 8, 0.5),
  o3: perMillion(2, 8, 0.5),
  "o4-mini": perMillion(1.1, 4.4, 0.275),
  "gemini-4-carbon": perMillion(2, 10, 0.1),
  "gemini-4-argon": perMillion(2, 10, 0.1),
  "gemini-2.5-pro": perMillion(1.25, 10),
  "gemini-2.5-flash": perMillion(0.3, 2.5),
  "grok-4.7": withTiers(perMillion(2, 6, 0.5), millionTier(200, 4, 12, 1)),
  "grok-4.6": withTiers(perMillion(2, 6, 0.5), millionTier(200, 4, 12, 1)),
  "grok-4.5": withTiers(perMillion(2, 6, 0.3), millionTier(200, 4, 12, 0.6)),
  "grok-4": perMillion(3, 15, 0.75),
};

function scaleCacheField(
  base: ModelRate,
  field: "cacheRead" | "cacheWrite" | "cacheWrite1h",
  input: number,
): number | undefined {
  const value = base[field];
  if (value === undefined) return undefined;
  if (base.input <= 0) return value;
  return (value / base.input) * input;
}

/** Highest LiteLLM context tier whose threshold the prompt has crossed. */
function ratesAt(rate: ModelRate, promptTokens: number): ModelRate {
  const tier = rate.contextTiers?.find((entry) => promptTokens > entry.thresholdTokens);
  if (tier === undefined) return rate;
  return {
    input: tier.input,
    output: tier.output,
    cacheRead: tier.cacheRead ?? scaleCacheField(rate, "cacheRead", tier.input),
    cacheWrite: tier.cacheWrite ?? scaleCacheField(rate, "cacheWrite", tier.input),
    cacheWrite1h: tier.cacheWrite1h ?? scaleCacheField(rate, "cacheWrite1h", tier.input),
  };
}

function unsplit(reportedUsd: number): Priced {
  return {
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    other: reportedUsd,
    savings: 0,
    priced: reportedUsd > 0,
  };
}

/** `Pricer` over a rate table. Lookups are memoised per model string. */
export function createPricer(table: RateTable): Pricer {
  const memo = new Map<string, ModelRate | null>();
  return (
    model,
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    reported,
    cacheWrite1hTokens = 0,
  ) => {
    let rate = memo.get(model);
    if (rate === undefined) {
      rate = lookupRate(table, model) ?? null;
      memo.set(model, rate);
    }
    const reportedUsd =
      reported !== undefined && Number.isFinite(reported) && reported > 0 ? reported : 0;
    if (rate === null) return unsplit(reportedUsd);
    const applied = ratesAt(rate, inputTokens + cacheReadTokens + cacheWriteTokens);
    const cacheReadRate = applied.cacheRead ?? applied.input;
    const cacheWriteRate = applied.cacheWrite ?? applied.input;
    const cacheWrite1hRate = applied.cacheWrite1h ?? applied.input * 2;
    const oneHour = Math.min(Math.max(0, cacheWrite1hTokens), cacheWriteTokens);
    const fiveMinute = cacheWriteTokens - oneHour;
    const input = inputTokens * applied.input;
    const cacheRead = cacheReadTokens * cacheReadRate;
    const cacheWrite = fiveMinute * cacheWriteRate + oneHour * cacheWrite1hRate;
    const output = outputTokens * applied.output;
    const listCost = input + cacheRead + cacheWrite + output;
    if (reportedUsd > 0 && listCost <= 0) return unsplit(reportedUsd);
    const scale = reportedUsd > 0 ? reportedUsd / listCost : 1;
    return {
      input: input * scale,
      cacheRead: cacheRead * scale,
      cacheWrite: cacheWrite * scale,
      output: output * scale,
      other: 0,
      savings: Math.max(0, cacheReadTokens * (applied.input - cacheReadRate)),
      priced: true,
    };
  };
}

const LitellmEntry = z.object({
  input_cost_per_token: z.number().nonnegative(),
  output_cost_per_token: z.number().nonnegative(),
  cache_read_input_token_cost: z.number().nonnegative().optional(),
  cache_creation_input_token_cost: z.number().nonnegative().optional(),
  cache_creation_input_token_cost_above_1hr: z.number().nonnegative().optional(),
});

const CONTEXT_TIER_INPUT_KEY = /^input_cost_per_token_above_(\d{1,7})k_tokens$/;

function finiteNonneg(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readContextTiers(
  raw: Record<string, unknown>,
  base: ModelRate,
): readonly ContextTier[] | undefined {
  const thresholds = new Set<number>();
  for (const key of Object.keys(raw)) {
    const match = CONTEXT_TIER_INPUT_KEY.exec(key);
    if (match !== null) thresholds.add(Number(match[1]) * 1000);
  }
  if (thresholds.size === 0) return undefined;
  return [...thresholds]
    .sort((a, b) => b - a)
    .map((thresholdTokens) => {
      const suffix = `_above_${thresholdTokens / 1000}k_tokens`;
      const input = finiteNonneg(raw[`input_cost_per_token${suffix}`]) ?? base.input;
      const output = finiteNonneg(raw[`output_cost_per_token${suffix}`]) ?? base.output;
      const tier: ContextTier = { thresholdTokens, input, output };
      const cacheRead = finiteNonneg(raw[`cache_read_input_token_cost${suffix}`]);
      const cacheWrite = finiteNonneg(raw[`cache_creation_input_token_cost${suffix}`]);
      const cacheWrite1h = finiteNonneg(raw[`cache_creation_input_token_cost_above_1hr${suffix}`]);
      if (cacheRead !== undefined) tier.cacheRead = cacheRead;
      else {
        const scaled = scaleCacheField(base, "cacheRead", input);
        if (scaled !== undefined) tier.cacheRead = scaled;
      }
      if (cacheWrite !== undefined) tier.cacheWrite = cacheWrite;
      else {
        const scaled = scaleCacheField(base, "cacheWrite", input);
        if (scaled !== undefined) tier.cacheWrite = scaled;
      }
      if (cacheWrite1h !== undefined) tier.cacheWrite1h = cacheWrite1h;
      else {
        const scaled = scaleCacheField(base, "cacheWrite1h", input);
        if (scaled !== undefined) tier.cacheWrite1h = scaled;
      }
      return tier;
    });
}

/** Lower wins when several raw keys normalise to one id: bare ids, then first-party prefixes. */
function keyRank(key: string): number {
  if (!key.includes("/") && !/^[a-z]{2,6}\.[a-z]/.test(key)) return 0;
  return /^(?:anthropic|openai|gemini|xai)\//.test(key) ? 1 : 2;
}

/** Reduces LiteLLM's published JSON to the four per-token rates Wooky uses. */
export function reduceLitellm(json: unknown): RateTable {
  const table: RateTable = {};
  const ranks = new Map<string, number>();
  if (typeof json !== "object" || json === null) return table;
  for (const [key, value] of Object.entries(json)) {
    if (key === "sample_spec") continue;
    const entry = LitellmEntry.safeParse(value);
    if (!entry.success) continue;
    const id = normalizeModelId(key);
    if (id === "") continue;
    const rank = keyRank(key.toLowerCase());
    const known = ranks.get(id);
    if (known !== undefined && known <= rank) continue;
    ranks.set(id, rank);
    const rate: ModelRate = {
      input: entry.data.input_cost_per_token,
      output: entry.data.output_cost_per_token,
    };
    if (entry.data.cache_read_input_token_cost !== undefined)
      rate.cacheRead = entry.data.cache_read_input_token_cost;
    if (entry.data.cache_creation_input_token_cost !== undefined)
      rate.cacheWrite = entry.data.cache_creation_input_token_cost;
    if (entry.data.cache_creation_input_token_cost_above_1hr !== undefined)
      rate.cacheWrite1h = entry.data.cache_creation_input_token_cost_above_1hr;
    if (typeof value === "object" && value !== null) {
      const tiers = readContextTiers(value as Record<string, unknown>, rate);
      if (tiers !== undefined) rate.contextTiers = tiers;
    }
    Object.defineProperty(table, id, {
      value: rate,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return table;
}

const TokenRateFields = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number().optional(),
  cacheWrite: z.number().optional(),
  cacheWrite1h: z.number().optional(),
});

const RatesCacheFile = z.object({
  version: z.literal(1),
  fetchedAt: z.number(),
  rates: z.record(
    z.string(),
    TokenRateFields.extend({
      contextTiers: z.array(TokenRateFields.extend({ thresholdTokens: z.number() })).optional(),
    }),
  ),
});

export interface PricingSnapshot {
  /** Bundled snapshot with the fetched rates laid over it. */
  table: RateTable;
  status: UsageHistoryPricing["status"];
  /** ISO time of the fetched table. Absent when only the bundled snapshot is available. */
  asOf?: string;
}

export interface PricingService {
  /** Reads the last good table from memory or disk. Never touches the network. */
  cached(): Promise<PricingSnapshot>;
  /** Refreshes the table when it is older than 24 h. Never throws. */
  load(): Promise<PricingSnapshot>;
}

export interface PricingOptions {
  /** WOOKY_HOME. The table is cached there as `usage-model-rates.json`. */
  home: string;
  fetch?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
  /** Minimum gap between failed fetches. */
  retryMs?: number;
  timeoutMs?: number;
  url?: string;
  /** Cap on the fetched body. Default 16 MB. */
  maxBodyBytes?: number;
  /** Cap on the stored rate file. Default 16 MB. */
  maxFileBytes?: number;
}

interface StoredRates {
  fetchedAt: number;
  rates: RateTable;
}

async function writeAtomic(path: string, body: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(tmp, body, { mode: 0o600 });
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}

export function createPricingService(options: PricingOptions): PricingService {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DAY_MS;
  const retryMs = options.retryMs ?? 10 * 60 * 1000;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const url = options.url ?? LITELLM_URL;
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
  const file = join(options.home, RATES_FILE);

  let stored: StoredRates | null | undefined;
  let failedAt: number | null = null;
  let inflight: Promise<PricingSnapshot> | null = null;

  async function readStored(): Promise<StoredRates | null> {
    if (stored !== undefined) return stored;
    try {
      if ((await statFile(file)).size > maxFileBytes) throw new Error("rate file is too large");
      const parsed = RatesCacheFile.parse(parseJsonSafely(await readFile(file, "utf8")));
      stored = { fetchedAt: parsed.fetchedAt, rates: parsed.rates };
    } catch {
      stored = null;
    }
    return stored;
  }

  function snapshot(
    current: StoredRates | null,
    status: PricingSnapshot["status"],
  ): PricingSnapshot {
    if (current === null) return { table: BUNDLED_RATES, status: "unavailable" };
    return {
      table: { ...BUNDLED_RATES, ...current.rates },
      status,
      asOf: new Date(current.fetchedAt).toISOString(),
    };
  }

  const isFresh = (current: StoredRates | null) =>
    current !== null && now() - current.fetchedAt < ttlMs;

  async function fetchRates(): Promise<StoredRates> {
    const response = await fetchFn(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`rate table request failed (${response.status})`);
    const rates = reduceLitellm(parseJsonSafely(await readCapped(response, maxBodyBytes)));
    if (Object.keys(rates).length === 0) throw new Error("rate table was empty");
    return { fetchedAt: now(), rates };
  }

  async function refresh(): Promise<PricingSnapshot> {
    const current = await readStored();
    if (isFresh(current)) return snapshot(current, "ok");
    if (failedAt !== null && now() - failedAt < retryMs) return snapshot(current, "stale");
    try {
      const next = await fetchRates();
      stored = next;
      failedAt = null;
      await writeAtomic(
        file,
        JSON.stringify({ version: 1, fetchedAt: next.fetchedAt, rates: next.rates }),
      ).catch(() => console.error("usage history: could not save the rate table"));
      return snapshot(next, "ok");
    } catch {
      failedAt = now();
      console.error("usage history: could not fetch the rate table");
      return snapshot(current, "stale");
    }
  }

  return {
    async cached() {
      const current = await readStored();
      return snapshot(current, isFresh(current) ? "ok" : "stale");
    },
    load() {
      inflight ??= refresh().finally(() => {
        inflight = null;
      });
      return inflight;
    },
  };
}
