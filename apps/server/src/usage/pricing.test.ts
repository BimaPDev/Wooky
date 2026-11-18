import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUNDLED_RATES,
  createPricer,
  createPricingService,
  normalizeModelId,
  reduceLitellm,
  type RateTable,
} from "./pricing.ts";

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const HOUR = 3_600_000;

const RATES: RateTable = {
  "test-model": { input: 1e-6, output: 4e-6, cacheRead: 1e-7, cacheWrite: 1.25e-6 },
  "no-cache-rates": { input: 2e-6, output: 8e-6 },
  "odd-cache": { input: 1e-6, output: 2e-6, cacheRead: 3e-6 },
};
const price = createPricer(RATES);

describe("normalizeModelId", () => {
  it.each([
    ["anthropic/claude-sonnet-4-5-20250929", "claude-sonnet-4-5"],
    ["claude-opus-4-1[1m]", "claude-opus-4-1"],
    ["us.anthropic.claude-3-5-haiku-20241022-v1:0", "claude-3-5-haiku"],
    ["Claude-Sonnet-4.5", "claude-sonnet-4-5"],
    ["openai/gpt-5-codex", "gpt-5-codex"],
    ["claude-4-opus-20250514", "claude-opus-4"],
    ["gpt-4o-2024-08-06", "gpt-4o"],
    ["claude-3-7-sonnet-latest", "claude-3-7-sonnet"],
    ["claude-sonnet-4@20250514", "claude-sonnet-4"],
    ["openrouter/anthropic/claude-haiku-4-5", "claude-haiku-4-5"],
  ])("%s -> %s", (raw, expected) => {
    expect(normalizeModelId(raw)).toBe(expected);
  });
});

describe("pricing a record", () => {
  it("prices each token class at its own rate", () => {
    const p = price("test-model", 1_000_000, 1_000_000, 1_000_000, 1_000_000, undefined);
    expect(p.input).toBeCloseTo(1, 9);
    expect(p.cacheRead).toBeCloseTo(0.1, 9);
    expect(p.cacheWrite).toBeCloseTo(1.25, 9);
    expect(p.output).toBeCloseTo(4, 9);
    expect(p.other).toBe(0);
    expect(p.priced).toBe(true);
  });

  it("falls back to the input rate for missing cache rates", () => {
    const p = price("no-cache-rates", 0, 1_000_000, 1_000_000, 0, undefined);
    expect(p.cacheRead).toBeCloseTo(2, 9);
    expect(p.cacheWrite).toBeCloseTo(2, 9);
    expect(p.savings).toBe(0);
  });

  it("prices unknown models at 0 and marks them unpriced", () => {
    const p = price("mystery-1", 1000, 1000, 1000, 1000, undefined);
    expect(p).toMatchObject({ input: 0, output: 0, other: 0, savings: 0, priced: false });
  });

  it("sends a reported cost the rates cannot split to other", () => {
    const split = price("test-model", 1_000_000, 0, 0, 0, 1.75);
    expect(split.input).toBeCloseTo(1, 9);
    expect(split.other).toBeCloseTo(0.75, 9);
    const covered = price("test-model", 1_000_000, 0, 0, 0, 0.5);
    expect(covered.other).toBe(0);
  });

  it("keeps the whole reported cost as other for an unknown model, and counts it priced", () => {
    const p = price("mystery-1", 1000, 0, 0, 0, 0.3);
    expect(p).toMatchObject({ input: 0, other: 0.3, priced: true });
  });

  it("computes cache savings against the input rate and floors them at zero", () => {
    expect(price("test-model", 0, 1_000_000, 0, 0, undefined).savings).toBeCloseTo(0.9, 9);
    expect(price("odd-cache", 0, 1_000_000, 0, 0, undefined).savings).toBe(0);
  });

  it("matches model ids tolerantly", () => {
    expect(price("anthropic/test-model-20250514", 1_000_000, 0, 0, 0, undefined).input).toBeCloseTo(
      1,
      9,
    );
  });

  it("prices common models from the bundled table, so pricing works offline", () => {
    const offline = createPricer(BUNDLED_RATES);
    expect(offline("claude-sonnet-4-5-20250929", 1_000_000, 0, 0, 0, undefined).input).toBeCloseTo(
      3,
      9,
    );
    expect(offline("claude-sonnet-4-5-20250929", 0, 0, 0, 1_000_000, undefined).output).toBeCloseTo(
      15,
      9,
    );
    expect(offline("gpt-5-codex", 1_000_000, 0, 0, 0, undefined).priced).toBe(true);
    expect(offline("constructor", 1, 0, 0, 0, undefined).priced).toBe(false);
  });
});

