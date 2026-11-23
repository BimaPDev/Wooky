import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { BrainScope, MemoryFrontmatterInput } from "@wooky/contracts";
import { ServiceError } from "../errors.ts";
import { createBrainStore, type BrainStore } from "./store.ts";

const GLOBAL: BrainScope = { kind: "global" };
const A: BrainScope = { kind: "project", projectId: "proj_a" };
const B: BrainScope = { kind: "project", projectId: "proj_b" };
const g = (path: string) => `brain://global/${path}`;
const a = (path: string) => `brain://project/proj_a/${path}`;
const b = (path: string) => `brain://project/proj_b/${path}`;

const dirs: string[] = [];
const dir = (label: string) => {
  const path = mkdtempSync(join(tmpdir(), `wooky-brain-${label}-`));
  dirs.push(path);
  return path;
};
afterEach(() => {
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

function canSymlink(): boolean {
  const base = dir("probe");
  try {
    symlinkSync(base, join(base, "link"), "dir");
    return true;
  } catch {
    return false;
  }
}
const symlinks = canSymlink();

interface Fixture {
  store: BrainStore;
  home: string;
  rootA: string;
  rootB: string;
  logs: string[];
  /** Absolute folder of a project's brain. */
  brainA: string;
}

function setup(
  options: {
    noFts5?: boolean;
    fixedClock?: boolean;
    now?: () => number;
    indexBusyTimeoutMs?: number;
    onSync?: (scopeKey: string) => void;
  } = {},
): Fixture {
  const home = dir("home");
  const rootA = dir("a");
  const rootB = dir("b");
  const logs: string[] = [];
  let tick = Date.UTC(2026, 0, 1);
  const clock = options.fixedClock
    ? () => "2026-01-01T00:00:00.000Z"
    : () => new Date((tick += 1000)).toISOString();
  const store = createBrainStore({
    home,
    resolveProjectRoot: (id) => (id === "proj_a" ? rootA : id === "proj_b" ? rootB : null),
    clock,
    log: (message) => logs.push(message),
    ...(options.noFts5 === undefined ? {} : { noFts5: options.noFts5 }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.onSync === undefined ? {} : { onSync: options.onSync }),
    ...(options.indexBusyTimeoutMs === undefined
      ? {}
      : { indexBusyTimeoutMs: options.indexBusyTimeoutMs }),
  });
  return { store, home, rootA, rootB, logs, brainA: join(rootA, ".wooky", "brain") };
}

const note = (
  summary: string,
  body = "",
  extra: Partial<MemoryFrontmatterInput> = {},
): { frontmatter: MemoryFrontmatterInput; body: string } => ({
  frontmatter: { summary, kind: "note", ...extra },
  body,
});

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof ServiceError) return error.code;
    throw error;
  }
  return "none";
}

