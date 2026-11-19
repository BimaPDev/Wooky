import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { parseLegacyMergeTree, parseMergeTreeNames } from "./merge-ops.ts";
import { createGitService } from "./service.ts";

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
  });
  return stdout;
}

async function makeRepo(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "age-merge-safety-"));
  bases.push(base);
  const root = join(base, "repo");
  await mkdir(root);
  await raw(root, "init", "-q", "-b", "main");
  await raw(root, "config", "user.email", "test@example.com");
  await raw(root, "config", "user.name", "Test");
  await raw(root, "config", "commit.gpgsign", "false");
  await writeFile(join(root, "seed.txt"), "seed\n");
  await raw(root, "add", "-A");
  await raw(root, "commit", "-qm", "init");
  return root;
}

async function commitFile(cwd: string, file: string, body: string): Promise<void> {
  await writeFile(join(cwd, file), body);
  await raw(cwd, "add", file);
  await raw(cwd, "commit", "-qm", `edit ${file}`);
}

async function gitDir(root: string): Promise<string> {
  return (await raw(root, "rev-parse", "--absolute-git-dir")).trim();
}

/** Worker branch that edits `file`, plus a diverging commit on main so they conflict. */
async function conflictingWorker(root: string, id: string, file = "shared.txt") {
  await commitFile(root, file, "base\n");
  const wt = await git.createWorktree(root, id);
  await commitFile(wt.path, file, "worker\n");
  await commitFile(root, file, "main line\n");
  return wt;
}

async function cleanWorker(root: string, id: string, file = `${id}.txt`) {
  const wt = await git.createWorktree(root, id);
  await commitFile(wt.path, file, `${id}\n`);
  return wt;
}

async function expectCleanRoot(root: string): Promise<void> {
  expect(await raw(root, "status", "--porcelain")).toBe("");
  expect(existsSync(join(await gitDir(root), "MERGE_HEAD"))).toBe(false);
  expect(existsSync(join(await gitDir(root), "age-merge-in-progress"))).toBe(false);
}

