import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createGitService, GitError, LIST_FILES_CAP } from "./service.ts";
import { createWorkspaceSearch } from "../workspace/search.ts";

const execFileAsync = promisify(execFile);
const git = createGitService();

const bases: string[] = [];
// Windows has no executable bit and forbids control characters in file names.
const onWindows = process.platform === "win32";

afterEach(async () => {
  while (bases.length > 0) {
    const base = bases.pop();
    if (base) await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

async function raw(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

/** Fresh repo at <base>/repo so `.wooky-worktrees` lands under <base> and is cleaned with it. */
async function makeRepo(withCommit = true): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "wooky-git-test-"));
  bases.push(base);
  const root = join(base, "repo");
  await mkdir(root);
  await raw(root, "init", "-q");
  await raw(root, "config", "user.email", "test@example.com");
  await raw(root, "config", "user.name", "Test");
  await raw(root, "config", "commit.gpgsign", "false");
  if (withCommit) {
    await writeFile(join(root, "seed.txt"), "seed\n");
    await raw(root, "add", "-A");
    await raw(root, "commit", "-qm", "init");
  }
  return root;
}

async function read(root: string, rel: string): Promise<string> {
  return readFile(join(root, rel), "utf8");
}

describe("isRepo", () => {
  it("is true inside a work tree and false outside one", async () => {
    const root = await makeRepo();
    expect(await git.isRepo(root)).toBe(true);

    const base = await mkdtemp(join(tmpdir(), "wooky-git-plain-"));
    bases.push(base);
    expect(await git.isRepo(base)).toBe(false);
  });
});

describe("ref safety", () => {
  it("refuses a ref outside refs/wooky/ for capture and restore", async () => {
    const root = await makeRepo();
    await expect(git.captureCheckpoint(root, "refs/heads/main")).rejects.toBeInstanceOf(GitError);
    await expect(git.captureCheckpoint(root, "refs/heads/main")).rejects.toThrow(/refs\/wooky\//);
    await expect(git.restoreCheckpoint(root, "refs/tags/x")).rejects.toThrow(/refs\/wooky\//);
  });

  it("still accepts a checkpoint stored under the legacy refs/age/ prefix", async () => {
    const root = await makeRepo();
    await writeFile(join(root, "a.txt"), "v1\n");
    const ref = "refs/age/checkpoints/t1/u1/before";
    expect(await git.captureCheckpoint(root, ref)).toBe(ref);
    await writeFile(join(root, "a.txt"), "v2\n");
    await git.restoreCheckpoint(root, ref);
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("v1\n");
  });
});

describe("capture / restore round-trip", () => {
  it("restores exact content across modify/add/delete, nested dirs and modes", async () => {
    const root = await makeRepo();
    await writeFile(join(root, "a.txt"), "v1\n");
    await mkdir(join(root, "dir"));
    await writeFile(join(root, "dir/nested.txt"), "nested v1\n");
    await writeFile(join(root, "keep.txt"), "keep\n");
    await writeFile(join(root, "script.sh"), "#!/bin/sh\necho hi\n");
    if (!onWindows) await execFileAsync("chmod", ["755", join(root, "script.sh")]);
    await writeFile(join(root, ".gitignore"), "ignored.log\n");
    await raw(root, "add", "-A");
    // Records 100755 even where the file system has no execute bit (core.fileMode=false).
    await raw(root, "update-index", "--chmod=+x", "script.sh");
    await raw(root, "commit", "-qm", "work");
    await writeFile(join(root, "ignored.log"), "ignore-original\n");

    const ref = "refs/wooky/checkpoints/t1/u1/before";
    expect(await git.captureCheckpoint(root, ref)).toBe(ref);
    // A capture on any host keeps the committed execute bit, so macOS/Linux peers do not lose it.
    expect(await raw(root, "ls-tree", ref, "script.sh")).toMatch(/^100755 blob /);

    await writeFile(join(root, "a.txt"), "v2 changed\n");
    await writeFile(join(root, "dir/nested.txt"), "nested v2\n");
    await writeFile(join(root, "added.txt"), "added\n");
    await rm(join(root, "keep.txt"));
    await mkdir(join(root, "deep/er"), { recursive: true });
    await writeFile(join(root, "deep/er/file.txt"), "deep\n");
    if (!onWindows) await execFileAsync("chmod", ["644", join(root, "script.sh")]);
    await writeFile(join(root, "ignored.log"), "ignore-mutated\n");

    await git.restoreCheckpoint(root, ref);

    expect(await read(root, "a.txt")).toBe("v1\n");
    expect(await read(root, "dir/nested.txt")).toBe("nested v1\n");
    expect(await read(root, "keep.txt")).toBe("keep\n");
    expect(existsSync(join(root, "added.txt"))).toBe(false);
    expect(existsSync(join(root, "deep/er/file.txt"))).toBe(false);
    expect(existsSync(join(root, "deep"))).toBe(false);
    expect(await read(root, "ignored.log")).toBe("ignore-mutated\n");
    const mode = (await stat(join(root, "script.sh"))).mode;
    // Windows has no execute bit on disk; the tree entry above is what carries it there.
    expect(onWindows || (mode & 0o111) !== 0).toBe(true);
  });
});

describe("capture isolation", () => {
  it("leaves the user index, HEAD and branches untouched; staged changes survive", async () => {
    const root = await makeRepo();
    await writeFile(join(root, "seed.txt"), "seed edited\n");
    await writeFile(join(root, "staged-new.txt"), "staged\n");
    await raw(root, "add", "-A");

    const statusBefore = await raw(root, "status", "--porcelain=v1");
    const cachedBefore = await raw(root, "diff", "--cached");
    const headBefore = await raw(root, "rev-parse", "HEAD");
    const branchesBefore = await raw(root, "for-each-ref", "refs/heads");

    await git.captureCheckpoint(root, "refs/wooky/checkpoints/t/u/before");

    expect(await raw(root, "status", "--porcelain=v1")).toBe(statusBefore);
    expect(await raw(root, "diff", "--cached")).toBe(cachedBefore);
    expect(await raw(root, "rev-parse", "HEAD")).toBe(headBefore);
    expect(await raw(root, "for-each-ref", "refs/heads")).toBe(branchesBefore);
  });
});

describe("empty repo", () => {
  it("captures and diffs a repo with no commits", async () => {
    const root = await makeRepo(false);
    await writeFile(join(root, "file.txt"), "a\n");

    const ref = "refs/wooky/checkpoints/t/u/before";
    expect(await git.captureCheckpoint(root, ref)).toBe(ref);
    expect((await raw(root, "rev-parse", ref)).trim()).toMatch(/^[0-9a-f]{40}$/);

    await writeFile(join(root, "file2.txt"), "b\n");
    const diffs = await git.diff(root, ref, null);
    expect(diffs.map((d) => d.path)).toContain("file2.txt");
    expect(diffs.find((d) => d.path === "file2.txt")?.status).toBe("added");
  });
});

describe("diff", () => {
  it("reports statuses, numstat counts, renames and binaries between checkpoints", async () => {
    const root = await makeRepo();
    await writeFile(join(root, "mod.txt"), "l1\nl2\n");
    await writeFile(join(root, "del.txt"), "bye\n");
    await writeFile(join(root, "ren.txt"), "rename me content\n");
    await raw(root, "add", "-A");
    await raw(root, "commit", "-qm", "base");

    const from = "refs/wooky/checkpoints/t/a/before";
    await git.captureCheckpoint(root, from);

    await writeFile(join(root, "mod.txt"), "l1\nCHANGED\nl2\n");
    await rm(join(root, "del.txt"));
    await raw(root, "mv", "ren.txt", "renamed.txt");
    await writeFile(join(root, "new.txt"), "new file\n");
    await writeFile(join(root, "bin.dat"), Buffer.from([0, 1, 2, 0, 3, 255, 0]));
    await raw(root, "add", "-A");

    const to = "refs/wooky/checkpoints/t/b/after";
    await git.captureCheckpoint(root, to);

    const diffs = await git.diff(root, from, to);
    const byPath = new Map(diffs.map((d) => [d.path, d]));

    expect(diffs.map((d) => d.path)).toEqual([...diffs.map((d) => d.path)].sort());

    const mod = byPath.get("mod.txt");
    expect(mod?.status).toBe("modified");
    expect(mod?.additions).toBe(1);
    expect(mod?.deletions).toBe(0);
    expect(mod?.patch).toContain("+CHANGED");

    expect(byPath.get("del.txt")?.status).toBe("deleted");
    expect(byPath.get("new.txt")?.status).toBe("added");

    const renamed = byPath.get("renamed.txt");
    expect(renamed?.status).toBe("renamed");
    expect(renamed?.oldPath).toBe("ren.txt");

    const bin = byPath.get("bin.dat");
    expect(bin?.status).toBe("added");
    expect(bin?.patch).toBeUndefined();
    expect(bin?.additions).toBe(0);
    expect(bin?.deletions).toBe(0);
  });

  it("diffs the live working tree when `to` is null and writes no refs", async () => {
    const root = await makeRepo();
    await writeFile(join(root, "mod.txt"), "one\n");
    await raw(root, "add", "-A");
    await raw(root, "commit", "-qm", "base");

    const from = "refs/wooky/checkpoints/t/a/before";
    await git.captureCheckpoint(root, from);

    await writeFile(join(root, "mod.txt"), "one\ntwo\n");
    await writeFile(join(root, "unsaved.txt"), "unsaved\n");

    const refsBefore = await raw(root, "for-each-ref");
    const diffs = await git.diff(root, from, null);
    const refsAfter = await raw(root, "for-each-ref");

    expect(refsAfter).toBe(refsBefore);
    const byPath = new Map(diffs.map((d) => [d.path, d]));
    expect(byPath.get("mod.txt")?.status).toBe("modified");
    expect(byPath.get("unsaved.txt")?.status).toBe("added");
  });

  it("caps a large patch at the limit with a truncation notice", async () => {
    const root = await makeRepo();
    const from = "refs/wooky/checkpoints/t/a/before";
    await git.captureCheckpoint(root, from);

    const big = "abcdefghij\n".repeat(30_000);
    await writeFile(join(root, "big.txt"), big);
    const to = "refs/wooky/checkpoints/t/b/after";
    await git.captureCheckpoint(root, to);

    const diffs = await git.diff(root, from, to);
    const patch = diffs.find((d) => d.path === "big.txt")?.patch ?? "";
    expect(patch.endsWith("… diff truncated\n")).toBe(true);
    expect(Buffer.byteLength(patch, "utf8")).toBeLessThanOrEqual(200 * 1024 + 64);
  });
});

describe("worktrees", () => {
  it("creates and removes a worktree, keeping the branch and being idempotent", async () => {
    const root = await makeRepo();
    const wt = await git.createWorktree(root, "thread-1");

    expect(wt.branch).toBe("wooky/thread-1");
    expect(wt.path).toBe(join(dirname(root), ".wooky-worktrees", basename(root), "thread-1"));
    expect(existsSync(wt.path)).toBe(true);
    expect(await raw(root, "branch", "--list", "wooky/thread-1")).toContain("wooky/thread-1");

    await git.removeWorktree(root, wt);
    expect(existsSync(wt.path)).toBe(false);
    expect(await raw(root, "branch", "--list", "wooky/thread-1")).toContain("wooky/thread-1");

    await expect(git.removeWorktree(root, wt)).resolves.toBeUndefined();
  });

  it("still summarises a branch created under the legacy age/ prefix", async () => {
    const root = await makeRepo();
    const start = (await raw(root, "rev-parse", "--abbrev-ref", "HEAD")).trim();
    await raw(root, "checkout", "-b", "age/legacy");
    await writeFile(join(root, "legacy.txt"), "old\n");
    await raw(root, "add", "-A");
    await raw(root, "commit", "-qm", "legacy branch");
    await raw(root, "checkout", start);
    const summary = await git.diffBranchStat(root, "age/legacy");
    expect(summary).toMatchObject({ files: 1, additions: 1 });
  });

  it("refuses isolation in a repo with no commits", async () => {
    const root = await makeRepo(false);
    await expect(git.createWorktree(root, "thread-x")).rejects.toThrow(/at least one commit/);
  });
});

describe("concurrency", () => {
  it("serializes five concurrent captures on the same repo", async () => {
    const root = await makeRepo();
    await writeFile(join(root, "a.txt"), "content\n");

    const refs = Array.from({ length: 5 }, (_, i) => `refs/wooky/concurrent/${i}`);
    const results = await Promise.all(refs.map((ref) => git.captureCheckpoint(root, ref)));
    expect(results).toEqual(refs);

    for (const ref of refs) {
      expect((await raw(root, "rev-parse", ref)).trim()).toMatch(/^[0-9a-f]{40}$/);
    }
  });
});

describe("restore best-effort over a nested repo (fix 1)", () => {
  it("removes every deletable file and never descends into a nested repo", async () => {
    const root = await makeRepo();
    const ref = "refs/wooky/checkpoints/t/u/before";
    await git.captureCheckpoint(root, ref);

    await writeFile(join(root, "del1.txt"), "x\n");
    await mkdir(join(root, "sub"));
    await writeFile(join(root, "sub/del2.txt"), "y\n");
    await mkdir(join(root, "nested"));
    await raw(join(root, "nested"), "init", "-q");
    await writeFile(join(root, "nested/inner.txt"), "keep\n");

    await git.restoreCheckpoint(root, ref);

    expect(existsSync(join(root, "del1.txt"))).toBe(false);
    expect(existsSync(join(root, "sub/del2.txt"))).toBe(false);
    expect(existsSync(join(root, "sub"))).toBe(false);
    expect(existsSync(join(root, "nested/inner.txt"))).toBe(true);
    expect(existsSync(join(root, "nested/.git"))).toBe(true);
  });
});

describe("restore and the real index (fix 2)", () => {
  it("drops deleted paths from the index but leaves a staged survivor untouched", async () => {
    const root = await makeRepo();
    const ref = "refs/wooky/checkpoints/t/u/before";
    await git.captureCheckpoint(root, ref);

    await writeFile(join(root, "agent-new.txt"), "new\n");
    await writeFile(join(root, "seed.txt"), "seed staged edit\n");
    await raw(root, "add", "-A");

    await git.restoreCheckpoint(root, ref);

    expect(existsSync(join(root, "agent-new.txt"))).toBe(false);
    const status = await raw(root, "status", "--porcelain");
    expect(status).not.toMatch(/agent-new\.txt/);

    const cached = await raw(root, "diff", "--cached", "--name-only");
    expect(cached).toMatch(/seed\.txt/);
    expect(cached).not.toMatch(/agent-new\.txt/);
  });
});

describe("env hygiene (fix 3)", () => {
  it("ignores a hostile GIT_EXTERNAL_DIFF in the environment", async () => {
    const root = await makeRepo();
    const from = "refs/wooky/checkpoints/t/a/before";
    await git.captureCheckpoint(root, from);
    await writeFile(join(root, "hello.txt"), "hello\n");
    const to = "refs/wooky/checkpoints/t/b/after";
    await git.captureCheckpoint(root, to);

    const base = await mkdtemp(join(tmpdir(), "wooky-git-ext-"));
    bases.push(base);
    const differ = join(base, "fail-differ.sh");
    await writeFile(differ, "#!/bin/sh\nexit 1\n");
    await chmod(differ, 0o755);

    const prev = process.env.GIT_EXTERNAL_DIFF;
    process.env.GIT_EXTERNAL_DIFF = differ;
    try {
      const diffs = await git.diff(root, from, to);
      const hello = diffs.find((d) => d.path === "hello.txt");
      expect(hello?.status).toBe("added");
      expect(hello?.patch).toContain("+hello");
    } finally {
      if (prev === undefined) delete process.env.GIT_EXTERNAL_DIFF;
      else process.env.GIT_EXTERNAL_DIFF = prev;
    }
  });
});

describe("worktree re-creation (fix 5)", () => {
  it("re-adds a worktree on an existing branch after removal", async () => {
    const root = await makeRepo();
    const wt1 = await git.createWorktree(root, "re");
    await git.removeWorktree(root, wt1);
    expect(await raw(root, "branch", "--list", "wooky/re")).toContain("wooky/re");

    const wt2 = await git.createWorktree(root, "re");
    expect(existsSync(wt2.path)).toBe(true);
    expect(wt2.branch).toBe("wooky/re");
  });
});

describe("patch truncation on a code-point boundary (fix 7)", () => {
  it("never emits U+FFFD when a multibyte char straddles the limit", async () => {
    const root = await makeRepo();
    const from = "refs/wooky/checkpoints/t/a/before";
    await git.captureCheckpoint(root, from);

    // The patch header length is constant for a single-line add of this filename, so measure
    // where the content begins from a tiny probe and pad so the 200 KB cut lands mid-character.
    await writeFile(join(root, "big.txt"), "中");
    const probe = "refs/wooky/checkpoints/t/probe/after";
    await git.captureCheckpoint(root, probe);
    const full = await raw(
      root,
      "-c",
      "core.quotePath=false",
      "diff",
      "-M",
      "--no-ext-diff",
      "--no-textconv",
      from,
      probe,
    );
    const marker = Buffer.from("@@\n+", "utf8");
    const contentStart = Buffer.from(full, "utf8").indexOf(marker) + marker.length;
    const pad = (200 * 1024 - contentStart) % 3 === 0 ? 1 : 0;

    await writeFile(join(root, "big.txt"), "a".repeat(pad) + "中".repeat(100_000));
    const to = "refs/wooky/checkpoints/t/b/after";
    await git.captureCheckpoint(root, to);

    const diffs = await git.diff(root, from, to);
    const patch = diffs.find((d) => d.path === "big.txt")?.patch ?? "";
    expect(patch).not.toContain("\uFFFD");
    expect(patch.endsWith("… diff truncated\n")).toBe(true);
    expect(Buffer.byteLength(patch, "utf8")).toBeLessThanOrEqual(200 * 1024 + 64);
  });
});

describe("patch parsing by position (fix 8)", () => {
  it.skipIf(onWindows)("produces a patch for a filename containing a newline", async () => {
    const root = await makeRepo();
    const from = "refs/wooky/checkpoints/t/a/before";
    await git.captureCheckpoint(root, from);

    const weird = "we\nird.txt";
    await writeFile(join(root, weird), "weird content\n");
    await writeFile(join(root, "plain.txt"), "plain content\n");
    const to = "refs/wooky/checkpoints/t/b/after";
    await git.captureCheckpoint(root, to);

    const diffs = await git.diff(root, from, to);
    const byPath = new Map(diffs.map((d) => [d.path, d]));
    expect(byPath.get(weird)?.status).toBe("added");
    expect(byPath.get(weird)?.patch).toContain("+weird content");
    expect(byPath.get("plain.txt")?.patch).toContain("+plain content");
  });
});

describe("ref safety, hardened (fix 10)", () => {
  // git itself refuses most bad names at update-ref/read-tree; the guard must reject them up
  // front, before any git mutation, which shows up as a GitError from the check-ref-format step.
  it("rejects traversal, double-slash, trailing slash, .lock and dot-component refs early", async () => {
    const root = await makeRepo();
    const bad = [
      "refs/wooky/../heads/main",
      "refs/wooky/foo//bar",
      "refs/wooky/foo.lock",
      "refs/wooky/foo/",
      "refs/wooky/.hidden/x",
    ];
    for (const ref of bad) {
      await expect(git.captureCheckpoint(root, ref)).rejects.toMatchObject({
        argv: ["check-ref-format", ref],
      });
    }
    await expect(git.restoreCheckpoint(root, "refs/wooky/../heads/main")).rejects.toMatchObject({
      argv: ["check-ref-format", "refs/wooky/../heads/main"],
    });
    await expect(git.captureCheckpoint(root, "refs/wooky/foo/")).rejects.toThrow(/refs\/wooky\//);
  });
});

const FAKE_GIT = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
let i = 0;
while (args[i] === "-c") i += 2;
const cmd = args[i];
const sub = args.slice(i + 1);
const SHA = "1111111111111111111111111111111111111111";
const w = (s) => process.stdout.write(s);
if (cmd === "check-ref-format") process.exit(0);
if (cmd === "rev-parse") {
  if (sub.includes("--show-toplevel")) { w(process.cwd() + "\\n"); process.exit(0); }
  if (sub.includes("--git-common-dir")) {
    if (path.basename(process.cwd()) === "wt") w(process.env.FAKE_MAINLINK + "/.git\\n");
    else w(".git\\n");
    process.exit(0);
  }
  if (sub.includes("--verify")) process.exit(0);
  w(SHA + "\\n"); process.exit(0);
}
if (cmd === "write-tree") {
  const start = Date.now();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
  fs.appendFileSync(process.env.FAKE_REC, start + " " + Date.now() + "\\n");
  w(SHA + "\\n"); process.exit(0);
}
if (cmd === "commit-tree") { w(SHA + "\\n"); process.exit(0); }
process.exit(0);
`;

async function setupFakeRepo(): Promise<{
  base: string;
  bin: string;
  rec: string;
  mainPath: string;
  wtPath: string;
}> {
  const base = await realpath(await mkdtemp(join(tmpdir(), "wooky-git-fake-")));
  bases.push(base);
  await mkdir(join(base, "main", ".git"), { recursive: true });
  await mkdir(join(base, "wt"), { recursive: true });
  await symlink(join(base, "main"), join(base, "mainlink"));
  const bin = join(base, "fakegit.cjs");
  await writeFile(bin, FAKE_GIT);
  return {
    base,
    bin,
    rec: join(base, "rec.log"),
    mainPath: join(base, "main"),
    wtPath: join(base, "wt"),
  };
}

async function readIntervals(file: string): Promise<{ start: number; end: number }[]> {
  const text = await readFile(file, "utf8");
  return text
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => {
      const [s, e] = l.split(" ").map(Number);
      return { start: s ?? 0, end: e ?? 0 };
    });
}

function expectNoOverlap(intervals: { start: number; end: number }[]): void {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const overlaps = sorted.filter(
    (cur, i) => i > 0 && cur.start < (sorted[i - 1]?.end ?? -Infinity),
  );
  expect(overlaps).toEqual([]);
}

describe("serialization under the repo lock (fix 9)", () => {
  it("never overlaps two mutating operations on one repo", async () => {
    const { bin, rec, mainPath } = await setupFakeRepo();
    const fake = createGitService({ gitBin: process.execPath, gitPrefixArgs: [bin] });
    const prev = process.env.FAKE_REC;
    process.env.FAKE_REC = rec;
    try {
      await Promise.all(
        Array.from({ length: 5 }, (_, i) => fake.captureCheckpoint(mainPath, `refs/wooky/c/${i}`)),
      );
      const intervals = await readIntervals(rec);
      expect(intervals.length).toBe(5);
      expectNoOverlap(intervals);
    } finally {
      if (prev === undefined) delete process.env.FAKE_REC;
      else process.env.FAKE_REC = prev;
    }
  });
});

describe("one lock key through symlinked paths (fix 4)", () => {
  it("serializes main-repo and linked-worktree operations that realpath to one common dir", async () => {
    const { base, bin, rec, mainPath, wtPath } = await setupFakeRepo();
    const fake = createGitService({ gitBin: process.execPath, gitPrefixArgs: [bin] });
    const prevRec = process.env.FAKE_REC;
    const prevLink = process.env.FAKE_MAINLINK;
    process.env.FAKE_REC = rec;
    process.env.FAKE_MAINLINK = join(base, "mainlink");
    try {
      await Promise.all([
        fake.captureCheckpoint(mainPath, "refs/wooky/m/0"),
        fake.captureCheckpoint(wtPath, "refs/wooky/w/0"),
        fake.captureCheckpoint(mainPath, "refs/wooky/m/1"),
        fake.captureCheckpoint(wtPath, "refs/wooky/w/1"),
        fake.captureCheckpoint(mainPath, "refs/wooky/m/2"),
        fake.captureCheckpoint(wtPath, "refs/wooky/w/2"),
      ]);
      const intervals = await readIntervals(rec);
      expect(intervals.length).toBe(6);
      expectNoOverlap(intervals);
    } finally {
      if (prevRec === undefined) delete process.env.FAKE_REC;
      else process.env.FAKE_REC = prevRec;
      if (prevLink === undefined) delete process.env.FAKE_MAINLINK;
      else process.env.FAKE_MAINLINK = prevLink;
    }
  });
});

const SLOW_GIT = `#!/usr/bin/env node
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
process.exit(0);
`;

const HUGE_GIT = `#!/usr/bin/env node
process.stdout.write(Buffer.alloc(256 * 1024, 65));
`;

describe("bounded run (fix 6)", () => {
  it("kills a git that exceeds the spawn timeout", async () => {
    const base = await mkdtemp(join(tmpdir(), "wooky-git-slow-"));
    bases.push(base);
    const bin = join(base, "slow.cjs");
    await writeFile(bin, SLOW_GIT);
    const fake = createGitService({
      gitBin: process.execPath,
      gitPrefixArgs: [bin],
      timeoutMs: 150,
    });
    await expect(fake.captureCheckpoint(base, "refs/wooky/x/y")).rejects.toThrow(/timed out/);
  });

  it("kills a git that floods stdout past the cap", async () => {
    const base = await mkdtemp(join(tmpdir(), "wooky-git-huge-"));
    bases.push(base);
    const bin = join(base, "huge.cjs");
    await writeFile(bin, HUGE_GIT);
    const fake = createGitService({
      gitBin: process.execPath,
      gitPrefixArgs: [bin],
      maxStdoutBytes: 1024,
    });
    await expect(fake.captureCheckpoint(base, "refs/wooky/x/y")).rejects.toThrow(/exceeded cap/);
  });
});

async function putFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, body] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), body);
  }
}

describe("listFiles", () => {
  it("lists tracked and untracked files but not ignored ones", async () => {
    const root = await makeRepo(false);
    await putFiles(root, {
      ".gitignore": "dist/\n",
      "a.ts": "",
      "src/b.ts": "",
      "dist/out.js": "",
    });
    await raw(root, "add", "a.ts");
    expect((await git.listFiles(root)).sort()).toEqual([".gitignore", "a.ts", "src/b.ts"]);
  });

  it("falls back to a bounded walk outside a repo", async () => {
    const root = await mkdtemp(join(tmpdir(), "wooky-git-plain-"));
    bases.push(root);
    await putFiles(root, {
      "x.txt": "",
      "deep/y.txt": "",
      "node_modules/z.js": "",
      ".hidden/w.txt": "",
    });
    expect((await git.listFiles(root)).sort()).toEqual(["deep/y.txt", "x.txt"]);
  });

  it("caps the listing in a repo and in the fallback walk", async () => {
    const files = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}.txt`, ""]));
    const capped = createGitService({ listFilesCap: 10 });
    const repo = await makeRepo(false);
    await putFiles(repo, files);
    expect(await capped.listFiles(repo)).toHaveLength(10);
    const plain = await mkdtemp(join(tmpdir(), "wooky-git-plain-"));
    bases.push(plain);
    await putFiles(plain, files);
    expect(await capped.listFiles(plain)).toHaveLength(10);
    expect(LIST_FILES_CAP).toBe(50_000);
  });

  it("feeds workspace search with real repo files, skipping ignored ones", async () => {
    const root = await makeRepo(false);
    await putFiles(root, { ".gitignore": "build/\n", "src/main.ts": "", "build/x.js": "" });
    const search = createWorkspaceSearch({
      model: () =>
        ({
          projects: { p1: { id: "p1", root } },
          threads: { t1: { id: "t1", projectId: "p1" } },
        }) as never,
      listFiles: (cwd) => git.listFiles(cwd),
    });
    expect(await search.search({ threadId: "t1", query: "main" })).toEqual([
      { path: "src/main.ts", kind: "file" },
    ]);
    expect(await search.search({ threadId: "t1", query: "x.js" })).toEqual([]);
  });
});