describe("writing and reading", () => {
  it("reads at all three tiers", () => {
    const { store } = setup();
    store.write(g("lessons/pnpm.md"), {
      frontmatter: { summary: "Use pnpm", kind: "preference", tags: ["tooling"], pinned: true },
      body: "Always use pnpm.\n\nIt is faster.",
    });

    const l0 = store.read(g("lessons/pnpm.md"), 0);
    expect(l0).toMatchObject({ type: "memory", tier: 0, body: "" });
    expect(l0.frontmatter).toMatchObject({
      summary: "Use pnpm",
      kind: "preference",
      tags: ["tooling"],
      status: "active",
      pinned: true,
    });

    const l2 = store.read(g("lessons/pnpm.md"), 2);
    expect(l2).toMatchObject({ tier: 2, body: "Always use pnpm.\n\nIt is faster.\n" });
    expect(store.read(g("lessons/pnpm.md"), 1).body).toBe(l2.body);

    const folderL0 = store.read(g("lessons"), 0);
    expect(folderL0).toMatchObject({ type: "overview", tier: 0, body: "" });
    expect(folderL0.frontmatter.summary).toBe("1 memory, 0 folders");
    const folderL1 = store.read(g("lessons/"), 1);
    expect(folderL1.type).toBe("overview");
    expect(folderL1.body).toContain("`pnpm.md` (preference): Use pnpm");
    expect(store.overview(g("lessons")).body).toBe(folderL1.body);
  });

  it("reports not_found and bad requests with the right codes", () => {
    const { store } = setup();
    expect(codeOf(() => store.read(g("missing.md"), 2))).toBe("not_found");
    expect(codeOf(() => store.read(g("missing"), 1))).toBe("not_found");
    expect(codeOf(() => store.read("brain://project/nope/x.md", 2))).toBe("not_found");
    expect(codeOf(() => store.write(g("notes"), note("s")))).toBe("bad_request");
    expect(codeOf(() => store.list(g("x.md")))).toBe("bad_request");
    expect(codeOf(() => store.remove(g("missing.md")))).toBe("not_found");
    expect(codeOf(() => store.archive(g("missing.md")))).toBe("not_found");
  });

  it("creates .wooky/brain only on the first write", () => {
    const { store, rootA, brainA } = setup();
    expect(store.list(a(""))).toEqual([]);
    expect(store.overview(a("")).body).toContain("No memories yet");
    expect(store.search("anything", { scopes: [A], limit: 5 })).toEqual([]);
    expect(codeOf(() => store.read(a("x.md"), 2))).toBe("not_found");
    expect(existsSync(join(rootA, ".wooky"))).toBe(false);

    store.write(a("decisions/db.md"), note("Use SQLite"));
    expect(statSync(brainA).isDirectory()).toBe(true);
    expect(existsSync(join(brainA, "decisions", "db.md"))).toBe(true);
  });

  it("leaves no temp files behind and replaces the file in place", () => {
    const { store, brainA } = setup();
    store.write(a("n.md"), note("one", "first"));
    store.write(a("n.md"), note("two", "second"));
    expect(readdirSync(brainA).sort()).toEqual(["_overview.md", "n.md"]);
    expect(store.read(a("n.md"), 2).body).toBe("second\n");
  });

  it("reads hand-edited files tolerantly", () => {
    const { store, brainA } = setup();
    mkdirSync(brainA, { recursive: true });
    writeFileSync(join(brainA, "plain.md"), "# Plain note\n\nno frontmatter\n");
    const entry = store.read(a("plain.md"), 2);
    expect(entry.frontmatter).toMatchObject({
      summary: "Plain note",
      kind: "note",
      status: "active",
    });
    expect(entry.body).toContain("no frontmatter");
  });

  it("archives, hides from listings and keeps the file readable", () => {
    const { store } = setup();
    store.write(g("x/keep.md"), note("keep"));
    store.write(g("x/old.md"), note("old"));
    store.archive(g("x/old.md"));
    store.archive(g("x/old.md"));
    expect(store.read(g("x/old.md"), 0).frontmatter.status).toBe("archived");
    expect(store.list(g("x")).map((node) => node.name)).toEqual(["keep.md"]);
    expect(store.list(g("x"), { includeArchived: true }).map((node) => node.name)).toEqual([
      "keep.md",
      "old.md",
    ]);
    expect(store.overview(g("x")).body).not.toContain("old.md");
  });

  it("removes a memory, then its empty folders and their overviews", () => {
    const { store, home } = setup();
    store.write(g("a/b/one.md"), note("one"));
    const folder = join(home, "brain", "global", "a");
    expect(existsSync(join(folder, "_overview.md"))).toBe(true);
    store.remove(g("a/b/one.md"));
    expect(existsSync(folder)).toBe(false);
    expect(store.list(g(""))).toEqual([]);
    expect(codeOf(() => store.read(g("a/b/one.md"), 0))).toBe("not_found");
  });

  it("lists one level with counts and L0 summaries", () => {
    const { store } = setup();
    store.write(g("top.md"), note("Top", "", { kind: "lesson" }));
    store.write(g("dir/one.md"), note("One"));
    store.write(g("dir/deep/two.md"), note("Two"));
    const nodes = store.list(g(""));
    expect(nodes.map((node) => [node.name, node.type, node.count ?? node.summary])).toEqual([
      ["dir", "folder", 2],
      ["top.md", "memory", "Top"],
    ]);
    expect(nodes[1]).toMatchObject({ kind: "lesson", status: "active", uri: g("top.md") });
  });
});

describe("expectedUpdatedAt", () => {
  it("detects a stale write", () => {
    const { store } = setup();
    const first = store.write(g("n.md"), note("v1"));
    expect(first.created).toBe(true);
    const second = store.write(g("n.md"), note("v2"), { expectedUpdatedAt: first.updatedAt });
    expect(second.created).toBe(false);
    expect(second.updatedAt > first.updatedAt).toBe(true);

    expect(
      codeOf(() => store.write(g("n.md"), note("v3"), { expectedUpdatedAt: first.updatedAt })),
    ).toBe("conflict");
    expect(store.read(g("n.md"), 0).frontmatter.summary).toBe("v2");
    expect(
      codeOf(() => store.write(g("absent.md"), note("x"), { expectedUpdatedAt: first.updatedAt })),
    ).toBe("conflict");
    store.write(g("n.md"), note("v4"), { expectedUpdatedAt: second.updatedAt });
  });

  it("treats expectedUpdatedAt null as create-only", () => {
    const { store } = setup();
    expect(store.write(g("once.md"), note("v1"), { expectedUpdatedAt: null }).created).toBe(true);
    expect(codeOf(() => store.write(g("once.md"), note("v2"), { expectedUpdatedAt: null }))).toBe(
      "conflict",
    );
    expect(store.read(g("once.md"), 0).frontmatter.summary).toBe("v1");
    expect(store.write(g("once.md"), note("v3")).created).toBe(false);
  });

  it("moves updatedAt forward even when the clock stands still", () => {
    const { store } = setup({ fixedClock: true });
    const first = store.write(g("n.md"), note("v1"));
    const second = store.write(g("n.md"), note("v2"), { expectedUpdatedAt: first.updatedAt });
    expect(second.updatedAt > first.updatedAt).toBe(true);
    expect(
      codeOf(() => store.write(g("n.md"), note("v3"), { expectedUpdatedAt: first.updatedAt })),
    ).toBe("conflict");
  });
});

