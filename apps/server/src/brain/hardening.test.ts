// wooky-allow child-process: mkfifo has no Node API and the test needs a real FIFO
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BrainScope, MemoryFrontmatterInput } from "@wooky/contracts";
import { ServiceError } from "../errors.ts";
import { BrainRoot, READ_FLAGS, createScanBudget, readRegularFile } from "./paths.ts";
import { createBrainStore, type BrainStore } from "./store.ts";

const A: BrainScope = { kind: "project", projectId: "proj_a" };
const g = (path: string) => `brain://global/${path}`;
const a = (path: string) => `brain://project/proj_a/${path}`;

const dirs: string[] = [];
const dir = (label: string) => {
  const path = mkdtempSync(join(tmpdir(), `wooky-hard-${label}-`));
  dirs.push(path);
  return path;
};
afterEach(() => {
  for (const path of dirs.splice(0)) {
    try {
      chmodSync(join(path, "brain", "global", "locked"), 0o755);
    } catch {
      // not there
    }
    rmSync(path, { recursive: true, force: true });
  }
});

const note = (
  summary: string,
  body = "",
): { frontmatter: MemoryFrontmatterInput; body: string } => ({
  frontmatter: { summary, kind: "note" },
  body,
});

function failure(run: () => unknown): Error | null {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  return null;
}
const codeOf = (run: () => unknown) => {
  const error = failure(run);
  return error instanceof ServiceError ? error.code : error === null ? "none" : "raw";
};

interface Fixture {
  store: BrainStore;
  home: string;
  rootA: string;
  brainA: string;
  logs: string[];
}
function setup(): Fixture {
  const home = dir("home");
  const rootA = dir("a");
  const logs: string[] = [];
  let tick = Date.UTC(2026, 0, 1);
  const store = createBrainStore({
    home,
    resolveProjectRoot: (id) => (id === "proj_a" ? rootA : null),
    clock: () => new Date((tick += 1000)).toISOString(),
    log: (message) => logs.push(message),
  });
  return { store, home, rootA, brainA: join(rootA, ".wooky", "brain"), logs };
}

const canLink = (() => {
  const base = dir("probe");
  try {
    symlinkSync(base, join(base, "link"), "dir");
    return true;
  } catch {
    return false;
  }
})();
const foldsCase = (() => {
  const base = dir("case-probe");
  writeFileSync(join(base, "Probe.txt"), "");
  return existsSync(join(base, "probe.txt"));
})();

describe("hostile frontmatter in a file on disk", () => {
  const hostile = (updatedAt: string) =>
    `---\nsummary: "hostile"\nkind: "note"\nupdatedAt: ${JSON.stringify(updatedAt)}\n---\n\nneedle body\n`;

  it.each(["10000-01-01", "+010000-01-01T00:00:00.000Z", "-000001-01-01T00:00:00Z"])(
    "reads, lists, searches and overwrites a file with updatedAt %s",
    (updatedAt) => {
      const { store, brainA, logs } = setup();
      store.write(a("seed.md"), note("seed"));
      writeFileSync(join(brainA, "bad.md"), hostile(updatedAt));

      expect(store.read(a("bad.md"), 2).frontmatter.summary).toBe("hostile");
      expect(store.list(a("")).map((node) => node.name)).toContain("bad.md");
      expect(store.search("needle", { scopes: [A], limit: 5 })).toHaveLength(1);
      const written = store.write(a("bad.md"), note("replaced"));
      expect(written.created).toBe(false);
      expect(store.read(a("bad.md"), 0).frontmatter.summary).toBe("replaced");
      expect(logs.join("\n")).not.toMatch(/ZodError|origin|pattern|invalid_format/);
    },
  );

  it("survives a file whose mtime is beyond year 9999", () => {
    const { store, brainA } = setup();
    store.write(a("seed.md"), note("seed"));
    const file = join(brainA, "far.md");
    writeFileSync(file, "# Far future\n");
    try {
      utimesSync(file, 3e11, 3e11);
    } catch {
      return;
    }
    expect(store.read(a("far.md"), 0).frontmatter.summary).toBe("Far future");
    expect(store.list(a("")).map((node) => node.name)).toContain("far.md");
    expect(store.search("future", { scopes: [A], limit: 5 })).toHaveLength(1);
  });

  it("never lets a non-ServiceError out of the store", () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const { store, home } = setup();
    store.write(g("locked/n.md"), note("inside"));
    chmodSync(join(home, "brain", "global", "locked"), 0o000);
    expect(codeOf(() => store.read(g("locked/n.md"), 2))).toBe("internal");
    expect(codeOf(() => store.list(g("locked")))).toBe("internal");
    expect(codeOf(() => store.write(g("locked/m.md"), note("more")))).not.toBe("raw");
    chmodSync(join(home, "brain", "global", "locked"), 0o755);
  });
});