describe("merge safety: conflicts and crash recovery", () => {
  it("aborts a conflicting merge and leaves the root clean", async () => {
    const root = await makeRepo();
    const wt = await conflictingWorker(root, "c1");
    const before = (await raw(root, "rev-parse", "HEAD")).trim();
    const res = await git.mergeWorktree(root, wt, "merge", "Worker");
    expect(res).toMatchObject({
      ok: false,
      kind: "conflict",
      conflicts: ["shared.txt"],
      targetBranch: "main",
    });
    await expectCleanRoot(root);
    expect((await raw(root, "rev-parse", "HEAD")).trim()).toBe(before);
    expect(await readFile(join(root, "shared.txt"), "utf8")).toBe("main line\n");
  });

  it("squash conflicts also leave the root clean", async () => {
    const root = await makeRepo();
    const wt = await conflictingWorker(root, "c2");
    const res = await git.mergeWorktree(root, wt, "squash", "Worker");
    expect(res).toMatchObject({ ok: false, kind: "conflict", conflicts: ["shared.txt"] });
    await expectCleanRoot(root);
    expect(await readFile(join(root, "shared.txt"), "utf8")).toBe("main line\n");
  });

  it("cleans up after a crash mid-merge, then reports the conflict correctly", async () => {
    const root = await makeRepo();
    const wt = await conflictingWorker(root, "crash1");
    await writeFile(
      join(await gitDir(root), "age-merge-in-progress"),
      JSON.stringify({ branch: wt.branch, strategy: "merge" }),
    );
    await expect(
      raw(root, "merge", "--no-ff", "--no-edit", `refs/heads/${wt.branch}`),
    ).rejects.toThrow(/Command failed/);
    expect(existsSync(join(await gitDir(root), "MERGE_HEAD"))).toBe(true);

    const res = await git.mergeWorktree(root, wt, "merge", "Worker");
    expect(res).toMatchObject({ ok: false, kind: "conflict", conflicts: ["shared.txt"] });
    await expectCleanRoot(root);
  });

  it("cleans up a crashed, resolvable merge and then lands it", async () => {
    const root = await makeRepo();
    const wt = await cleanWorker(root, "crash2");
    await commitFile(root, "main-only.txt", "m\n");
    await writeFile(
      join(await gitDir(root), "age-merge-in-progress"),
      JSON.stringify({ branch: wt.branch, strategy: "merge" }),
    );
    await raw(root, "merge", "--no-ff", "--no-commit", `refs/heads/${wt.branch}`);
    expect(existsSync(join(await gitDir(root), "MERGE_HEAD"))).toBe(true);

    const res = await git.mergeWorktree(root, wt, "merge", "Worker");
    expect(res.ok).toBe(true);
    await expectCleanRoot(root);
    expect(existsSync(join(root, "crash2.txt"))).toBe(true);
  });

  it("recovers staged squash changes left by a crash", async () => {
    const root = await makeRepo();
    const wt = await cleanWorker(root, "crash3");
    await writeFile(
      join(await gitDir(root), "age-merge-in-progress"),
      JSON.stringify({ branch: wt.branch, strategy: "squash" }),
    );
    await raw(root, "merge", "--squash", `refs/heads/${wt.branch}`);
    expect(await raw(root, "diff", "--cached", "--name-only")).toContain("crash3.txt");

    const res = await git.mergeWorktree(root, wt, "squash", "Worker", "Crash squash");
    expect(res.ok).toBe(true);
    await expectCleanRoot(root);
    expect((await raw(root, "log", "-1", "--pretty=%s")).trim()).toBe("Crash squash");
  });

  it("refuses a mid-merge root it did not start, and leaves it alone", async () => {
    const root = await makeRepo();
    const wt = await conflictingWorker(root, "theirs");
    await expect(
      raw(root, "merge", "--no-ff", "--no-edit", `refs/heads/${wt.branch}`),
    ).rejects.toThrow(/Command failed/);
    const res = await git.mergeWorktree(root, wt, "merge", "Worker");
    expect(res).toMatchObject({ ok: false, kind: "failed", targetBranch: "main" });
    if (res.ok) throw new Error("expected failure");
    expect(res.message).toMatch(/mid-merge; run git merge --abort/);
    expect(existsSync(join(await gitDir(root), "MERGE_HEAD"))).toBe(true);
  });
});

describe("merge safety: squash commit failures", () => {
  it("unstages the squash on a failing pre-commit hook and keeps an unrelated edit", async () => {
    const root = await makeRepo();
    const wt = await cleanWorker(root, "hook1", "only.txt");
    const hook = join(await gitDir(root), "hooks", "pre-commit");
    await mkdir(join(await gitDir(root), "hooks"), { recursive: true });
    await writeFile(
      hook,
      '#!/bin/sh\necho "user edit" >> seed.txt\necho "hook says no" >&2\nexit 1\n',
    );
    await chmod(hook, 0o755);
    const before = (await raw(root, "rev-parse", "HEAD")).trim();

    const res = await git.mergeWorktree(root, wt, "squash", "Worker");
    expect(res).toMatchObject({ ok: false, kind: "failed", targetBranch: "main" });
    if (res.ok) throw new Error("expected failure");
    expect(res.message).toContain("hook says no");
    expect((await raw(root, "rev-parse", "HEAD")).trim()).toBe(before);
    expect(await readFile(join(root, "seed.txt"), "utf8")).toBe("seed\nuser edit\n");
    expect(existsSync(join(root, "only.txt"))).toBe(false);
    expect(await raw(root, "status", "--porcelain")).toBe(" M seed.txt\n");
    expect(await raw(root, "diff", "--cached", "--name-only")).toBe("");
    const dir = await gitDir(root);
    expect(existsSync(join(dir, "age-merge-in-progress"))).toBe(false);
    expect(existsSync(join(dir, "SQUASH_MSG"))).toBe(false);
  });
});