describe("limits and secrets", () => {
  it("rejects bad frontmatter before touching disk", () => {
    const { store, rootA } = setup();
    const bad = (frontmatter: unknown) =>
      store.write(a("n.md"), { frontmatter: frontmatter as MemoryFrontmatterInput, body: "" });
    expect(() => bad({ summary: "s", kind: "note", bogus: true })).toThrow(/not allowed/);
    expect(() => bad({ summary: "x".repeat(201), kind: "note" })).toThrow(/summary/);
    expect(() => bad({ summary: "s", kind: "unknown" })).toThrow(/kind/);
    expect(existsSync(join(rootA, ".wooky"))).toBe(false);
  });

  it("caps the body at 16 KB", () => {
    const { store } = setup();
    store.write(g("ok.md"), note("fits", "x".repeat(16 * 1024 - 1)));
    expect(() => store.write(g("big.md"), note("big", "x".repeat(16 * 1024 + 10)))).toThrow(
      /limit/,
    );
  });

  it("refuses credentials in the summary, tags, source and body, without echoing them", () => {
    const { store } = setup();
    const secret = ["ghp_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join("");
    const attempts = [
      note(`token ${secret}`),
      note("s", `line one\n${secret}`),
      { frontmatter: { summary: "s", kind: "note" as const, source: { agent: secret } }, body: "" },
    ];
    for (const attempt of attempts) {
      let message = "";
      try {
        store.write(g("n.md"), attempt);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/credential/);
      expect(message).not.toContain(secret);
    }
    expect(codeOf(() => store.read(g("n.md"), 0))).toBe("not_found");
  });

  it("holds at most 2000 memories per scope", () => {
    const { store, home } = setup();
    const folder = join(home, "brain", "global");
    mkdirSync(folder, { recursive: true });
    for (let n = 0; n < 2000; n += 1) writeFileSync(join(folder, `m${n}.md`), `# memory ${n}\n`);
    expect(() => store.write(g("one-more.md"), note("too many"))).toThrow(/2000/);
    store.write(g("m5.md"), note("rewriting an existing one is fine"));
    store.write(a("fresh.md"), note("other scopes have their own budget"));
  });
});

describe("path safety", () => {
  const rejected = [
    "brain://global/../escape.md",
    "brain://global/a/../../escape.md",
    "brain://global//escape.md",
    "brain://global/%2e%2e/escape.md",
    "brain://global/a%2f..%2fescape.md",
    "brain://global/a\\..\\escape.md",
    "brain://global/a\0b.md",
    "brain://global/_overview.md",
    "brain://global/Upper.md",
    "brain://global/a/b/c/d/e/f/g.md",
    "/etc/passwd",
    "brain://project//x.md",
  ];

  it.each(rejected)("refuses %j everywhere", (uri) => {
    const { store, home } = setup();
    expect(codeOf(() => store.write(uri, note("x")))).toBe("bad_request");
    expect(codeOf(() => store.read(uri, 2))).toBe("bad_request");
    expect(codeOf(() => store.list(uri))).toBe("bad_request");
    expect(codeOf(() => store.archive(uri))).toBe("bad_request");
    expect(codeOf(() => store.remove(uri))).toBe("bad_request");
    expect(existsSync(join(home, "brain", "global"))).toBe(false);
  });

  it.skipIf(!symlinks)("refuses a symlinked .wooky and never writes through it", () => {
    const { store, rootA, logs } = setup();
    const outside = dir("outside");
    mkdirSync(join(outside, "brain"), { recursive: true });
    writeFileSync(join(outside, "brain", "secret.md"), "# outside\n");
    symlinkSync(outside, join(rootA, ".wooky"), "dir");

    for (const run of [
      () => store.read(a("secret.md"), 2),
      () => store.list(a("")),
      () => store.overview(a("")),
      () => store.write(a("new.md"), note("x")),
      () => store.archive(a("secret.md")),
      () => store.remove(a("secret.md")),
    ]) {
      expect(codeOf(run)).toBe("forbidden");
    }
    expect(readdirSync(join(outside, "brain"))).toEqual(["secret.md"]);
    expect(store.search("outside", { scopes: [A], limit: 5 })).toEqual([]);
    expect(logs.join("\n")).toMatch(/symbolic link/);
  });

  it.skipIf(!symlinks)("refuses a symlinked brain folder", () => {
    const { store, rootA } = setup();
    const outside = dir("outside");
    writeFileSync(join(outside, "secret.md"), "# outside\n");
    mkdirSync(join(rootA, ".wooky"));
    symlinkSync(outside, join(rootA, ".wooky", "brain"), "dir");
    expect(codeOf(() => store.read(a("secret.md"), 2))).toBe("forbidden");
    expect(codeOf(() => store.write(a("new.md"), note("x")))).toBe("forbidden");
    expect(readdirSync(outside)).toEqual(["secret.md"]);
    expect(store.search("outside", { scopes: [A], limit: 5 })).toEqual([]);
  });

  it.skipIf(!symlinks)("refuses a symlinked global brain folder", () => {
    const { store, home } = setup();
    const outside = dir("outside");
    symlinkSync(outside, join(home, "brain"), "dir");
    expect(codeOf(() => store.write(g("new.md"), note("x")))).toBe("forbidden");
    expect(readdirSync(outside)).toEqual([]);
  });

  it.skipIf(!symlinks)("refuses a symlinked subfolder, and the index skips it", () => {
    const { store, brainA, logs } = setup();
    store.write(a("real/ok.md"), note("kept", "needle"));
    const outside = dir("outside");
    writeFileSync(join(outside, "leak.md"), "# leak needle\n");
    symlinkSync(outside, join(brainA, "linked"), "dir");

    expect(codeOf(() => store.read(a("linked/leak.md"), 2))).toBe("forbidden");
    expect(codeOf(() => store.write(a("linked/new.md"), note("x")))).toBe("forbidden");
    expect(codeOf(() => store.list(a("linked")))).toBe("forbidden");
    expect(readdirSync(outside)).toEqual(["leak.md"]);
    expect(store.list(a("")).map((node) => node.name)).toEqual(["real"]);

    const hits = store.search("needle", { scopes: [A], limit: 10 });
    expect(hits.map((hit) => hit.path)).toEqual(["real/ok.md"]);
    expect(logs.join("\n")).toMatch(/skipping symbolic link .*linked/);
  });

  it.skipIf(!symlinks)("refuses a symlinked memory file, and the index skips it", () => {
    const { store, brainA, logs } = setup();
    store.write(a("ok.md"), note("kept", "needle"));
    const outside = dir("outside");
    const target = join(outside, "target.md");
    writeFileSync(target, "# leak needle\n");
    symlinkSync(target, join(brainA, "link.md"));

    expect(codeOf(() => store.read(a("link.md"), 2))).toBe("forbidden");
    expect(codeOf(() => store.write(a("link.md"), note("overwrite")))).toBe("forbidden");
    expect(codeOf(() => store.archive(a("link.md")))).toBe("forbidden");
    expect(codeOf(() => store.remove(a("link.md")))).toBe("forbidden");
    expect(readFileSync(target, "utf8")).toBe("# leak needle\n");
    expect(store.list(a("")).map((node) => node.name)).toEqual(["ok.md"]);
    expect(store.search("needle", { scopes: [A], limit: 10 }).map((hit) => hit.path)).toEqual([
      "ok.md",
    ]);
    expect(logs.join("\n")).toMatch(/skipping symbolic link .*link\.md/);
  });

  it.skipIf(!symlinks)("does not follow a symlinked _overview.md", () => {
    const { store, brainA } = setup();
    store.write(a("ok.md"), note("kept"));
    const outside = dir("outside");
    const target = join(outside, "overview.md");
    writeFileSync(target, "outside\n");
    rmSync(join(brainA, "_overview.md"));
    symlinkSync(target, join(brainA, "_overview.md"));
    expect(codeOf(() => store.overview(a("")))).toBe("forbidden");
    store.write(a("second.md"), note("another"));
    expect(readFileSync(target, "utf8")).toBe("outside\n");
  });
});

describe.each([
  { name: "FTS5", noFts5: false },
  { name: "LIKE fallback", noFts5: true },
])("search ($name)", ({ noFts5 }) => {
  it("ranks the better match first and leaves out non-matches", () => {
    const { store } = setup({ noFts5 });
    store.write(
      g("strong.md"),
      note("pnpm is the package manager", "pnpm pnpm install", { tags: ["pnpm"] }),
    );
    store.write(g("weak.md"), note("Build notes", "run pnpm once in a while"));
    store.write(g("other.md"), note("Unrelated", "nothing here"));
    const hits = store.search("pnpm", { scopes: [GLOBAL], limit: 10 });
    expect(hits.map((hit) => hit.path)).toEqual(["strong.md", "weak.md"]);
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? Infinity);
    expect(hits[0]).toMatchObject({
      uri: g("strong.md"),
      summary: "pnpm is the package manager",
      kind: "note",
      tags: ["pnpm"],
      status: "active",
      trust: "user",
    });
  });

  it("honours the limit, the path prefix at folder boundaries, and archived", () => {
    const { store } = setup({ noFts5 });
    store.write(g("lessons/one.md"), note("alpha one"));
    store.write(g("lessons/two.md"), note("alpha two"));
    store.write(g("lessonsx/three.md"), note("alpha three"));
    store.write(g("playbooks/four.md"), note("alpha four"));
    expect(store.search("alpha", { scopes: [GLOBAL], limit: 2 })).toHaveLength(2);
    const prefixed = store.search("alpha", { scopes: [GLOBAL], pathPrefix: "lessons", limit: 10 });
    expect(prefixed.map((hit) => hit.path).sort()).toEqual(["lessons/one.md", "lessons/two.md"]);
    expect(
      store.search("alpha", { scopes: [GLOBAL], pathPrefix: "lessons/one.md", limit: 10 }),
    ).toHaveLength(1);
    expect(() => store.search("alpha", { scopes: [GLOBAL], pathPrefix: "../x", limit: 1 })).toThrow(
      /pathPrefix/,
    );

    store.archive(g("lessons/one.md"));
    expect(
      store
        .search("alpha", { scopes: [GLOBAL], pathPrefix: "lessons", limit: 10 })
        .map((hit) => hit.path),
    ).toEqual(["lessons/two.md"]);
    expect(
      store.search("alpha", {
        scopes: [GLOBAL],
        pathPrefix: "lessons",
        limit: 10,
        includeArchived: true,
      }),
    ).toHaveLength(2);
  });

  it("keeps global, project A and project B apart", () => {
    const { store } = setup({ noFts5 });
    store.write(g("n.md"), note("shared word", "zebra in global"));
    store.write(a("n.md"), note("shared word", "zebra in project a"));
    store.write(b("n.md"), note("shared word", "zebra in project b"));
    store.write(b("only-b.md"), note("only b has this", "quokka"));

    const uris = (scopes: BrainScope[], query = "zebra") =>
      store
        .search(query, { scopes, limit: 10 })
        .map((hit) => hit.uri)
        .sort();
    expect(uris([GLOBAL])).toEqual([g("n.md")]);
    expect(uris([A])).toEqual([a("n.md")]);
    expect(uris([B])).toEqual([b("n.md")]);
    expect(uris([A, GLOBAL])).toEqual([g("n.md"), a("n.md")]);
    expect(uris([A, B, GLOBAL])).toHaveLength(3);
    expect(uris([A], "quokka")).toEqual([]);
    expect(uris([GLOBAL], "quokka")).toEqual([]);
    expect(uris([B], "quokka")).toEqual([b("only-b.md")]);
    expect(uris([])).toEqual([]);
  });

  it("skips scopes it cannot open instead of failing the whole search", () => {
    const { store } = setup({ noFts5 });
    store.write(g("n.md"), note("hello world"));
    const hits = store.search("hello", {
      scopes: [{ kind: "project", projectId: "gone" }, GLOBAL],
      limit: 5,
    });
    expect(hits.map((hit) => hit.uri)).toEqual([g("n.md")]);
  });

  it("treats the query as plain words, never as FTS syntax", () => {
    const { store } = setup({ noFts5 });
    store.write(g("foo.md"), note("foo is here", "bar baz"));
    const queries = [
      '"foo" OR bar*',
      '"unterminated',
      "foo AND NOT",
      "NEAR(foo bar, 2)",
      "summary:foo",
      "-foo",
      "^foo",
      "(foo",
      "foo)",
      "{foo}",
      "foo' OR '1'='1",
      "*",
      "  ",
      "",
      "💥",
      "a".repeat(5000),
    ];
    for (const query of queries) {
      expect(() => store.search(query, { scopes: [GLOBAL], limit: 5 })).not.toThrow();
    }
    expect(
      store.search('"foo" OR bar*', { scopes: [GLOBAL], limit: 5 }).map((hit) => hit.path),
    ).toEqual(["foo.md"]);
    expect(store.search("foo' OR '1'='1", { scopes: [GLOBAL], limit: 5 })).toHaveLength(1);
    expect(store.search("   ", { scopes: [GLOBAL], limit: 5 })).toEqual([]);
  });

  it("stems words and ignores case in FTS mode", () => {
    if (noFts5) return;
    const { store } = setup();
    store.write(g("n.md"), note("Installing packages", "Run the INSTALLER"));
    expect(store.search("install", { scopes: [GLOBAL], limit: 5 })).toHaveLength(1);
  });
});