describe("reduceLitellm", () => {
  it("keeps priced chat models, prefers the bare key and skips junk", () => {
    const table = reduceLitellm({
      sample_spec: { input_cost_per_token: 9, output_cost_per_token: 9 },
      "bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0": {
        input_cost_per_token: 9e-6,
        output_cost_per_token: 9e-6,
      },
      "claude-sonnet-4-5-20250929": {
        input_cost_per_token: 3e-6,
        output_cost_per_token: 15e-6,
        cache_read_input_token_cost: 3e-7,
        cache_creation_input_token_cost: 3.75e-6,
        litellm_provider: "anthropic",
      },
      "embedding-only": { input_cost_per_token: 1e-7 },
      broken: "nope",
    });
    expect(table["claude-sonnet-4-5"]).toEqual({
      input: 3e-6,
      output: 15e-6,
      cacheRead: 3e-7,
      cacheWrite: 3.75e-6,
    });
    expect(Object.keys(table)).toEqual(["claude-sonnet-4-5"]);
  });
});

describe("pricing service", () => {
  let home: string;
  let clock: number;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "age-pricing-"));
    clock = NOW;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  const table = (input: number) => ({
    "fresh-model": { input_cost_per_token: input, output_cost_per_token: input * 5 },
  });
  const respond = (body: unknown, status = 200) =>
    vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));
  const offline = () =>
    vi.fn<typeof fetch>(async () => {
      throw new Error("offline");
    });
  const service = (fetchFn: typeof fetch) =>
    createPricingService({ home, fetch: fetchFn, now: () => clock });

  it("fetches the table, reports ok and caches it in AGE_HOME", async () => {
    const snapshot = await service(respond(table(1e-6))).load();
    expect(snapshot.status).toBe("ok");
    expect(snapshot.asOf).toBe(new Date(NOW).toISOString());
    expect(snapshot.table["fresh-model"]?.input).toBe(1e-6);
    expect(snapshot.table["claude-sonnet-4-5"]).toBeDefined();
    const stored = JSON.parse(await readFile(join(home, "usage-model-rates.json"), "utf8"));
    expect(stored.rates["fresh-model"].output).toBeCloseTo(5e-6, 12);
  });

  it("sends only a plain request for the public table, with no user data", async () => {
    const fetchFn = respond(table(1e-6));
    await service(fetchFn).load();
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/^https:\/\/raw\.githubusercontent\.com\/BerriAI\/litellm\//);
    expect(init.body).toBeUndefined();
    expect(init.method).toBeUndefined();
    expect(Object.keys(init.headers as object)).toEqual(["accept"]);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("serves a table younger than 24 hours from the cache without fetching", async () => {
    await service(respond(table(1e-6))).load();
    clock += 23 * HOUR;
    const fetchFn = respond(table(2e-6));
    const snapshot = await service(fetchFn).load();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(snapshot.status).toBe("ok");
    expect(snapshot.table["fresh-model"]?.input).toBe(1e-6);
  });

  it("refetches once the cache is older than 24 hours", async () => {
    await service(respond(table(1e-6))).load();
    clock += 25 * HOUR;
    const fetchFn = respond(table(2e-6));
    const snapshot = await service(fetchFn).load();
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(snapshot.table["fresh-model"]?.input).toBe(2e-6);
  });

  it("keeps the last good copy and reports stale when the fetch fails", async () => {
    await service(respond(table(1e-6))).load();
    clock += 25 * HOUR;
    const snapshot = await service(offline()).load();
    expect(snapshot.status).toBe("stale");
    expect(snapshot.asOf).toBe(new Date(NOW).toISOString());
    expect(snapshot.table["fresh-model"]?.input).toBe(1e-6);
  });

  it("reports unavailable but still prices from the bundled table when nothing was fetched", async () => {
    const snapshot = await service(respond("nope", 503)).load();
    expect(snapshot.status).toBe("unavailable");
    expect(snapshot.asOf).toBeUndefined();
    expect(snapshot.table["claude-sonnet-4-5"]).toBeDefined();
  });

  it("treats an empty table as a failed fetch", async () => {
    const snapshot = await service(respond({})).load();
    expect(snapshot.status).toBe("unavailable");
  });

  it("does not retry a failed fetch until the retry gap has passed", async () => {
    const failing = offline();
    const pricing = service(failing);
    await pricing.load();
    await pricing.load();
    expect(failing).toHaveBeenCalledOnce();
    clock += 11 * 60 * 1000;
    await pricing.load();
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("joins concurrent loads into one fetch", async () => {
    const fetchFn = respond(table(1e-6));
    const pricing = service(fetchFn);
    await Promise.all([pricing.load(), pricing.load(), pricing.load()]);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("cached() reads the disk copy and never touches the network", async () => {
    await service(respond(table(1e-6))).load();
    clock += 30 * HOUR;
    const fetchFn = respond(table(2e-6));
    const snapshot = await service(fetchFn).cached();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(snapshot.status).toBe("stale");
    expect(snapshot.table["fresh-model"]?.input).toBe(1e-6);
  });

  it("ignores a corrupt rate file", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "usage-model-rates.json"), "{not json");
    const snapshot = await service(respond(table(1e-6))).cached();
    expect(snapshot.status).toBe("unavailable");
  });

  it("treats a response above the byte cap as a failed fetch and stops reading it", async () => {
    let cancelled = false;
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(512));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(body));
    const snapshot = await createPricingService({
      home,
      fetch: fetchFn,
      now: () => clock,
      maxBodyBytes: 4096,
    }).load();
    expect(snapshot.status).toBe("unavailable");
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(20);
  });

  it("rejects a declared content length above the cap without reading", async () => {
    const fetchFn = vi.fn<typeof fetch>(
      async () => new Response("{}", { headers: { "content-length": "999999999" } }),
    );
    const snapshot = await createPricingService({
      home,
      fetch: fetchFn,
      now: () => clock,
      maxBodyBytes: 4096,
    }).load();
    expect(snapshot.status).toBe("unavailable");
  });

  it("ignores a rate file above the size cap", async () => {
    await service(respond(table(1e-6))).load();
    const capped = createPricingService({ home, now: () => clock, maxFileBytes: 10 });
    expect((await capped.cached()).status).toBe("unavailable");
    expect((await service(offline()).cached()).status).toBe("ok");
  });

  it("drops prototype-polluting keys from a stored rate file", async () => {
    await writeFile(
      join(home, "usage-model-rates.json"),
      `{"version":1,"fetchedAt":${NOW},"rates":{"__proto__":{"input":1,"output":1},"ok-model":{"input":1,"output":2}}}`,
    );
    const snapshot = await service(offline()).cached();
    expect(snapshot.table["ok-model"]?.output).toBe(2);
    expect(Object.getPrototypeOf(snapshot.table)).toBe(Object.prototype);
    expect(Object.hasOwn(snapshot.table, "__proto__")).toBe(false);
  });
});