describe("merge safety: idempotence and refusal", () => {
  it("reports an already-merged branch as merged at HEAD for both strategies", async () => {
    const root = await makeRepo();
    const wt = await cleanWorker(root, "done1");
    const first = await git.mergeWorktree(root, wt, "merge", "Worker");
    expect(first.ok).toBe(true);
    const head = (await raw(root, "rev-parse", "HEAD")).trim();
    for (const strategy of ["merge", "squash"] as const) {
      const again = await git.mergeWorktree(root, wt, strategy, "Worker");
      expect(again).toEqual({ ok: true, commit: head, targetBranch: "main" });
    }
    expect((await raw(root, "rev-parse", "HEAD")).trim()).toBe(head);
    await expectCleanRoot(root);
  });

  it("merges a worktree whose thread id has a production-style underscore", async () => {
    const root = await makeRepo();
    const wt = await cleanWorker(root, "thread_3f2a9c1e-7b4d-4e8a-9f00-1a2b3c4d5e6f", "real.txt");
    const res = await git.mergeWorktree(root, wt, "squash", "Worker");
    expect(res.ok).toBe(true);
    await expectCleanRoot(root);
  });

  it("treats a squash that stages nothing as merged", async () => {
    const root = await makeRepo();
    const wt = await git.createWorktree(root, "empty1");
    await commitFile(wt.path, "same.txt", "same\n");
    await commitFile(root, "same.txt", "same\n");
    const head = (await raw(root, "rev-parse", "HEAD")).trim();
    const res = await git.mergeWorktree(root, wt, "squash", "Worker");
    expect(res).toEqual({ ok: true, commit: head, targetBranch: "main" });
    await expectCleanRoot(root);
  });

  it("refuses a detached HEAD without touching it", async () => {
    const root = await makeRepo();
    const wt = await cleanWorker(root, "detached1");
    await raw(root, "checkout", "-q", "--detach");
    const head = (await raw(root, "rev-parse", "HEAD")).trim();
    const res = await git.mergeWorktree(root, wt, "merge", "Worker");
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected refusal");
    expect(res.kind).toBe("failed");
    expect(res.message).toMatch(/detached HEAD/);
    expect((await raw(root, "rev-parse", "HEAD")).trim()).toBe(head);
    await expectCleanRoot(root);
  });

  it("includes the target branch on a dirty refusal", async () => {
    const root = await makeRepo();
    const wt = await cleanWorker(root, "dirty1");
    await writeFile(join(root, "seed.txt"), "edited\n");
    const res = await git.mergeWorktree(root, wt, "merge", "Worker");
    expect(res).toMatchObject({ ok: false, kind: "dirty", targetBranch: "main" });
  });

  it("rejects a branch that is not an age branch", async () => {
    const root = await makeRepo();
    const res = await git.mergeWorktree(
      root,
      { path: root, branch: "--upload-pack=x" },
      "merge",
      "t",
    );
    expect(res).toMatchObject({ ok: false, kind: "failed" });
    await expect(git.mergePreview(root, { path: root, branch: "main" })).rejects.toThrow(
      /Unexpected worktree branch/,
    );
  });

  it("accepts a commit message that starts with a dash", async () => {
    const root = await makeRepo();
    const squash = await cleanWorker(root, "dash1");
    const res = await git.mergeWorktree(root, squash, "squash", "Worker", "-leading dash");
    expect(res.ok).toBe(true);
    expect((await raw(root, "log", "-1", "--pretty=%s")).trim()).toBe("-leading dash");

    const plain = await cleanWorker(root, "dash2");
    const merged = await git.mergeWorktree(root, plain, "merge", "Worker", "-merge dash");
    expect(merged.ok).toBe(true);
    expect((await raw(root, "log", "-1", "--pretty=%s")).trim()).toBe("-merge dash");
  });
});