describe("reindexing", () => {
  it("picks up an external edit, a new file and a deletion", () => {
    const { store, home } = setup();
    store.write(g("edit.md"), note("old words", "alpha"));
    store.write(g("gone.md"), note("doomed", "beta"));
    expect(store.reindex(GLOBAL)).toMatchObject({ added: 2, removed: 0 });
    expect(store.search("alpha", { scopes: [GLOBAL], limit: 5 })).toHaveLength(1);

    const folder = join(home, "brain", "global");
    writeFileSync(
      join(folder, "edit.md"),
      '---\nsummary: "new words entirely"\nkind: "lesson"\n---\n\ngamma delta epsilon\n',
    );
    writeFileSync(join(folder, "added.md"), "# Added by hand\n\nzeta\n");
    rmSync(join(folder, "gone.md"));

    expect(store.reindex(GLOBAL)).toEqual({ added: 1, updated: 1, removed: 1, unchanged: 0 });
    expect(store.search("alpha", { scopes: [GLOBAL], limit: 5 })).toEqual([]);
    expect(store.search("beta", { scopes: [GLOBAL], limit: 5 })).toEqual([]);
    expect(store.search("gamma", { scopes: [GLOBAL], limit: 5 })[0]).toMatchObject({
      path: "edit.md",
      kind: "lesson",
      summary: "new words entirely",
    });
    expect(store.search("zeta", { scopes: [GLOBAL], limit: 5 })[0]).toMatchObject({
      path: "added.md",
      summary: "Added by hand",
    });
  });

  it("searches see external changes without an explicit reindex", () => {
    const { store, brainA } = setup();
    store.write(a("n.md"), note("first", "alpha"));
    expect(store.search("alpha", { scopes: [A], limit: 5 })).toHaveLength(1);
    rmSync(join(brainA, "n.md"));
    expect(store.search("alpha", { scopes: [A], limit: 5 })).toEqual([]);
  });

  it("skips untouched files by mtime and size once they are old enough", () => {
    const { store } = setup({ now: () => Date.now() + 3_600_000 });
    store.write(g("a.md"), note("one"));
    store.write(g("b.md"), note("two"));
    expect(store.reindex(GLOBAL).added).toBe(2);
    expect(store.reindex(GLOBAL)).toEqual({ added: 0, updated: 0, removed: 0, unchanged: 2 });
  });

  it("rehashes a fresh file, so a same-size edit with the old mtime is still noticed", () => {
    const { store, home } = setup();
    store.write(g("n.md"), note("same length", "aaaa"));
    store.reindex(GLOBAL);
    const file = join(home, "brain", "global", "n.md");
    const before = statSync(file);
    writeFileSync(file, readFileSync(file, "utf8").replace("aaaa", "bbbb"));
    utimesSync(file, before.atime, before.mtime);
    expect(store.reindex(GLOBAL).updated).toBe(1);
    expect(store.search("bbbb", { scopes: [GLOBAL], limit: 5 })).toHaveLength(1);
  });

  it("reports a busy index as unavailable and keeps the file", () => {
    const { store, home, logs } = setup({ indexBusyTimeoutMs: 20 });
    store.write(g("n.md"), note("hello", "needle"));
    expect(store.search("needle", { scopes: [GLOBAL], limit: 5 })).toHaveLength(1);
    const indexFile = join(home, "brain", "index.sqlite");
    const inode = statSync(indexFile).ino;

    const other = new DatabaseSync(indexFile);
    other.exec("BEGIN IMMEDIATE");
    store.write(g("m.md"), note("second", "needle"));
    expect(codeOf(() => store.search("needle", { scopes: [GLOBAL], limit: 5 }))).toBe(
      "unavailable",
    );
    other.exec("ROLLBACK");
    other.close();

    expect(logs.some((line) => /search failed/.test(line))).toBe(true);
    expect(logs.some((line) => /rebuilding/.test(line))).toBe(false);
    expect(statSync(indexFile).ino).toBe(inode);
    expect(store.search("needle", { scopes: [GLOBAL], limit: 5 })).toHaveLength(2);
  });

  it("rebuilds from the files when the index is deleted or damaged", () => {
    const { store, home } = setup();
    store.write(g("n.md"), note("hello", "needle"));
    store.search("needle", { scopes: [GLOBAL], limit: 5 });
    store.close();

    const indexFile = join(home, "brain", "index.sqlite");
    expect(existsSync(indexFile)).toBe(true);
    for (const suffix of ["", "-wal", "-shm"]) rmSync(indexFile + suffix, { force: true });
    const options = {
      home,
      resolveProjectRoot: () => null,
    };
    const fresh = createBrainStore(options);
    expect(fresh.search("needle", { scopes: [GLOBAL], limit: 5 })).toHaveLength(1);
    fresh.close();

    writeFileSync(indexFile, "this is not a sqlite database at all, just garbage bytes");
    for (const suffix of ["-wal", "-shm"]) rmSync(indexFile + suffix, { force: true });
    const damaged = createBrainStore(options);
    expect(damaged.search("needle", { scopes: [GLOBAL], limit: 5 })).toHaveLength(1);
    damaged.close();
  });
});

