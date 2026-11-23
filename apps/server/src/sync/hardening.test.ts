import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { chmod, mkdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { cleanupTestRepos, makeRepo } from "../git/test-repo.ts";
import { join, sep } from "node:path";
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

  it("raises the writing flag synchronously for apply and resolve", async () => {
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

    expect(b.engine.isWriting(b.projectId)).toBe(false);
    const applying = b.engine.apply(b.projectId, "devA");
    expect(b.engine.isWriting(b.projectId)).toBe(true);
    await applying;
    expect(b.engine.isWriting(b.projectId)).toBe(false);

    const resolving = b.engine.resolve({ conflictId: conflict.id, resolution: "mine" });
    expect(b.engine.isWriting(b.projectId)).toBe(true);
    await resolving;
    expect(b.engine.isWriting(b.projectId)).toBe(false);
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

  it("aborts when a turn starts during the scan just before the write", async () => {
    let calls = 0;
    const b = await makeDevice({
      deviceId: "devB",
      projectId: "proj-b",
      // Call 1 is the top-of-apply check, 2 the pre-scan check, 3 the re-check before writing.
      turnRunning: () => (calls += 1) === 3,
    });
    const a = await makeDevice({ deviceId: "devA", projectId: "proj" });
    pair(a, b);
    await put(a.root, "f.txt", "from a\n");
    await a.engine.snapshot(a.projectId, "manual");
    await b.engine.now();
    expect(existsSync(join(b.root, "f.txt"))).toBe(false);
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
      ".g​it",
      ".git⁠",
      ".git::$INDEX_ALLOCATION",
      "﻿.git",
    ]) {
      expect(safeRelativePath(`${name}/hooks/post-checkout`)).toBeNull();
      expect(safeRelativePath(`sub/${name}`)).toBeNull();
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

describe("hostile path names", () => {
  it("refuses control characters so a newline cannot poison the blob size lookup", async () => {
    const root = await tempDir("wooky-hostile-");
    const home = await tempDir("wooky-hostile-home-");
    const shadow = createShadowGit();
    const repo = { gitDir: join(home, "evil.git"), workTree: root };
    await shadow.ensure(repo);
    const big = (
      await shadow.run(repo, ["hash-object", "-w", "--stdin"], { input: "x".repeat(500) })
    ).text.trim();
    const small = (
      await shadow.run(repo, ["hash-object", "-w", "--stdin"], { input: "ok\n" })
    ).text.trim();
    const entries = [`100644 blob ${big}\tbig.bin`, `100644 blob ${small}\ta\nb`];
    const tree = (
      await shadow.run(repo, ["mktree", "-z"], { input: entries.join("\0") + "\0" })
    ).text.trim();
    expect(tree).toMatch(/^[0-9a-f]{40}$/);
    const empty = (
      await shadow.run(repo, ["hash-object", "-t", "tree", "-w", "--stdin"], { input: "" })
    ).text.trim();
    const result = await shadow.applyChanges(repo, tree, await shadow.changes(repo, empty, tree), {
      exclude: [],
      mineTree: empty,
      maxFileBytes: 100,
      maxTotalBytes: 1e9,
    });
    expect(existsSync(join(root, "big.bin"))).toBe(false);
    expect(result.written).toEqual([]);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { path: "a\nb", reason: "unsafe" },
        { path: "big.bin", reason: "too-large" },
      ]),
    );
  });

  it("never lets a hostile conflict path inject an extra index entry", async () => {
    const root = await tempDir("wooky-hostile-");
    const home = await tempDir("wooky-hostile-home-");
    const shadow = createShadowGit();
    const repo = { gitDir: join(home, "evil.git"), workTree: root };
    await shadow.ensure(repo);
    const blob = (
      await shadow.run(repo, ["hash-object", "-w", "--stdin"], { input: "attacker\n" })
    ).text.trim();
    const empty = (
      await shadow.run(repo, ["hash-object", "-t", "tree", "-w", "--stdin"], { input: "" })
    ).text.trim();
    const hostile = `x\n100644 ${blob} 0\tREADME.md`;
    const side = (
      await shadow.run(repo, ["mktree", "-z"], { input: `100644 blob ${blob}\t${hostile}\0` })
    ).text.trim();
    const merged = await shadow.pickSide(repo, {
      merged: empty,
      side,
      paths: [hostile],
    });
    const listed = await shadow.run(repo, ["ls-tree", "-r", "--name-only", merged]);
    expect(listed.text.split("\n").filter(Boolean)).not.toContain("README.md");
  });
});

describe("test hooks", () => {
  it("has no env or flag that injects peers into a real server", async () => {
    const { readFileSync, statSync } = await import("node:fs");
    const { dirname, join: joinPath } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { resolveConfig } = await import("../config.ts");
    const src = joinPath(dirname(fileURLToPath(import.meta.url)), "..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = joinPath(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) {
          const text = readFileSync(full, "utf8");
          if (/SYNC_TEST_PEERS|test-hooks|testHooksEnabled/.test(text)) offenders.push(full);
        }
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
    expect(() => resolveConfig(["--test-hooks"], { NODE_ENV: "test" })).toThrow(/test-hooks/);
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

  it("re-hashes a file whose ctime changed even when git ignores ctime and mtime matches", async () => {
    const a = await makeDevice({ deviceId: "devA", projectId: "proj" });
    const file = join(a.root, "f.txt");
    const fixed = new Date("2025-01-01T00:00:00.000Z");
    await put(a.root, "f.txt", "aaaa\n");
    await utimes(file, fixed, fixed);
    const first = await a.engine.snapshot(a.projectId, "interval", {}, { gate: true });
    expect(first).not.toBeNull();

    // Mirrors Git for Windows, where st_ctime maps to creation time and never moves on overwrite.
    const shadow = createShadowGit();
    const repo = { gitDir: join(a.home, "sync", `${a.projectId}.git`), workTree: a.root };
    await shadow.run(repo, ["config", "core.trustctime", "false"]);

    await writeFile(file, "bbbb\n");
    await utimes(file, fixed, fixed);
    const second = must(await a.engine.snapshot(a.projectId, "interval", {}, { gate: true }));
    const blob = await shadow.blobAt(repo, second.id, "f.txt");
    expect(blob?.toString("utf8")).toBe("bbbb\n");

    const third = await a.engine.snapshot(a.projectId, "interval", {}, { gate: true });
    expect(third).toBeNull();
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

describe("path escapes", () => {
  async function rig() {
    const root = await tempDir("wooky-escape-");
    const outside = await tempDir("wooky-outside-");
    const home = await tempDir("wooky-escape-home-");
    const shadow = createShadowGit();
    const repo = { gitDir: join(home, "escape.git"), workTree: root };
    await shadow.ensure(repo);
    const blob = (
      await shadow.run(repo, ["hash-object", "-w", "--stdin"], { input: "pwned\n" })
    ).text.trim();
    const mktree = async (text: string) =>
      (await shadow.run(repo, ["mktree"], { input: text })).text.trim();
    const empty = (
      await shadow.run(repo, ["hash-object", "-t", "tree", "-w", "--stdin"], { input: "" })
    ).text.trim();
    const rules = (mineTree: string) => ({
      exclude: [],
      mineTree,
      maxFileBytes: 1e9,
      maxTotalBytes: 1e9,
    });
    return { root, outside, shadow, repo, blob, mktree, empty, rules };
  }

  it("refuses .., absolute, drive-letter and backslash spellings before writing anything", async () => {
    const { root, outside, shadow, repo, blob, mktree, empty, rules } = await rig();
    expect(safeRelativePath("../x")).toBeNull();
    expect(safeRelativePath("a/../../x")).toBeNull();
    expect(safeRelativePath("/etc/passwd")).toBeNull();
    expect(safeRelativePath("C:/Windows/x")).toBeNull();
    expect(safeRelativePath("a\\..\\x".replace(/\\/g, sep === "\\" ? "\\" : "/"))).toBeNull();
    const tree = await mktree(`100644 blob ${blob}\tok.txt\n`);
    const changes = [
      ...(await shadow.changes(repo, empty, tree)),
      { status: "A" as const, path: "../escape.txt", mode: "100644", sha: blob },
      { status: "A" as const, path: `${outside}/abs.txt`, mode: "100644", sha: blob },
    ];
    const report = await shadow.applyChanges(repo, tree, changes, rules(empty));
    expect(report.skipped.map((s) => s.reason)).toEqual(["unsafe", "unsafe"]);
    expect(existsSync(join(root, "..", "escape.txt"))).toBe(false);
    expect(existsSync(join(outside, "abs.txt"))).toBe(false);
    expect(existsSync(join(root, "ok.txt"))).toBe(true);
  });

  it("never writes through a symlinked directory that points outside the project", async () => {
    if (process.platform === "win32") return;
    const { root, outside, shadow, repo, blob, mktree, empty, rules } = await rig();
    await symlink(outside, join(root, "dir"));
    const mine = await mktree(
      `120000 blob ${(
        await shadow.run(repo, ["hash-object", "-w", "--stdin"], { input: outside })
      ).text.trim()}\tdir\n`,
    );
    const inner = await mktree(`100644 blob ${blob}\tevil.txt\n`);
    const target = await mktree(`040000 tree ${inner}\tdir\n`);
    await shadow.applyChanges(repo, target, await shadow.changes(repo, mine, target), rules(mine));
    expect(existsSync(join(outside, "evil.txt"))).toBe(false);
    expect(readdirSync(outside)).toEqual([]);
    void empty;
  });

  it("replaces a symlinked file instead of writing through it", async () => {
    if (process.platform === "win32") return;
    const { root, outside, shadow, repo, blob, mktree, rules } = await rig();
    await writeFile(join(outside, "victim.txt"), "original\n");
    await symlink(join(outside, "victim.txt"), join(root, "f.txt"));
    const linkBlob = (
      await shadow.run(repo, ["hash-object", "-w", "--stdin"], {
        input: join(outside, "victim.txt"),
      })
    ).text.trim();
    const mine = await mktree(`120000 blob ${linkBlob}\tf.txt\n`);
    const target = await mktree(`100644 blob ${blob}\tf.txt\n`);
    await shadow.applyChanges(repo, target, await shadow.changes(repo, mine, target), rules(mine));
    expect(await readFile(join(outside, "victim.txt"), "utf8")).toBe("original\n");
  });

  it("does not delete through a symlinked directory", async () => {
    if (process.platform === "win32") return;
    const { root, outside, shadow, repo, blob, mktree, rules } = await rig();
    await writeFile(join(outside, "keep.txt"), "keep\n");
    await symlink(outside, join(root, "dir"));
    const inner = await mktree(`100644 blob ${blob}\tkeep.txt\n`);
    const mine = await mktree(`040000 tree ${inner}\tdir\n`);
    const target = await mktree("");
    await shadow.applyChanges(repo, target, await shadow.changes(repo, mine, target), rules(mine));
    expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("keep\n");
  });
});

describe("bundle requests", () => {
  it("wait for a snapshot in the same project, so a peer never sees a half-moved ref", async () => {
    if (process.platform === "win32") return;
    const slow = join(await tempDir("wooky-slowgit-"), "git-slow.sh");
    await writeFile(slow, '#!/bin/sh\ncase "$*" in *write-tree*) sleep 1;; esac\nexec git "$@"\n', {
      mode: 0o755,
    });
    const a = await makeDevice({ deviceId: "devA", projectId: "proj", gitBin: slow });
    await put(a.root, "f.txt", "v1\n");
    await a.engine.snapshot(a.projectId, "manual");
    await put(a.root, "f.txt", "v2\n");
    const order: string[] = [];
    const snapshot = a.engine.snapshot(a.projectId, "manual").then(() => order.push("snapshot"));
    const bundle = a.engine.openBundle("proj", null).then((opened) => {
      order.push("bundle");
      return opened;
    });
    const [, opened] = await Promise.all([snapshot, bundle]);
    expect(order).toEqual(["snapshot", "bundle"]);
    if (opened && !opened.empty) {
      opened.stdout.resume();
      await opened.done;
    }
  });

  it("answer 404 for a project nobody maps and never touch another folder", async () => {
    const a = await makeDevice({ deviceId: "devA", projectId: "proj" });
    expect(await a.engine.openBundle("nope", null)).toBeNull();
    expect(await a.engine.openBundle("../../etc", null)).toBeNull();
  });
});
