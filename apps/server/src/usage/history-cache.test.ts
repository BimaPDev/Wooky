import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadCache, saveCache } from "./history-cache.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "age-history-cache-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const record = {
  origin: "claude" as const,
  model: "m",
  sessionKey: "s",
  at: 1,
  inputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 1,
};

const entry = (note?: string) => ({
  fingerprint: { sinceMs: 0, files: [], dirs: [] },
  report: { origin: "claude" as const, status: "ok" as const, files: 1, ...(note ? { note } : {}) },
  records: [record],
  files: new Map(),
});

describe("loadCache", () => {
  it("rejects a file above the size cap as corrupt and rebuilds", async () => {
    const path = join(dir, "cache.json");
    await saveCache(path, { version: 1, origins: { claude: entry() } });
    expect((await loadCache(path)).origins.claude?.records).toHaveLength(1);
    expect((await loadCache(path, 10)).origins).toEqual({});
  });

  it("drops prototype-polluting keys", async () => {
    const path = join(dir, "cache.json");
    await saveCache(path, { version: 1, origins: { claude: entry() } });
    const text = JSON.stringify({
      version: 1,
      origins: { __proto__: { polluted: true }, constructor: {}, prototype: {} },
    }).replace('"origins":{', '"origins":{"__proto__":{"polluted":true},');
    await writeFile(path, text);
    const loaded = await loadCache(path);
    expect(Object.keys(loaded.origins)).toEqual([]);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("re-sanitises a note an older version wrote", async () => {
    const path = join(dir, "cache.json");
    await saveCache(path, {
      version: 1,
      origins: { claude: entry("Skipped /Users/me/x/y.db. More detail.") },
    });
    expect((await loadCache(path)).origins.claude?.report.note).toBe("Skipped <path>.");
  });
});
