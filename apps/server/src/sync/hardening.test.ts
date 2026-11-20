import { existsSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { chmod, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { cleanupTestRepos, makeRepo } from "../git/test-repo.ts";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createShadowGit, safeRelativePath } from "../git/shadow.ts";
import { cleanupSyncTests, makeDevice, must, pair, put, read, tempDir } from "./testing.ts";

afterEach(async () => {
  await cleanupSyncTests();
  await cleanupTestRepos();
});

const BASE = "line1\nline2\nline3\n";

describe("local files that no snapshot holds are never overwritten", () => {
  it("leaves a gitignored file and an over-cap file alone and reports them", async () => {
    const a = await makeDevice({
      deviceId: "devA",
      projectId: "proj",
      sync: { categories: { ignoredFiles: true } as never },
    });
    const b = await makeDevice({ deviceId: "devB", projectId: "proj-b", maxFileBytes: 100 });
    pair(a, b);
    await put(a.root, ".gitignore", "secret.env\n");
    await put(a.root, "secret.env", "A-secret\n");
    await put(a.root, "video.bin", "A-video".repeat(100));
    await put(a.root, "other.txt", "o\n");
    await put(b.root, ".gitignore", "secret.env\n");
    await put(b.root, "secret.env", "B-secret\n");
    await put(b.root, "video.bin", "B-video".repeat(100));
    await a.engine.snapshot(a.projectId, "manual");
    await b.engine.now();
    expect(await read(b.root, "secret.env")).toBe("B-secret\n");
    expect(await read(b.root, "video.bin")).toBe("B-video".repeat(100));
    expect(await read(b.root, "other.txt")).toBe("o\n");
    const notices = b.notices.join("\n");
    expect(notices).toContain("secret.env");
    expect(notices).toContain("video.bin");
  });

  it("returns the skipped paths from an apply", async () => {
    const a = await makeDevice({ deviceId: "devA", projectId: "proj" });
    const b = await makeDevice({ deviceId: "devB", projectId: "proj-b" });
    pair(a, b);
    await put(a.root, "note.txt", "from a\n");
    await put(b.root, ".gitignore", "note.txt\n");
    await put(b.root, "note.txt", "mine, ignored\n");
    await a.engine.snapshot(a.projectId, "manual");
    await b.engine.now();
    const result = await b.engine.apply(b.projectId, "devA");
    expect(result.outcome).toBe("noop");
    expect(await read(b.root, "note.txt")).toBe("mine, ignored\n");
    expect(b.notices.join("\n")).toContain("note.txt");
  });

  it("backs up ignored bytes when ignoredFiles is on, so a resolution can be undone", async () => {
    const sync = { categories: { ignoredFiles: true } as never };
    const a = await makeDevice({ deviceId: "devA", projectId: "proj", sync });
    const b = await makeDevice({ deviceId: "devB", projectId: "proj-b", sync });
    pair(a, b);
    for (const d of [a, b]) {
      await put(d.root, ".gitignore", "secret.env\n");
      await put(d.root, "secret.env", "v0\n");
    }
    await a.engine.now();
    await b.engine.now();
    await a.engine.now();
    await put(a.root, "secret.env", "A1\n");
    await put(b.root, "secret.env", "B-local\n");
    await a.engine.snapshot(a.projectId, "manual");
    await b.engine.now();
    const [conflict] = b.engine.status().conflicts;
    await b.engine.resolve({ conflictId: must(conflict).id, resolution: "theirs" });
    expect(await read(b.root, "secret.env")).toBe("A1\n");
    await b.engine.restore({ snapshotId: must(conflict).mine });
    expect(await read(b.root, "secret.env")).toBe("B-local\n");
  });

  it("does not write a .theirs side file over local bytes that no backup holds", async () => {
    const a = await makeDevice({ deviceId: "devA", projectId: "proj" });
    const b = await makeDevice({ deviceId: "devB", projectId: "proj-b" });
    pair(a, b);
    for (const d of [a, b]) {
      await put(d.root, ".gitignore", "*.theirs.txt\n");
      await put(d.root, "f.txt", BASE);
    }
    await a.engine.now();
    await b.engine.now();
    await a.engine.now();
    await put(a.root, "f.txt", "line1\nA\nline3\n");
    await put(b.root, "f.txt", "line1\nB\nline3\n");
    await put(b.root, "f.theirs.txt", "precious ignored bytes\n");
    await a.engine.snapshot(a.projectId, "manual");
    await b.engine.now();
    const [conflict] = b.engine.status().conflicts;
    await b.engine.resolve({ conflictId: must(conflict).id, resolution: "both" });
    expect(await read(b.root, "f.theirs.txt")).toBe("precious ignored bytes\n");
  });
});

describe("first divergent sync", () => {
  it("merges two devices that start with different files and never synced", async () => {
    const a = await makeDevice({ deviceId: "devA", projectId: "proj" });
    const b = await makeDevice({ deviceId: "devB", projectId: "proj-b" });
    pair(a, b);
    await put(a.root, "only-a.txt", "a\n");
    await put(a.root, "same.txt", "same\n");
    await put(b.root, "only-b.txt", "b\n");
    await put(b.root, "same.txt", "same\n");
    await a.engine.now();
    await b.engine.now();
    expect(b.engine.status().peers[0]?.error).toBeNull();
    expect(await read(b.root, "only-a.txt")).toBe("a\n");
    expect(await read(b.root, "only-b.txt")).toBe("b\n");
    await a.engine.now();
    expect(await read(a.root, "only-b.txt")).toBe("b\n");
  });

  it("keeps the empty merge base alive through gc", async () => {
    const a = await makeDevice({
      deviceId: "devA",
      projectId: "proj",
      sync: { retention: { keepDays: 1, keepMin: 1 } },
    });
    const b = await makeDevice({ deviceId: "devB", projectId: "proj-b" });
    pair(a, b);
    await put(a.root, "x.txt", "a\n");
    await put(b.root, "y.txt", "b\n");
    await a.engine.now();
    await b.engine.now();
    const repo = b.engine.repoFor({ id: b.projectId, root: b.root });
    const base = await b.engine.shadow.rev(repo, "refs/wooky/empty-base");
    expect(base).not.toBeNull();
    await b.engine.shadow.gc(repo);
    expect(await b.engine.shadow.rev(repo, must(base))).toBe(base);
  });
});

describe("turns cannot start mid-write", () => {
  it("raises the writing flag synchronously for apply and restore", async () => {
    const a = await makeDevice({ deviceId: "devA", projectId: "proj" });
    await put(a.root, "a.txt", "1\n");
    const first = must(await a.engine.snapshot(a.projectId, "manual"));
    await put(a.root, "a.txt", "2\n");
    expect(a.engine.isWriting(a.projectId)).toBe(false);
    const pending = a.engine.restore({ snapshotId: first.id });
    expect(a.engine.isWriting(a.projectId)).toBe(true);
    await pending;
    expect(a.engine.isWriting(a.projectId)).toBe(false);

    const failing = a.engine.restore({ snapshotId: "deadbeef" });
    expect(a.engine.isWriting(a.projectId)).toBe(true);
    await expect(failing).rejects.toMatchObject({ code: "not_found" });
    expect(a.engine.isWriting(a.projectId)).toBe(false);
  });

  it("aborts an apply when a turn starts after the backup but before the write", async () => {
    let calls = 0;
    const b = await makeDevice({
      deviceId: "devB",
      projectId: "proj-b",
      // Call 1 is the check at the top of apply, call 2 the check right before writing.
      turnRunning: () => (calls += 1) >= 2,
    });
    const a = await makeDevice({ deviceId: "devA", projectId: "proj" });
    pair(a, b);
    await put(a.root, "f.txt", "from a\n");
    await a.engine.snapshot(a.projectId, "manual");
    await b.engine.now();
    expect(existsSync(join(b.root, "f.txt"))).toBe(false);
    calls = -100;
    await b.engine.turnFinished({ projectId: b.projectId, threadId: "t", turnId: "u" });
    expect(await read(b.root, "f.txt")).toBe("from a\n");
  });

  it("aborts an apply when a file changed after the backup", async () => {
    const b = await makeDevice({
      deviceId: "devB",
      projectId: "proj-b",
      turnRunning: () => {
        // Runs between the backup and the write: the user saves a file.
        if (!changed) {
          calls += 1;
          if (calls === 2) {
            changed = true;
            writeFileSync(join(b.root, "mine.txt"), "edited during the apply\n");
          }
        }
        return false;
      },
    });
    let calls = 0;
    let changed = false;
    const a = await makeDevice({ deviceId: "devA", projectId: "proj" });
    pair(a, b);
    await put(b.root, "mine.txt", "before\n");
    await put(a.root, "f.txt", "from a\n");
    await a.engine.snapshot(a.projectId, "manual");
    await b.engine.now();
    expect(existsSync(join(b.root, "f.txt"))).toBe(false);
    expect(await read(b.root, "mine.txt")).toBe("edited during the apply\n");
    await b.engine.now();
    expect(await read(b.root, "f.txt")).toBe("from a\n");
    expect(await read(b.root, "mine.txt")).toBe("edited during the apply\n");
  });
});

describe(".git aliases", () => {
  it("refuses every spelling of .git", () => {
    for (const name of [
      ".git",
      ".GIT",
      ".git.",
      ".git ",
      ".git. .",
      "GIT~1",
      "git~2",
      ".g‌it",
      ".git::$INDEX_ALLOCATION",
      "﻿.git",
    ]) {
      expect(safeRelativePath(`${name}/hooks/post-checkout`), name).toBeNull();
      expect(safeRelativePath(`sub/${name}`), name).toBeNull();
    }
    expect(safeRelativePath("src/git-notes.md")).toBe("src/git-notes.md");
    expect(safeRelativePath(".github/workflows/ci.yml")).toBe(".github/workflows/ci.yml");
    expect(safeRelativePath(".gitignore")).toBe(".gitignore");
  });

  it("never writes a GIT~1 hook from a hostile tree", async () => {
    const root = await tempDir("wooky-hostile-");
    const home = await tempDir("wooky-hostile-home-");
    const shadow = createShadowGit();
    const repo = { gitDir: join(home, "evil.git"), workTree: root };
    await shadow.ensure(repo);
    const blob = (
      await shadow.run(repo, ["hash-object", "-w", "--stdin"], {
        input: "#!/bin/sh\ntouch pwned\n",
      })
    ).text.trim();
    const mktree = async (line: string) =>
      (await shadow.run(repo, ["mktree"], { input: line })).text.trim();
    const hooks = await mktree(`100755 blob ${blob}\tpost-checkout\n`);
    const alias = await mktree(`040000 tree ${hooks}\thooks\n`);
    const top = await mktree(`040000 tree ${alias}\tGIT~1\n100644 blob ${blob}\tok.txt\n`);
    const empty = await shadow.run(repo, ["hash-object", "-t", "tree", "-w", "--stdin"], {
      input: "",
    });
    const result = await shadow.applyChanges(
      repo,
      top,
      await shadow.changes(repo, empty.text.trim(), top),
      { exclude: [], mineTree: empty.text.trim(), maxFileBytes: 1e9, maxTotalBytes: 1e9 },
    );
    expect(existsSync(join(root, "GIT~1"))).toBe(false);
    expect(await readFile(join(root, "ok.txt"), "utf8")).toContain("touch pwned");
    expect(result.skipped.map((s) => s.reason)).toEqual(["unsafe"]);
  });
});

describe("test hooks", () => {
  it("honours WOOKY_SYNC_TEST_PEERS only under NODE_ENV=test or --test-hooks", async () => {
    const { testPeerDirectory, testHooksEnabled } = await import("./stubs.ts");
    expect(testHooksEnabled({ NODE_ENV: "test" }, [])).toBe(true);
    expect(testHooksEnabled({}, ["node", "bin.ts", "--test-hooks"])).toBe(true);
    expect(testHooksEnabled({ NODE_ENV: "production" }, ["node", "bin.ts"])).toBe(false);
    const raw = JSON.stringify([{ deviceId: "x", name: "X", baseUrl: "http://h", token: "t" }]);
    expect(testPeerDirectory(raw, true).list()).toHaveLength(1);
    expect(testPeerDirectory(raw, false).list()).toEqual([]);
  });
});

describe("interval gate", () => {
  it("notices a file rewritten with the same size and a restored mtime", async () => {
    const a = await makeDevice({ deviceId: "devA", projectId: "proj" });
    await put(a.root, "f.txt", "aaaa\n");
    await a.engine.snapshot(a.projectId, "interval", {}, { gate: true });
    const before = (await import("node:fs")).statSync(join(a.root, "f.txt"));
    await mkdir(a.root, { recursive: true });
    await writeFile(join(a.root, "f.txt"), "bbbb\n");
    await utimes(join(a.root, "f.txt"), before.atime, before.mtime);
    const second = await a.engine.snapshot(a.projectId, "interval", {}, { gate: true });
    expect(second).not.toBeNull();
  });
});

describe("ambient git config", () => {
  it("does not run a hook from the user's global hooksPath", async () => {
    if (process.platform === "win32") return;
    const hooks = await tempDir("wooky-hooks-");
    const marker = join(hooks, "ran");
    await writeFile(join(hooks, "post-index-change"), `#!/bin/sh\ntouch "${marker}"\n`, {
      mode: 0o755,
    });
    const config = join(hooks, "gitconfig");
    await writeFile(config, `[core]\n\thooksPath = ${hooks}\n`);
    const previous = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = config;
    try {
      const a = await makeDevice({ deviceId: "devA" });
      await put(a.root, "f.txt", "x\n");
      expect(await a.engine.snapshot(a.projectId, "manual")).not.toBeNull();
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previous;
    }
    expect(existsSync(marker)).toBe(false);
  });
});

describe("incoming size caps", () => {
  it("skips an incoming blob over the cap and reports it", async () => {
    const a = await makeDevice({ deviceId: "devA", projectId: "proj" });
    const b = await makeDevice({ deviceId: "devB", projectId: "proj-b", maxFileBytes: 100 });
    pair(a, b);
    await put(a.root, "big.bin", "x".repeat(500));
    await put(a.root, "small.txt", "ok\n");
    await a.engine.snapshot(a.projectId, "manual");
    await b.engine.now();
    expect(existsSync(join(b.root, "big.bin"))).toBe(false);
    expect(await read(b.root, "small.txt")).toBe("ok\n");
    expect(b.notices.join("\n")).toContain("big.bin");
  });

  it("refuses an apply whose total size is over the cap and writes nothing", async () => {
    const a = await makeDevice({ deviceId: "devA", projectId: "proj" });
    const b = await makeDevice({ deviceId: "devB", projectId: "proj-b", maxApplyBytes: 50 });
    pair(a, b);
    await put(a.root, "one.txt", "x".repeat(40));
    await put(a.root, "two.txt", "y".repeat(40));
    await a.engine.snapshot(a.projectId, "manual");
    await b.engine.now();
    expect(existsSync(join(b.root, "one.txt"))).toBe(false);
    expect(existsSync(join(b.root, "two.txt"))).toBe(false);
    expect(b.engine.status().peers[0]?.error).toContain("too large");
  });
});

describe("atomic apply", () => {
  it("puts everything back when a write fails, and says so", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const a = await makeDevice({ deviceId: "devA", projectId: "proj" });
    const b = await makeDevice({ deviceId: "devB", projectId: "proj-b" });
    pair(a, b);
    for (const d of [a, b]) {
      await put(d.root, "ro/a.txt", "old\n");
      await put(d.root, "gone.txt", "keep me\n");
    }
    await a.engine.now();
    await b.engine.now();
    await a.engine.now();
    await put(a.root, "ro/a.txt", "new\n");
    await put(a.root, "ok.txt", "new file\n");
    await rm(join(a.root, "gone.txt"));
    await a.engine.snapshot(a.projectId, "manual");
    await chmod(join(b.root, "ro"), 0o555);
    try {
      await b.engine.now();
    } finally {
      await chmod(join(b.root, "ro"), 0o755);
    }
    expect(await read(b.root, "gone.txt")).toBe("keep me\n");
    expect(await read(b.root, "ro/a.txt")).toBe("old\n");
    expect(existsSync(join(b.root, "ok.txt"))).toBe(false);
    expect(b.engine.status().peers[0]?.error).toContain("Restored your previous files");
  });
});

