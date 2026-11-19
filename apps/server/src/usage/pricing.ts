import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, stat as statFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { UsageHistoryPricing } from "@age/contracts";
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

/**
 * Offline snapshot of common models, in USD per million tokens. The LiteLLM table
 * overrides it whenever one is available. Models missing here price as unknown.
 */
export const BUNDLED_RATES: RateTable = {
  "claude-opus-4-5": perMillion(5, 25, 0.5, 6.25, 10),
  "claude-opus-4-1": perMillion(15, 75, 1.5, 18.75, 30),
  "claude-opus-4": perMillion(15, 75, 1.5, 18.75, 30),
  "claude-sonnet-4-5": perMillion(3, 15, 0.3, 3.75, 6),
  "claude-sonnet-4": perMillion(3, 15, 0.3, 3.75, 6),
  "claude-3-7-sonnet": perMillion(3, 15, 0.3, 3.75, 6),
  "claude-3-5-sonnet": perMillion(3, 15, 0.3, 3.75, 6),
  "claude-haiku-4-5": perMillion(1, 5, 0.1, 1.25, 2),
  "claude-3-5-haiku": perMillion(0.8, 4, 0.08, 1, 1.6),
  "gpt-5": perMillion(1.25, 10, 0.125),
  "gpt-5-codex": perMillion(1.25, 10, 0.125),
  "gpt-5-mini": perMillion(0.25, 2, 0.025),
  "gpt-5-nano": perMillion(0.05, 0.4, 0.005),
  "gpt-4-1": perMillion(2, 8, 0.5),
  "gpt-4.1": perMillion(2, 8, 0.5),
  o3: perMillion(2, 8, 0.5),
  "o4-mini": perMillion(1.1, 4.4, 0.275),
  "gemini-2.5-pro": perMillion(1.25, 10),
  "gemini-2.5-flash": perMillion(0.3, 2.5),
  "grok-4": perMillion(3, 15, 0.75),
};

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
    if (rate === null) {
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
    const cacheReadRate = rate.cacheRead ?? rate.input;
    const cacheWriteRate = rate.cacheWrite ?? rate.input;
    const cacheWrite1hRate = rate.cacheWrite1h ?? rate.input * 2;
    const oneHour = Math.min(Math.max(0, cacheWrite1hTokens), cacheWriteTokens);
    const fiveMinute = cacheWriteTokens - oneHour;
    const input = inputTokens * rate.input;
    const cacheRead = cacheReadTokens * cacheReadRate;
    const cacheWrite = fiveMinute * cacheWriteRate + oneHour * cacheWrite1hRate;
    const output = outputTokens * rate.output;
    return {
      input,
      cacheRead,
      cacheWrite,
      output,
      other: Math.max(0, reportedUsd - input - cacheRead - cacheWrite - output),
      savings: Math.max(0, cacheReadTokens * (rate.input - cacheReadRate)),
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

/** Lower wins when several raw keys normalise to one id: bare ids, then first-party prefixes. */
function keyRank(key: string): number {
  if (!key.includes("/") && !/^[a-z]{2,6}\.[a-z]/.test(key)) return 0;
  return /^(?:anthropic|openai|gemini|xai)\//.test(key) ? 1 : 2;
}

/** Reduces LiteLLM's published JSON to the four per-token rates AGE uses. */
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
    Object.defineProperty(table, id, {
      value: rate,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return table;
}

const RatesCacheFile = z.object({
  version: z.literal(1),
  fetchedAt: z.number(),
  rates: z.record(
    z.string(),
    z.object({
      input: z.number(),
      output: z.number(),
      cacheRead: z.number().optional(),
      cacheWrite: z.number().optional(),
      cacheWrite1h: z.number().optional(),
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
  /** AGE_HOME. The table is cached there as `usage-model-rates.json`. */
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