describe("a damaged index under a running store", () => {
  it("is rebuilt by reindex, as it is by search", () => {
    const { store, home, logs } = setup();
    store.write(g("n.md"), note("hello", "needle"));
    store.reindex(GLOBAL);
    const indexFile = join(home, "brain", "index.sqlite");
    // Everything into the main file, then every page but the first damaged, under the open store.
    const other = new DatabaseSync(indexFile);
    other.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    other.close();
    const damaged = readFileSync(indexFile);
    damaged.fill(0xff, 4096);
    writeFileSync(indexFile, damaged);
    store.write(g("m.md"), note("second", "needle"));
    expect(store.reindex(GLOBAL)).toMatchObject({ added: 2 });
    expect(logs.some((line) => /rebuilding the search index/.test(line))).toBe(true);
    expect(store.search("needle", { scopes: [GLOBAL], limit: 5 })).toHaveLength(2);
  });
});

describe("overviews", () => {
  it("lists memories with their kind and folders with their count, up the tree", () => {
    const { store } = setup();
    store.write(a("top.md"), note("The top", "", { kind: "decision" }));
    store.write(a("api/auth.md"), note("Auth uses tokens", "", { kind: "gotcha" }));
    store.write(a("api/v1/users.md"), note("Users table", "", { kind: "convention" }));

    const root = store.overview(a("")).body;
    expect(root).toContain("`api/` — 2 memories");
    expect(root).toContain("`top.md` (decision): The top");
    const api = store.overview(a("api")).body;
    expect(api).toContain("`v1/` — 1 memory");
    expect(api).toContain("`auth.md` (gotcha): Auth uses tokens");
    expect(store.overview(a("api/v1")).frontmatter.summary).toBe("1 memory, 0 folders");

    store.write(a("api/v1/orders.md"), note("Orders table"));
    expect(store.overview(a("")).body).toContain("`api/` — 3 memories");
    expect(store.overview(a("api")).body).toContain("`v1/` — 2 memories");

    store.remove(a("api/v1/users.md"));
    store.remove(a("api/v1/orders.md"));
    expect(store.overview(a("api")).body).not.toContain("v1/");
    expect(store.overview(a("")).body).toContain("`api/` — 1 memory");
  });

  it("is deterministic and rewrites only when the content changes", () => {
    const { store, brainA } = setup();
    store.write(a("one.md"), note("One"));
    const file = join(brainA, "_overview.md");
    const first = readFileSync(file, "utf8");
    store.write(a("one.md"), note("One"), {});
    expect(readFileSync(file, "utf8")).toBe(first);
    store.write(a("two.md"), note("Two"));
    expect(readFileSync(file, "utf8")).not.toBe(first);
    expect(readFileSync(file, "utf8")).toContain('tags: ["auto"]');
  });

  it("leaves an overview alone once someone has taken it over", () => {
    const { store, brainA } = setup();
    store.write(a("one.md"), note("One"));
    const file = join(brainA, "_overview.md");
    writeFileSync(file, '---\nsummary: "Hand written"\nkind: "note"\ntags: []\n---\n\nMine.\n');
    store.write(a("two.md"), note("Two"));
    expect(store.overview(a("")).body).toBe("Mine.\n");
    expect(store.read(a(""), 0).frontmatter.summary).toBe("Hand written");
  });

  it("never lets an overview be listed, searched or written as a memory", () => {
    const { store } = setup();
    store.write(g("one.md"), note("unique-needle"));
    expect(store.list(g("")).map((node) => node.name)).toEqual(["one.md"]);
    expect(store.search("overview", { scopes: [GLOBAL], limit: 5 })).toEqual([]);
    expect(codeOf(() => store.write(g("_overview.md"), note("x")))).toBe("bad_request");
  });
});