describe("a project folder that overlaps Wooky's own data", () => {
  it("is refused when its brain is the global brain's folder (a project at dirname(home))", () => {
    const parent = dir("overlap");
    const home = join(parent, ".wooky");
    mkdirSync(home);
    const store = createBrainStore({
      home,
      resolveProjectRoot: (id) => (id === "proj_a" ? parent : null),
    });
    expect(codeOf(() => store.write(a("n.md"), note("x")))).toBe("forbidden");
    expect(codeOf(() => store.list(a("")))).toBe("forbidden");
    expect(codeOf(() => store.read(a("global/n.md"), 0))).toBe("forbidden");
    expect(store.search("x", { scopes: [A], limit: 5 })).toEqual([]);
    expect(existsSync(join(home, "brain", "global"))).toBe(false);
    store.write(g("ok.md"), note("global still works"));
  });

  it("is refused when the project is the data folder itself", () => {
    const home = dir("selfhome");
    const store = createBrainStore({
      home,
      resolveProjectRoot: (id) => (id === "proj_a" ? home : null),
    });
    expect(codeOf(() => store.write(a("n.md"), note("x")))).toBe("forbidden");
    expect(codeOf(() => store.list(a("")))).toBe("forbidden");
  });

  it("still allows a data folder inside the project, as dev does with .wooky-dev", () => {
    const project = dir("devproject");
    const store = createBrainStore({
      home: join(project, ".wooky-dev"),
      resolveProjectRoot: (id) => (id === "proj_a" ? project : null),
    });
    store.write(a("n.md"), note("project"));
    store.write(g("n.md"), note("global"));
    expect(store.read(a("n.md"), 0).frontmatter.summary).toBe("project");
  });
});

