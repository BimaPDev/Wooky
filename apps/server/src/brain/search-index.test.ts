import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ServiceError } from "../errors.ts";
import {
  isBusyDatabase,
  isCorruptDatabase,
  openBrainIndex,
  searchTerms,
  type IndexedDoc,
  type LoadedFile,
} from "./search-index.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true });
});
const indexFile = () => {
  const home = mkdtempSync(join(tmpdir(), "wooky-brain-index-"));
  dirs.push(home);
  return join(home, "brain", "index.sqlite");
};

describe("search index", () => {
  it("uses FTS5 when this SQLite has it, and the LIKE fallback when told it does not", () => {
    const fts = openBrainIndex(indexFile());
    expect(fts.fts5).toBe(true);
    fts.close();
    const plain = openBrainIndex(indexFile(), { noFts5: true });
    expect(plain.fts5).toBe(false);
    plain.close();
  });

  it("switches mode on an existing file by rebuilding the tables", () => {
    const file = indexFile();
    openBrainIndex(file).close();
    const plain = openBrainIndex(file, { noFts5: true });
    expect(plain.fts5).toBe(false);
    expect(plain.search("x", { scopeKeys: ["global"], limit: 5 })).toEqual([]);
    plain.close();
  });

  it("reduces a query to lowercase words", () => {
    expect(searchTerms('"Foo" OR bar* (baz) foo')).toEqual(["foo", "or", "bar", "baz"]);
    expect(searchTerms("a:b -c ^d {e}")).toEqual(["a", "b", "c", "d", "e"]);
    expect(searchTerms("")).toEqual([]);
    expect(searchTerms(Array.from({ length: 40 }, (_, n) => `w${n}`).join(" "))).toHaveLength(16);
  });
});

const doc = (summary: string): IndexedDoc => ({
  summary,
  kind: "note",
  tags: [],
  status: "active",
  pinned: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
  body: "",
});
const loaded = (summary: string): LoadedFile => ({ raw: Buffer.from(summary), doc: doc(summary) });
const errorOf = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
};

describe("a locked or damaged index", () => {
  it("waits for the lock, then reports busy without touching the file or its rows", () => {
    const file = indexFile();
    const index = openBrainIndex(file, { busyTimeoutMs: 20 });
    index.sync("global", [{ path: "a.md", mtimeMs: 1, size: 5 }], () => loaded("hello"));

    const other = new DatabaseSync(file);
    other.exec("BEGIN IMMEDIATE");
    const error = errorOf(() =>
      index.sync("global", [{ path: "b.md", mtimeMs: 1, size: 5 }], () => loaded("world")),
    );
    other.exec("ROLLBACK");
    other.close();

    expect(isBusyDatabase(error)).toBe(true);
    expect(isCorruptDatabase(error)).toBe(false);
    expect(index.search("hello", { scopeKeys: ["global"], limit: 5 })).toHaveLength(1);
    index.close();
  });

  it("does not delete a healthy index it cannot open because another process holds it", () => {
    const file = indexFile();
    const first = openBrainIndex(file);
    first.sync("global", [{ path: "a.md", mtimeMs: 1, size: 5 }], () => loaded("hello"));
    first.close();
    const inode = statSync(file).ino;

    const other = new DatabaseSync(file);
    other.exec("BEGIN IMMEDIATE");
    const logs: string[] = [];
    // A different mode changes the schema version, which needs the write lock.
    const error = errorOf(() =>
      openBrainIndex(file, { noFts5: true, busyTimeoutMs: 20, log: (m) => logs.push(m) }),
    );
    other.exec("ROLLBACK");
    other.close();

    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe("unavailable");
    expect(logs.join("\n")).not.toMatch(/rebuilding/);
    expect(statSync(file).ino).toBe(inode);
    const again = openBrainIndex(file);
    expect(again.search("hello", { scopeKeys: ["global"], limit: 5 })).toHaveLength(1);
    again.close();
  });

  it("rebuilds only a file that is damaged, and says so", () => {
    const file = indexFile();
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "not a database, just bytes. ".repeat(100));
    const logs: string[] = [];
    const index = openBrainIndex(file, { log: (message) => logs.push(message) });
    expect(logs).toEqual(["brain: rebuilding the search index (the file is damaged)"]);
    expect(index.search("x", { scopeKeys: ["global"], limit: 5 })).toEqual([]);
    index.close();
  });

  it("throws, and keeps what is there, when the index cannot be opened for another reason", () => {
    const file = indexFile();
    mkdirSync(file, { recursive: true });
    writeFileSync(join(file, "keep.txt"), "keep");
    const error = errorOf(() => openBrainIndex(file));
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe("internal");
    expect(existsSync(join(file, "keep.txt"))).toBe(true);
  });

  it("search reports a failing database instead of returning nothing", () => {
    const file = indexFile();
    const index = openBrainIndex(file);
    index.sync("global", [{ path: "a.md", mtimeMs: 1, size: 5 }], () => loaded("hello"));
    const other = new DatabaseSync(file);
    other.exec("DROP TABLE docs");
    other.close();
    const error = errorOf(() => index.search("hello", { scopeKeys: ["global"], limit: 5 }));
    expect(error).not.toBeNull();
    expect(isCorruptDatabase(error)).toBe(false);
    index.close();
  });
});

describe("files with a future mtime", () => {
  const now = Date.UTC(2026, 0, 1);

  it("are hashed once and then trusted, not re-read on every search", () => {
    const index = openBrainIndex(indexFile(), { now: () => now });
    let loads = 0;
    const load = () => {
      loads += 1;
      return loaded("future");
    };
    const files = [{ path: "a.md", mtimeMs: now + 30 * 86_400_000, size: 6 }];
    expect(index.sync("global", files, load).added).toBe(1);
    for (let run = 0; run < 3; run += 1) {
      expect(index.sync("global", files, load)).toMatchObject({ unchanged: 1, updated: 0 });
    }
    expect(loads).toBe(1);
    const edited = [{ path: "a.md", mtimeMs: now + 31 * 86_400_000, size: 6 }];
    expect(index.sync("global", edited, () => loaded("edited"))).toMatchObject({ updated: 1 });
    index.close();
  });

  it("still rehashes a file modified within the racy window", () => {
    const index = openBrainIndex(indexFile(), { now: () => now });
    let loads = 0;
    const load = () => {
      loads += 1;
      return loaded("fresh");
    };
    const files = [{ path: "a.md", mtimeMs: now - 500, size: 5 }];
    index.sync("global", files, load);
    index.sync("global", files, load);
    expect(loads).toBe(2);
    index.close();
  });
});