describe("commitWorktreeChanges", () => {
  it("commits uncommitted worker edits so preview and diff stat see them", async () => {
    const root = await makeRepo();
    const wt = await git.createWorktree(root, "uncommitted");
    await writeFile(join(wt.path, "worker-only.txt"), "from worker\n");

    await git.commitWorktreeChanges(root, wt, "Wooky: Worker title");
    const preview = await git.mergePreview(root, wt, "Wooky: Worker title");
    expect(preview.files.some((file) => file.path === "worker-only.txt")).toBe(true);

    const branchStat = await git.diffBranchStat(root, wt.branch);
    expect(branchStat?.files).toBeGreaterThan(0);

    const merged = await git.mergeWorktree(root, wt, "squash", "Worker title", "Land worker");
    expect(merged.ok).toBe(true);
    if (!merged.ok) throw new Error("expected squash merge");
    expect(existsSync(join(root, "worker-only.txt"))).toBe(true);
  });

  it("is a no-op when the worktree is clean", async () => {
    const root = await makeRepo();
    const wt = await git.createWorktree(root, "clean-wt");
    await expect(git.commitWorktreeChanges(root, wt, "Wooky: x")).resolves.toBeUndefined();
  });
});

describe("merge worktree", () => {
  it("does not treat untracked files in the project root as dirty", async () => {
    const root = await makeRepo();
    const wt = await git.createWorktree(root, "with-untracked-root");
    await writeFile(join(wt.path, "land.txt"), "land\n");
    await git.commitWorktreeChanges(root, wt, "Wooky: land");

    await writeFile(join(root, "stray-untracked.txt"), "stray\n");
    const merged = await git.mergeWorktree(root, wt, "squash", "land", "squash land");
    expect(merged.ok).toBe(true);
    if (!merged.ok) throw new Error("expected merge despite untracked root file");
    expect(existsSync(join(root, "land.txt"))).toBe(true);
  });

  it("merges a worktree branch with --no-ff and leaves a dirty root alone", async () => {
    const root = await makeRepo();
    const wt = await git.createWorktree(root, "merge-me");
    await writeFile(join(wt.path, "fleet.txt"), "fleet\n");
    await raw(wt.path, "add", "fleet.txt");
    await raw(wt.path, "commit", "-qm", "worker change");

    const preview = await git.mergePreview(root, wt);
    expect(preview.ahead).toBeGreaterThan(0);
    expect(preview.files.some((file) => file.path === "fleet.txt")).toBe(true);

    await writeFile(join(root, "seed.txt"), "dirty tracked\n");
    await raw(root, "add", "seed.txt");
    const blocked = await git.mergeWorktree(root, wt, "merge", "Worker");
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error("expected dirty refusal");
    expect(blocked.kind).toBe("dirty");

    await raw(root, "reset", "--hard");
    const merged = await git.mergeWorktree(root, wt, "merge", "Worker");
    expect(merged.ok).toBe(true);
    if (!merged.ok) throw new Error("expected merge");
    expect(existsSync(join(root, "fleet.txt"))).toBe(true);
    expect(await raw(root, "log", "-1", "--oneline")).toMatch(/Merge/);
  });

  it("squash-merges and reports conflicts without leaving the repo mid-merge", async () => {
    const root = await makeRepo();
    await writeFile(join(root, "shared.txt"), "base\n");
    await raw(root, "add", "shared.txt");
    await raw(root, "commit", "-qm", "base");

    const wt = await git.createWorktree(root, "squash-me");
    await writeFile(join(wt.path, "shared.txt"), "worker\n");
    await raw(wt.path, "add", "shared.txt");
    await raw(wt.path, "commit", "-qm", "worker");

    await writeFile(join(root, "shared.txt"), "main line\n");
    await raw(root, "add", "shared.txt");
    await raw(root, "commit", "-qm", "main diverged");

    const conflict = await git.mergeWorktree(root, wt, "merge", "Worker");
    expect(conflict.ok).toBe(false);
    if (conflict.ok) throw new Error("expected conflict");
    expect(conflict.kind).toBe("conflict");
    expect(await raw(root, "status", "--porcelain")).toBe("");

    const clean = await makeRepo();
    const cleanWt = await git.createWorktree(clean, "only-worker");
    await writeFile(join(cleanWt.path, "only.txt"), "one\n");
    await raw(cleanWt.path, "add", "only.txt");
    await raw(cleanWt.path, "commit", "-qm", "only");
    const squashed = await git.mergeWorktree(clean, cleanWt, "squash", "title", "Squash worker");
    expect(squashed.ok).toBe(true);
    if (!squashed.ok) throw new Error("expected squash");
    expect(existsSync(join(clean, "only.txt"))).toBe(true);
    expect((await raw(clean, "log", "-1", "--pretty=%s")).trim()).toBe("Squash worker");
  });
});