describe("one scan budget per operation", () => {
  function wideTree(folders: number, perFolder: number, extension: string): Fixture {
    const fixture = setup();
    fixture.store.write(a("seed.md"), note("seed"));
    for (let f = 0; f < folders; f += 1) {
      const folder = join(fixture.brainA, `f${String(f).padStart(3, "0")}`);
      mkdirSync(folder);
      for (let m = 0; m < perFolder; m += 1) {
        writeFileSync(join(folder, `m${String(m).padStart(4, "0")}.${extension}`), "x\n");
      }
    }
    return fixture;
  }

  it("is shared by every walk of the same budget", () => {
    const { rootA } = wideTree(40, 150, "md");
    const root = new BrainRoot(rootA, [".wooky", "brain"], () => {});
    const budget = createScanBudget();
    const first = root.scan([], budget);
    expect(first.truncated).toBe(true);
    expect(budget.used).toBeLessThanOrEqual(5000);
    expect(first.files.length).toBeLessThanOrEqual(5000);
    const second = root.scan([], budget);
    expect(second.files).toEqual([]);
    expect(second.truncated).toBe(true);
    expect(budget.used).toBeLessThanOrEqual(5000);
  });

  it("stops reading a folder when the budget runs out", () => {
    const { rootA } = wideTree(1, 300, "md");
    const root = new BrainRoot(rootA, [".wooky", "brain"], () => {});
    const budget = createScanBudget(50);
    const listing = root.children(["f000"], budget);
    expect(listing?.complete).toBe(false);
    expect(listing?.entries).toHaveLength(50);
    expect(budget.truncated).toBe(true);
  });

  it("list counts folders from one bounded walk and reports the ones it cut short", () => {
    const { store, logs } = wideTree(40, 150, "md");
    const folders = store.list(a("")).filter((node) => node.type === "folder");
    expect(folders).toHaveLength(40);
    const counted = folders.reduce((sum, node) => sum + (node.count ?? 0), 0);
    expect(counted).toBeLessThanOrEqual(5000);
    expect(folders.some((node) => node.capped === true)).toBe(true);
    expect(folders.at(-1)).toMatchObject({ count: 0, capped: true });
    expect(folders[0]).not.toHaveProperty("capped");
    expect(logs.some((line) => /stopped reading/.test(line))).toBe(true);
  });

  it("a write on a wide tree still succeeds, and the overview it could not finish is left alone", () => {
    const { store, brainA, logs } = wideTree(40, 150, "txt");
    const written = store.write(a("new/note.md"), note("fresh"));
    expect(written.created).toBe(true);
    expect(readFileSync(join(brainA, "new", "note.md"), "utf8")).toContain("fresh");
    expect(logs.some((line) => /stopped reading|too large/.test(line))).toBe(true);
  });

  it("refuses a write past the memory cap", () => {
    const { store } = wideTree(40, 150, "md");
    expect(codeOf(() => store.write(a("new.md"), note("one too many")))).toBe("bad_request");
  });

  it("reports a truncated reindex", () => {
    const { store } = wideTree(40, 150, "md");
    const report = store.reindex(A);
    expect(report.truncated).toBe(true);
    expect(report.added).toBeLessThanOrEqual(5000);
  });
});

describe.skipIf(!foldsCase)("a filesystem that ignores letter case", () => {
  it("does not read a differently-cased file, and refuses to write over it", () => {
    const { store, brainA } = setup();
    store.write(a("seed.md"), note("seed"));
    writeFileSync(join(brainA, "Hidden.md"), "do not touch\n");
    mkdirSync(join(brainA, "Lessons"));
    writeFileSync(join(brainA, "Lessons", "x.md"), "inside\n");

    expect(codeOf(() => store.read(a("hidden.md"), 2))).toBe("not_found");
    expect(codeOf(() => store.read(a("lessons/x.md"), 2))).toBe("not_found");
    expect(codeOf(() => store.write(a("hidden.md"), note("clobber")))).toBe("forbidden");
    expect(codeOf(() => store.write(a("lessons/y.md"), note("clobber")))).toBe("forbidden");
    expect(codeOf(() => store.remove(a("hidden.md")))).toBe("forbidden");
    expect(readFileSync(join(brainA, "Hidden.md"), "utf8")).toBe("do not touch\n");
    expect(readdirSync(brainA).filter((name) => name.toLowerCase() === "hidden.md")).toEqual([
      "Hidden.md",
    ]);
    expect(readdirSync(join(brainA, "Lessons"))).toEqual(["x.md"]);
  });
});

describe("hard links in a project brain", () => {
  it.skipIf(!canLink)("are not read, listed, indexed or overwritten", () => {
    const { store, brainA } = setup();
    store.write(a("seed.md"), note("seed"));
    const outside = join(dir("outside"), "outside.md");
    writeFileSync(outside, '---\nsummary: "outside data"\nkind: "note"\n---\n\nhardneedle\n');
    try {
      linkSync(outside, join(brainA, "linked.md"));
    } catch {
      return;
    }
    expect(codeOf(() => store.read(a("linked.md"), 2))).toBe("forbidden");
    expect(store.list(a("")).map((node) => node.name)).not.toContain("linked.md");
    expect(store.search("hardneedle", { scopes: [A], limit: 5 })).toEqual([]);
    expect(codeOf(() => store.write(a("linked.md"), note("overwrite")))).toBe("forbidden");
    expect(readFileSync(outside, "utf8")).toContain("outside data");
  });

  it.skipIf(!canLink)("are fine in the user's own global brain", () => {
    const { store, home } = setup();
    store.write(g("seed.md"), note("seed"));
    const other = join(dir("other"), "other.md");
    writeFileSync(other, "# Mine\n");
    linkSync(other, join(home, "brain", "global", "linked.md"));
    expect(store.read(g("linked.md"), 0).frontmatter.summary).toBe("Mine");
  });
});