describe("merge preview conflicts", () => {
  it("lists the conflicting paths, including ones with spaces", async () => {
    const root = await makeRepo();
    await commitFile(root, "my file.txt", "base\n");
    await commitFile(root, "other.txt", "base\n");
    const wt = await git.createWorktree(root, "prev1");
    await commitFile(wt.path, "my file.txt", "worker\n");
    await commitFile(wt.path, "other.txt", "worker\n");
    await commitFile(wt.path, "clean.txt", "worker\n");
    await commitFile(root, "my file.txt", "main\n");
    await commitFile(root, "other.txt", "main\n");
    const head = (await raw(root, "rev-parse", "HEAD")).trim();

    const preview = await git.mergePreview(root, wt);
    expect([...preview.conflicts].sort()).toEqual(["my file.txt", "other.txt"]);
    expect(preview.targetBranch).toBe("main");
    expect((await raw(root, "rev-parse", "HEAD")).trim()).toBe(head);
    await expectCleanRoot(root);
  });

  it("returns no conflicts for a clean branch", async () => {
    const root = await makeRepo();
    const wt = await cleanWorker(root, "prev2");
    expect((await git.mergePreview(root, wt)).conflicts).toEqual([]);
  });

  it("parses the -z name list and the pre-2.38 text format", async () => {
    expect(parseMergeTreeNames("abc\0a b.txt\0c.txt\0\x001\0a b.txt\0Auto-merging\0")).toEqual([
      "a b.txt",
      "c.txt",
    ]);
    const root = await makeRepo();
    await commitFile(root, "my file.txt", "base\n");
    const base = (await raw(root, "rev-parse", "HEAD")).trim();
    await raw(root, "checkout", "-q", "-b", "side");
    await commitFile(root, "my file.txt", "theirs\n");
    await commitFile(root, "fresh.txt", "x\n");
    await raw(root, "checkout", "-q", "main");
    await commitFile(root, "my file.txt", "ours\n");
    const legacy = await raw(root, "merge-tree", base, "HEAD", "side");
    expect(parseLegacyMergeTree(legacy)).toEqual(["my file.txt"]);
  });
});

describe("merge locking", () => {
  it("serialises two merges started at once", async () => {
    const root = await makeRepo();
    const a = await cleanWorker(root, "ser1");
    const b = await cleanWorker(root, "ser2");
    const [ra, rb] = await Promise.all([
      git.mergeWorktree(root, a, "merge", "A"),
      git.mergeWorktree(root, b, "merge", "B"),
    ]);
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);
    expect(existsSync(join(root, "ser1.txt"))).toBe(true);
    expect(existsSync(join(root, "ser2.txt"))).toBe(true);
    await expectCleanRoot(root);
    expect(existsSync(join(await gitDir(root), "age-merge.lock"))).toBe(false);
  });

  it("recovers a stale lockfile left by a dead process", async () => {
    const root = await makeRepo();
    const wt = await cleanWorker(root, "stale1");
    const lock = join(await gitDir(root), "age-merge.lock");
    await writeFile(lock, "2147483646");
    const res = await git.mergeWorktree(root, wt, "merge", "Worker");
    expect(res.ok).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  it("refuses while a live process holds the lock, and leaves its lockfile", async () => {
    const root = await makeRepo();
    const wt = await cleanWorker(root, "live1");
    const lock = join(await gitDir(root), "age-merge.lock");
    await writeFile(lock, String(process.ppid));
    const res = await git.mergeWorktree(root, wt, "merge", "Worker");
    expect(res).toMatchObject({ ok: false, kind: "failed" });
    if (res.ok) throw new Error("expected busy");
    expect(res.message).toMatch(/Another merge is running/);
    expect(existsSync(lock)).toBe(true);
    expect(existsSync(join(root, "live1.txt"))).toBe(false);
  });
});