describe("retention holds", () => {
  it("keeps an open conflict's commits alive after the peer ref moves and gc runs", async () => {
    const a = await makeDevice({ deviceId: "devA", projectId: "proj" });
    const b = await makeDevice({ deviceId: "devB", projectId: "proj-b" });
    pair(a, b);
    for (const d of [a, b]) await put(d.root, "f.txt", BASE);
    await a.engine.now();
    await b.engine.now();
    await a.engine.now();
    await put(a.root, "f.txt", "line1\nA\nline3\n");
    await put(b.root, "f.txt", "line1\nB\nline3\n");
    await a.engine.snapshot(a.projectId, "manual");
    await b.engine.now();
    const conflict = must(b.engine.status().conflicts[0]);
    const repo = b.engine.repoFor({ id: b.projectId, root: b.root });
    for (const sha of [conflict.mine, conflict.theirs]) {
      expect(await b.engine.shadow.rev(repo, `refs/wooky/hold/${sha}`)).toBe(sha);
    }
    // The peer moves on and gc runs: the conflict's own commits must survive.
    await put(a.root, "f.txt", "line1\nA2\nline3\n");
    await a.engine.snapshot(a.projectId, "manual");
    await b.engine.now();
    await b.engine.shadow.run(repo, ["update-ref", "-d", "refs/wooky/peer/devA"]);
    await b.engine.shadow.gc(repo);
    expect(await b.engine.shadow.rev(repo, conflict.theirs)).toBe(conflict.theirs);
    await b.engine.resolve({ conflictId: conflict.id, resolution: "mine" });
    expect(await b.engine.shadow.rev(repo, `refs/wooky/hold/${conflict.theirs}`)).toBeNull();
  });

  it("skips gc while git is still reading history for a peer's bundle", async () => {
    if (process.platform === "win32") return;
    const slow = join(await tempDir("wooky-slowgit-"), "git-slow.sh");
    await writeFile(
      slow,
      '#!/bin/sh\ncase "$*" in *"bundle create"*) sleep 1;; esac\nexec git "$@"\n',
      {
        mode: 0o755,
      },
    );
    const a = await makeDevice({
      deviceId: "devA",
      projectId: "proj",
      gitBin: slow,
      sync: { retention: { keepDays: 1, keepMin: 1 } },
    });
    for (let i = 0; i < 4; i += 1) {
      await put(a.root, "f.txt", `v${i}\n`);
      await a.engine.snapshot(a.projectId, "manual");
    }
    a.clock.time += 10 * 24 * 3600_000;
    const bundle = await a.engine.openBundle("proj", null);
    expect(bundle?.empty).toBe(false);
    await a.engine.retain();
    expect(a.notices.join("\n")).toContain("peer is downloading");
    if (bundle && !bundle.empty) {
      bundle.stdout.resume();
      await bundle.done;
    }
    a.notices.length = 0;
    await a.engine.retain();
    expect(a.notices.join("\n")).not.toContain("peer is downloading");
  });
});

describe("the project's own exclude file", () => {
  it("honours .git/info/exclude", async () => {
    const root = await makeRepo();
    await mkdir(join(root, ".git", "info"), { recursive: true });
    await writeFile(join(root, ".git", "info", "exclude"), "private.txt\n");
    const a = await makeDevice({ deviceId: "devA", root });
    await put(root, "private.txt", "mine only\n");
    await put(root, "public.txt", "shared\n");
    const snap = must(await a.engine.snapshot(a.projectId, "manual"));
    const listed = await a.engine.shadow.run(a.engine.repoFor({ id: a.projectId, root }), [
      "ls-tree",
      "-r",
      "--name-only",
      snap.id,
    ]);
    expect(listed.text.split("\n").filter(Boolean)).toEqual(["public.txt", "seed.txt"]);
  });
});