describe("secrets never come back in an error", () => {
  const token = ["ghp_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join("");
  const write = (store: BrainStore, frontmatter: unknown, body = "") =>
    store.write(g("n.md"), { frontmatter: frontmatter as MemoryFrontmatterInput, body });

  it("does not echo an unrecognized key that holds a credential", () => {
    const { store, home } = setup();
    const error = failure(() => write(store, { summary: "s", kind: "note", [token]: "x" }));
    expect((error as ServiceError).code).toBe("bad_request");
    expect(error?.message).toMatch(/credential/);
    expect(error?.message).not.toContain(token);
    expect(existsSync(join(home, "brain", "global", "n.md"))).toBe(false);
  });

  it("does not echo an unrecognized value that holds a credential", () => {
    const { store } = setup();
    const error = failure(() => write(store, { summary: "s", kind: "note", leak: token }));
    expect(error?.message).toMatch(/GitHub token/);
    expect(error?.message).not.toContain(token);
    expect(error?.message).not.toContain("leak");
  });

  it("does not echo a rejected value, and names a known field when it is the culprit", () => {
    const { store } = setup();
    const error = failure(() => write(store, { summary: "s", kind: token }));
    expect(error?.message).toMatch(/the kind looks like it contains a credential/);
    expect(error?.message).not.toContain(token);
  });

  it("scans the body before it validates the frontmatter", () => {
    const { store } = setup();
    const error = failure(() => write(store, { nonsense: true }, `key ${token}`));
    expect(error?.message).toMatch(/body/);
    expect(error?.message).not.toContain(token);
  });

  it("never names an unrecognized key in a validation error either", () => {
    const { store } = setup();
    const error = failure(() => write(store, { summary: "s", kind: "note", zzunique_name: 1 }));
    expect(error?.message).toMatch(/not allowed/);
    expect(error?.message).not.toContain("zzunique_name");
  });
});

describe("a WOOKY_HOME reached through a symlink before it exists", () => {
  it.skipIf(!canLink)("still writes overviews on the first pass", () => {
    const real = dir("realhome");
    const alias = join(dir("aliasparent"), "alias");
    symlinkSync(real, alias, "dir");
    const logs: string[] = [];
    const store = createBrainStore({
      home: join(alias, "newhome"),
      resolveProjectRoot: () => null,
      log: (message) => logs.push(message),
    });
    store.write(g("lessons/n.md"), note("first write"));
    const global = join(real, "newhome", "brain", "global");
    expect(existsSync(join(global, "lessons", "_overview.md"))).toBe(true);
    expect(existsSync(join(global, "_overview.md"))).toBe(true);
    expect(logs).toEqual([]);
  });
});

describe("reads never block on a pipe", () => {
  it("opens without following links and without blocking", () => {
    expect(READ_FLAGS & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
    expect(READ_FLAGS & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
  });

  it.skipIf(process.platform === "win32")("refuses a FIFO that is not a regular file", () => {
    const base = dir("fifo");
    const fifo = join(base, "pipe.md");
    try {
      execFileSync("mkfifo", [fifo]);
    } catch {
      return;
    }
    // Holding a writer open keeps this test from ever blocking, even if the flag were lost.
    const writer = openSync(fifo, constants.O_RDWR);
    try {
      expect(codeOf(() => readRegularFile(fifo, "pipe.md"))).toBe("forbidden");
      const root = new BrainRoot(base, [], () => {});
      expect(codeOf(() => root.read(["pipe.md"]))).toBe("bad_request");
    } finally {
      closeSync(writer);
    }
  });
});