describe("trust", () => {
  it("is user for the global brain and repo for a project brain, on every result", () => {
    const { store } = setup();
    store.write(g("d/n.md"), note("shared", "walrus"));
    store.write(a("d/n.md"), note("shared", "walrus"));

    expect(store.read(g("d/n.md"), 2).trust).toBe("user");
    expect(store.read(a("d/n.md"), 2).trust).toBe("repo");
    expect(store.read(g("d/n.md"), 0).trust).toBe("user");
    expect(store.read(a("d"), 1).trust).toBe("repo");
    expect(store.overview(g("d")).trust).toBe("user");
    expect(store.overview(a("")).trust).toBe("repo");
    expect(store.list(g("")).map((node) => node.trust)).toEqual(["user"]);
    expect(store.list(a("d")).map((node) => node.trust)).toEqual(["repo"]);
    const hits = store.search("walrus", { scopes: [GLOBAL, A], limit: 5 });
    expect(Object.fromEntries(hits.map((hit) => [hit.uri, hit.trust]))).toEqual({
      [g("d/n.md")]: "user",
      [a("d/n.md")]: "repo",
    });
  });
});

describe.each([false, true])("pinned memories (noFts5: %s)", (noFts5) => {
  it("lists active pinned memories of the asked scopes, newest first", () => {
    const { store } = setup({ noFts5 });
    store.write(a("old.md"), note("Old pin", "", { pinned: true }));
    store.write(a("plain.md"), note("Not pinned"));
    store.write(a("proposed.md"), note("Proposed pin", "", { pinned: true, status: "proposed" }));
    store.write(a("archived.md"), note("Archived pin", "", { pinned: true }));
    store.archive(a("archived.md"));
    store.write(a("new.md"), note("New pin", "", { pinned: true }));
    store.write(g("pref.md"), note("Global pin", "", { pinned: true }));
    store.write(b("other.md"), note("Other project pin", "", { pinned: true }));

    const hits = store.pinned([A], 10);
    expect(hits.map((hit) => hit.summary)).toEqual(["New pin", "Old pin"]);
    expect(hits[0]).toMatchObject({ trust: "repo", uri: a("new.md"), status: "active" });
    expect(store.pinned([GLOBAL], 10).map((hit) => hit.summary)).toEqual(["Global pin"]);
    expect(store.pinned([GLOBAL, A], 10)).toHaveLength(3);
    expect(store.pinned([A], 1)).toHaveLength(1);
    expect(store.pinned([{ kind: "project", projectId: "unknown" }], 10)).toEqual([]);
  });

  it("follows edits: unpinning removes the memory from the list", () => {
    const { store } = setup({ noFts5 });
    const { updatedAt } = store.write(a("x.md"), note("Pinned", "", { pinned: true }));
    expect(store.pinned([A], 10)).toHaveLength(1);
    store.write(a("x.md"), note("Pinned", ""), { expectedUpdatedAt: updatedAt });
    expect(store.pinned([A], 10)).toEqual([]);
  });
});

