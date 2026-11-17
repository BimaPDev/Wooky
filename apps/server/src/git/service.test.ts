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
import { createGitService, GitError } from "./service.ts";

const execFileAsync = promisify(execFile);
const git = createGitService();

const bases: string[] = [];

afterEach(async () => {
  while (bases.length > 0) {
    const base = bases.pop();
    if (base) await rm(base, { recursive: true, force: true });
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

/** Fresh repo at <base>/repo so `.age-worktrees` lands under <base> and is cleaned with it. */
async function makeRepo(withCommit = true): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "age-git-test-"));
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

    const base = await mkdtemp(join(tmpdir(), "age-git-plain-"));
    bases.push(base);
    expect(await git.isRepo(base)).toBe(false);
  });
});

describe("ref safety", () => {
  it("refuses a ref outside refs/age/ for capture and restore", async () => {
    const root = await makeRepo();
    await expect(git.captureCheckpoint(root, "refs/heads/main")).rejects.toBeInstanceOf(GitError);
    await expect(git.captureCheckpoint(root, "refs/heads/main")).rejects.toThrow(/refs\/age\//);
    await expect(git.restoreCheckpoint(root, "refs/tags/x")).rejects.toThrow(/refs\/age\//);
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
    await execFileAsync("chmod", ["755", join(root, "script.sh")]);
    await writeFile(join(root, ".gitignore"), "ignored.log\n");
    await raw(root, "add", "-A");
    await raw(root, "commit", "-qm", "work");
    await writeFile(join(root, "ignored.log"), "ignore-original\n");

    const ref = "refs/age/checkpoints/t1/u1/before";
    expect(await git.captureCheckpoint(root, ref)).toBe(ref);

    await writeFile(join(root, "a.txt"), "v2 changed\n");
    await writeFile(join(root, "dir/nested.txt"), "nested v2\n");
    await writeFile(join(root, "added.txt"), "added\n");
    await rm(join(root, "keep.txt"));
    await mkdir(join(root, "deep/er"), { recursive: true });
    await writeFile(join(root, "deep/er/file.txt"), "deep\n");
    await execFileAsync("chmod", ["644", join(root, "script.sh")]);
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
    expect(mode & 0o111).not.toBe(0);
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

    await git.captureCheckpoint(root, "refs/age/checkpoints/t/u/before");

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

    const ref = "refs/age/checkpoints/t/u/before";
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

    const from = "refs/age/checkpoints/t/a/before";
    await git.captureCheckpoint(root, from);

    await writeFile(join(root, "mod.txt"), "l1\nCHANGED\nl2\n");
    await rm(join(root, "del.txt"));
    await raw(root, "mv", "ren.txt", "renamed.txt");
    await writeFile(join(root, "new.txt"), "new file\n");
    await writeFile(join(root, "bin.dat"), Buffer.from([0, 1, 2, 0, 3, 255, 0]));
    await raw(root, "add", "-A");

    const to = "refs/age/checkpoints/t/b/after";
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

    const from = "refs/age/checkpoints/t/a/before";
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
    const from = "refs/age/checkpoints/t/a/before";
    await git.captureCheckpoint(root, from);

    const big = "abcdefghij\n".repeat(30_000);
    await writeFile(join(root, "big.txt"), big);
    const to = "refs/age/checkpoints/t/b/after";
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

    expect(wt.branch).toBe("age/thread-1");
    expect(wt.path).toBe(join(dirname(root), ".age-worktrees", basename(root), "thread-1"));
    expect(existsSync(wt.path)).toBe(true);
    expect(await raw(root, "branch", "--list", "age/thread-1")).toContain("age/thread-1");

    await git.removeWorktree(root, wt);
    expect(existsSync(wt.path)).toBe(false);
    expect(await raw(root, "branch", "--list", "age/thread-1")).toContain("age/thread-1");

    await expect(git.removeWorktree(root, wt)).resolves.toBeUndefined();
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

    const refs = Array.from({ length: 5 }, (_, i) => `refs/age/concurrent/${i}`);
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
    const ref = "refs/age/checkpoints/t/u/before";
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
    const ref = "refs/age/checkpoints/t/u/before";
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
    const from = "refs/age/checkpoints/t/a/before";
    await git.captureCheckpoint(root, from);
    await writeFile(join(root, "hello.txt"), "hello\n");
    const to = "refs/age/checkpoints/t/b/after";
    await git.captureCheckpoint(root, to);

    const base = await mkdtemp(join(tmpdir(), "age-git-ext-"));
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
    expect(await raw(root, "branch", "--list", "age/re")).toContain("age/re");

    const wt2 = await git.createWorktree(root, "re");
    expect(existsSync(wt2.path)).toBe(true);
    expect(wt2.branch).toBe("age/re");
  });
});

describe("patch truncation on a code-point boundary (fix 7)", () => {
  it("never emits U+FFFD when a multibyte char straddles the limit", async () => {
    const root = await makeRepo();
    const from = "refs/age/checkpoints/t/a/before";
    await git.captureCheckpoint(root, from);

    // The patch header length is constant for a single-line add of this filename, so measure
    // where the content begins from a tiny probe and pad so the 200 KB cut lands mid-character.
    await writeFile(join(root, "big.txt"), "中");
    const probe = "refs/age/checkpoints/t/probe/after";
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
    const to = "refs/age/checkpoints/t/b/after";
    await git.captureCheckpoint(root, to);

    const diffs = await git.diff(root, from, to);
    const patch = diffs.find((d) => d.path === "big.txt")?.patch ?? "";
    expect(patch).not.toContain("\uFFFD");
    expect(patch.endsWith("… diff truncated\n")).toBe(true);
    expect(Buffer.byteLength(patch, "utf8")).toBeLessThanOrEqual(200 * 1024 + 64);
  });
});

describe("patch parsing by position (fix 8)", () => {
  it("produces a patch for a filename containing a newline", async () => {
    const root = await makeRepo();
    const from = "refs/age/checkpoints/t/a/before";
    await git.captureCheckpoint(root, from);

    const weird = "we\nird.txt";
    await writeFile(join(root, weird), "weird content\n");
    await writeFile(join(root, "plain.txt"), "plain content\n");
    const to = "refs/age/checkpoints/t/b/after";
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
      "refs/age/../heads/main",
      "refs/age/foo//bar",
      "refs/age/foo.lock",
      "refs/age/foo/",
      "refs/age/.hidden/x",
    ];
    for (const ref of bad) {
      await expect(git.captureCheckpoint(root, ref)).rejects.toMatchObject({
        argv: ["check-ref-format", ref],
      });
    }
    await expect(git.restoreCheckpoint(root, "refs/age/../heads/main")).rejects.toMatchObject({
      argv: ["check-ref-format", "refs/age/../heads/main"],
    });
    await expect(git.captureCheckpoint(root, "refs/age/foo/")).rejects.toThrow(/refs\/age\//);
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
  const base = await realpath(await mkdtemp(join(tmpdir(), "age-git-fake-")));
  bases.push(base);
  await mkdir(join(base, "main", ".git"), { recursive: true });
  await mkdir(join(base, "wt"), { recursive: true });
  await symlink(join(base, "main"), join(base, "mainlink"));
  const bin = join(base, "fakegit.cjs");
  await writeFile(bin, FAKE_GIT);
  await chmod(bin, 0o755);
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
    const fake = createGitService({ gitBin: bin });
    const prev = process.env.FAKE_REC;
    process.env.FAKE_REC = rec;
    try {
      await Promise.all(
        Array.from({ length: 5 }, (_, i) => fake.captureCheckpoint(mainPath, `refs/age/c/${i}`)),
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
    const fake = createGitService({ gitBin: bin });
    const prevRec = process.env.FAKE_REC;
    const prevLink = process.env.FAKE_MAINLINK;
    process.env.FAKE_REC = rec;
    process.env.FAKE_MAINLINK = join(base, "mainlink");
    try {
      await Promise.all([
        fake.captureCheckpoint(mainPath, "refs/age/m/0"),
        fake.captureCheckpoint(wtPath, "refs/age/w/0"),
        fake.captureCheckpoint(mainPath, "refs/age/m/1"),
        fake.captureCheckpoint(wtPath, "refs/age/w/1"),
        fake.captureCheckpoint(mainPath, "refs/age/m/2"),
        fake.captureCheckpoint(wtPath, "refs/age/w/2"),
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
    const base = await mkdtemp(join(tmpdir(), "age-git-slow-"));
    bases.push(base);
    const bin = join(base, "slow.cjs");
    await writeFile(bin, SLOW_GIT);
    await chmod(bin, 0o755);
    const fake = createGitService({ gitBin: bin, timeoutMs: 150 });
    await expect(fake.captureCheckpoint(base, "refs/age/x/y")).rejects.toThrow(/timed out/);
  });

  it("kills a git that floods stdout past the cap", async () => {
    const base = await mkdtemp(join(tmpdir(), "age-git-huge-"));
    bases.push(base);
    const bin = join(base, "huge.cjs");
    await writeFile(bin, HUGE_GIT);
    await chmod(bin, 0o755);
    const fake = createGitService({ gitBin: bin, maxStdoutBytes: 1024 });
    await expect(fake.captureCheckpoint(base, "refs/age/x/y")).rejects.toThrow(/exceeded cap/);
  });
});
