import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openBrainIndex, searchTerms } from "./search-index.ts";

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