describe("hasMemories", () => {
  it("answers without creating anything, and stops at the first memory", () => {
    const { store, rootA, home } = setup();
    expect(store.hasMemories(A)).toBe(false);
    expect(store.hasMemories(GLOBAL)).toBe(false);
    expect(existsSync(join(rootA, ".wooky"))).toBe(false);
    expect(existsSync(join(home, "brain"))).toBe(false);
    store.write(a("deep/er/x.md"), note("Deep"));
    expect(store.hasMemories(A)).toBe(true);
    expect(store.hasMemories(GLOBAL)).toBe(false);
    store.remove(a("deep/er/x.md"));
    expect(store.hasMemories(A)).toBe(false);
  });

  it("is false for folders and overviews alone, and refuses an unknown project", () => {
    const { store, brainA } = setup();
    mkdirSync(join(brainA, "empty", "folders"), { recursive: true });
    writeFileSync(join(brainA, "_overview.md"), "---\nsummary: x\n---\n");
    expect(store.hasMemories(A)).toBe(false);
    expect(codeOf(() => store.hasMemories({ kind: "project", projectId: "nope" }))).toBe(
      "not_found",
    );
  });

  it("gives up on a tree of empty folders past its entry budget instead of reading it all", () => {
    const { store, brainA } = setup();
    for (let index = 0; index < 1200; index += 1) {
      mkdirSync(join(brainA, `d${String(index).padStart(4, "0")}`), { recursive: true });
    }
    expect(store.hasMemories(A)).toBe(false);
  });
});

