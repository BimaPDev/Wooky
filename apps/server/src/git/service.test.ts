import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