describe("refresh, for the prompt path", () => {
  const fresh = { lockWaitMs: 50, maxAgeMs: 5000 };

  it("syncs a scope once and remembers that it is fresh until a write or the time limit", () => {
    const syncs: string[] = [];
    let at = Date.now() + 60_000;
    const { store } = setup({ onSync: (key) => syncs.push(key), now: () => at });
    store.write(a("x.md"), note("Pinned", "", { pinned: true }));
    expect(store.refresh([GLOBAL, A], fresh)).toEqual([GLOBAL, A]);
    expect(syncs).toEqual(["global", "project:proj_a"]);
    store.refresh([GLOBAL, A], fresh);
    expect(syncs).toHaveLength(2);
    at += 6000;
    store.refresh([GLOBAL, A], fresh);
    expect(syncs).toHaveLength(4);
    store.write(a("y.md"), note("Another"));
    store.refresh([A], fresh);
    expect(syncs).toHaveLength(5);
    expect(store.pinned([A], 5, { skipSync: true }).map((hit) => hit.summary)).toEqual(["Pinned"]);
    expect(store.search("another", { scopes: [A], limit: 5, skipSync: true })).toHaveLength(1);
  });

  it("leaves out a scope it cannot open", () => {
    const { store } = setup();
    expect(store.refresh([{ kind: "project", projectId: "nope" }, GLOBAL], fresh)).toEqual([
      GLOBAL,
    ]);
  });

  it("does not index a walk that was told to stop, and indexes it on a later turn", () => {
    const { store, brainA } = setup();
    for (let index = 0; index < 300; index += 1) {
      const folder = join(brainA, `f${String(index).padStart(3, "0")}`);
      mkdirSync(folder, { recursive: true });
      writeFileSync(
        join(folder, "m.md"),
        `---\nsummary: "memory ${index}"\nkind: "note"\nstatus: "active"\npinned: true\nupdatedAt: "2026-01-01T00:00:00.000Z"\n---\n`,
      );
    }
    let checks = 0;
    const stop = () => ++checks > 10;
    store.refresh([A], { ...fresh, stop });
    expect(checks).toBeLessThan(60);
    expect(store.pinned([A], 5, { skipSync: true })).toEqual([]);
    expect(store.refresh([A], fresh)).toEqual([A]);
    expect(store.pinned([A], 5, { skipSync: true })).toHaveLength(5);
  });

  it("skips a scope when the index is locked and a write would be needed, without a long wait", () => {
    const { store, home } = setup({ indexBusyTimeoutMs: 2000 });
    store.write(a("x.md"), note("Pinned", "", { pinned: true }));
    expect(store.refresh([A], { lockWaitMs: 50 })).toEqual([A]);
    store.write(a("y.md"), note("New"));
    const other = new DatabaseSync(join(home, "brain", "index.sqlite"));
    other.exec("BEGIN IMMEDIATE");
    try {
      const started = performance.now();
      expect(store.refresh([A], { lockWaitMs: 50 })).toEqual([]);
      expect(performance.now() - started).toBeLessThan(1000);
    } finally {
      other.exec("ROLLBACK");
      other.close();
    }
    expect(store.refresh([A], { lockWaitMs: 50 })).toEqual([A]);
  });
});
