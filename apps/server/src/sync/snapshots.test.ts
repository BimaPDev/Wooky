import { existsSync } from "node:fs";
import { chmod, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ServiceError } from "../errors.ts";
import { cleanupTestRepos, makeRepo } from "../git/test-repo.ts";
import { cleanupSyncTests, makeDevice, must, put, read, tempDir } from "./testing.ts";

afterEach(async () => {
  await cleanupSyncTests();
  await cleanupTestRepos();
});

const files = (device: Awaited<ReturnType<typeof makeDevice>>, sha: string) =>
  device.engine.shadow
    .run(device.engine.repoFor({ id: device.projectId, root: device.root }), [
      "ls-tree",
      "-r",
      "--name-only",
      sha,
    ])
    .then((res) => res.text.split("\n").filter(Boolean));

describe("snapshot", () => {
  it("snapshots a folder that is not a git repo", async () => {
    const device = await makeDevice({ deviceId: "a" });
    await put(device.root, "one.txt", "1\n");
    await put(device.root, "dir/two.txt", "22\n");
    const snap = await device.engine.snapshot(device.projectId, "manual", { label: "first" });
    expect(snap).toMatchObject({
      kind: "files",
      projectId: device.projectId,
      deviceId: "a",
      reason: "manual",
      parentId: null,
      summary: { filesChanged: 2, insertions: 2, deletions: 0 },
    });
    expect(existsSync(join(device.root, ".git"))).toBe(false);
    expect(await files(device, must(snap).id)).toEqual(["dir/two.txt", "one.txt"]);
    expect(device.pushes.map((push) => push.kind)).toEqual(["snapshot"]);
  });

  it("returns null when nothing changed and chains the next snapshot", async () => {
    const device = await makeDevice({ deviceId: "a" });
    await put(device.root, "a.txt", "1\n");
    const first = await device.engine.snapshot(device.projectId, "manual");
    expect(await device.engine.snapshot(device.projectId, "manual")).toBeNull();
    await put(device.root, "a.txt", "2\n");
    const second = await device.engine.snapshot(device.projectId, "turn", {
      threadId: "t1",
      turnId: "u1",
    });
    expect(second).toMatchObject({
      parentId: must(first).id,
      reason: "turn",
      threadId: "t1",
      summary: { filesChanged: 1, insertions: 1, deletions: 1 },
    });
  });

  it("leaves the project's own git state untouched", async () => {
    const root = await makeRepo();
    const device = await makeDevice({ deviceId: "a", root });
    const git = (...args: string[]) =>
      device.engine.shadow
        .run(null, ["-C", root, "--no-optional-locks", ...args])
        .then((r) => r.text);
    await put(root, "work.txt", "uncommitted\n");
    await git("add", "work.txt");
    await put(root, "untracked.txt", "u\n");
    const before = {
      status: await git("status", "--porcelain"),
      refs: await git("for-each-ref"),
      head: await git("rev-parse", "HEAD"),
      index: (await stat(join(root, ".git", "index"))).mtimeMs,
    };
    const snap = await device.engine.snapshot(device.projectId, "manual");
    expect(snap).not.toBeNull();
    const after = {
      status: await git("status", "--porcelain"),
      refs: await git("for-each-ref"),
      head: await git("rev-parse", "HEAD"),
      index: (await stat(join(root, ".git", "index"))).mtimeMs,
    };
    expect(after).toEqual(before);
    expect(await files(device, must(snap).id)).toEqual(["seed.txt", "untracked.txt", "work.txt"]);
    const message = await device.engine.shadow.commitMessage(
      device.engine.repoFor({ id: device.projectId, root }),
      must(snap).id,
    );
    expect(message).toContain(before.head.trim());
    expect(message).toContain('"branch":"main"');
  });

  it("respects .gitignore unless ignoredFiles is on", async () => {
    const off = await makeDevice({ deviceId: "a" });
    await put(off.root, ".gitignore", "node_modules/\n*.log\n");
    await put(off.root, "src.txt", "s\n");
    await put(off.root, "node_modules/dep/index.js", "x\n");
    await put(off.root, "debug.log", "l\n");
    const snap = await off.engine.snapshot(off.projectId, "manual");
    expect(await files(off, must(snap).id)).toEqual([".gitignore", "src.txt"]);

    const on = await makeDevice({
      deviceId: "b",
      sync: { categories: { ignoredFiles: true } as never },
    });
    await put(on.root, ".gitignore", "node_modules/\n*.log\n");
    await put(on.root, "src.txt", "s\n");
    await put(on.root, "node_modules/dep/index.js", "x\n");
    await put(on.root, "debug.log", "l\n");
    const all = await on.engine.snapshot(on.projectId, "manual");
    expect(await files(on, must(all).id)).toEqual([
      ".gitignore",
      "debug.log",
      "node_modules/dep/index.js",
      "src.txt",
    ]);
  });

  it("skips files over the size cap and reports a notice", async () => {
    const device = await makeDevice({ deviceId: "a", maxFileBytes: 100 });
    await put(device.root, "small.txt", "ok\n");
    await put(device.root, "big.bin", "x".repeat(500));
    const snap = await device.engine.snapshot(device.projectId, "manual");
    expect(await files(device, must(snap).id)).toEqual(["small.txt"]);
    expect(device.notices.join("\n")).toContain("big.bin");
  });

  it("never snapshots the Wooky home inside the project", async () => {
    const root = await tempDir("wooky-proj-");
    const device = await makeDevice({ deviceId: "a", root, home: join(root, ".wooky") });
    await put(root, "a.txt", "a\n");
    await put(root, ".wooky/state.sqlite", "db\n");
    const snap = await device.engine.snapshot(device.projectId, "manual");
    expect(await files(device, must(snap).id)).toEqual(["a.txt"]);
  });

  it("does not re-read the project when an interval scan finds nothing changed", async () => {
    if (process.platform === "win32") return;
    const logDir = await tempDir("wooky-gitlog-");
    const wrapper = join(logDir, "git-wrapper.sh");
    const log = join(logDir, "calls.log");
    await writeFile(wrapper, `#!/bin/sh\necho "$@" >> "${log}"\nexec git "$@"\n`);
    await chmod(wrapper, 0o755);
    const device = await makeDevice({ deviceId: "a", gitBin: wrapper });
    await put(device.root, "a.txt", "1\n");
    await device.engine.snapshot(device.projectId, "interval", {}, { gate: true });
    const calls = async () => (await read(logDir, "calls.log")).split("\n");
    const before = (await calls()).length;
    expect(
      await device.engine.snapshot(device.projectId, "interval", {}, { gate: true }),
    ).toBeNull();
    const added = (await calls()).slice(before - 1).join("\n");
    expect(added).not.toContain("update-index");
    expect(added).not.toContain("write-tree");
    await put(device.root, "a.txt", "2\n");
    expect(
      await device.engine.snapshot(device.projectId, "interval", {}, { gate: true }),
    ).not.toBeNull();
  });
});

describe("timers", () => {
  it("runs nothing while sync is off and scans on the interval once it is on", async () => {
    const device = await makeDevice({ deviceId: "a", sync: { enabled: false, intervalSec: 10 } });
    device.engine.refresh();
    expect(device.timers.intervals.size + device.timers.timeouts.size).toBe(0);
    await expect(device.engine.now()).rejects.toBeInstanceOf(ServiceError);

    device.settings.sync = { ...device.settings.sync, enabled: true };
    device.engine.refresh();
    expect([...device.timers.intervals.values()].map((t) => t.ms)).toEqual([10_000]);
    expect([...device.timers.timeouts.values()].map((t) => t.ms)).toEqual([10 * 60_000]);

    await put(device.root, "a.txt", "1\n");
    await device.engine.tick();
    expect((await device.engine.list({})).map((s) => s.reason)).toEqual(["interval"]);

    device.settings.sync = { ...device.settings.sync, enabled: false };
    device.engine.refresh();
    expect(device.timers.intervals.size + device.timers.timeouts.size).toBe(0);
  });

  it("snapshots when a turn finishes", async () => {
    const device = await makeDevice({ deviceId: "a" });
    await put(device.root, "a.txt", "1\n");
    await device.engine.turnFinished({ projectId: device.projectId, threadId: "t", turnId: "u" });
    const [snap] = await device.engine.list({});
    expect(snap).toMatchObject({ reason: "turn", threadId: "t" });
  });
});

describe("restore", () => {
  async function history() {
    const device = await makeDevice({ deviceId: "a" });
    await put(device.root, "a.txt", "a1\n");
    await put(device.root, "b.txt", "b1\n");
    await put(device.root, "keep.log", "ignored\n");
    await put(device.root, ".gitignore", "*.log\n");
    const first = await device.engine.snapshot(device.projectId, "manual");
    await put(device.root, "a.txt", "a2\n");
    await put(device.root, "c.txt", "c2\n");
    await device.engine.snapshot(device.projectId, "manual");
    await (await import("node:fs/promises")).rm(join(device.root, "b.txt"));
    const last = await device.engine.snapshot(device.projectId, "manual");
    return { device, first: must(first), last: must(last) };
  }

  it("restores a snapshot, deletes tracked files that are gone from it, and keeps a backup", async () => {
    const { device, first, last } = await history();
    const { backupSnapshotId } = await device.engine.restore({ snapshotId: first.id });
    expect(backupSnapshotId).toBe(last.id);
    expect(await read(device.root, "a.txt")).toBe("a1\n");
    expect(await read(device.root, "b.txt")).toBe("b1\n");
    expect(existsSync(join(device.root, "c.txt"))).toBe(false);
    expect(await read(device.root, "keep.log")).toBe("ignored\n");

    const reasons = (await device.engine.list({})).map((s) => s.reason);
    expect(reasons[0]).toBe("revert");
    // The backup can undo the restore.
    await device.engine.restore({ snapshotId: backupSnapshotId });
    expect(await read(device.root, "a.txt")).toBe("a2\n");
    expect(existsSync(join(device.root, "b.txt"))).toBe(false);
    expect(await read(device.root, "c.txt")).toBe("c2\n");
  });

  it("takes a before-apply snapshot of uncommitted work first", async () => {
    const { device, first } = await history();
    await put(device.root, "a.txt", "edited after the last snapshot\n");
    const { backupSnapshotId } = await device.engine.restore({ snapshotId: first.id });
    const listed = await device.engine.list({});
    expect(listed.find((s) => s.id === backupSnapshotId)?.reason).toBe("before-apply");
    await device.engine.restore({ snapshotId: backupSnapshotId });
    expect(await read(device.root, "a.txt")).toBe("edited after the last snapshot\n");
  });

  it("restores only the requested paths", async () => {
    const { device, first } = await history();
    await device.engine.restore({ snapshotId: first.id, paths: ["a.txt"] });
    expect(await read(device.root, "a.txt")).toBe("a1\n");
    expect(existsSync(join(device.root, "b.txt"))).toBe(false);
    expect(await read(device.root, "c.txt")).toBe("c2\n");
  });

  it("refuses while a turn is running in the project", async () => {
    const { device, first } = await history();
    device.running.add(device.projectId);
    await expect(device.engine.restore({ snapshotId: first.id })).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("turn is running"),
    });
    expect(await read(device.root, "a.txt")).toBe("a2\n");
  });

  it("refuses paths that leave the project", async () => {
    const { device, first } = await history();
    await expect(
      device.engine.restore({ snapshotId: first.id, paths: ["../x"] }),
    ).rejects.toMatchObject({ code: "bad_request" });
  });
});

describe("list and diff", () => {
  it("lists newest first with filters and pagination", async () => {
    const device = await makeDevice({ deviceId: "a" });
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      await put(device.root, "a.txt", `v${i}\n`);
      const snap = await device.engine.snapshot(device.projectId, "turn", {
        threadId: i % 2 ? "t-odd" : "t-even",
      });
      ids.push(must(snap).id);
    }
    const all = await device.engine.list({ projectId: device.projectId });
    expect(all.map((s) => s.id)).toEqual([...ids].reverse());
    const page = await device.engine.list({ limit: 2, before: must(all[1]).id });
    expect(page.map((s) => s.id)).toEqual([must(all[2]).id, must(all[3]).id]);
    const odd = await device.engine.list({ threadId: "t-odd" });
    expect(odd).toHaveLength(2);
    expect(await device.engine.list({ kind: "settings" })).toEqual([]);
  });

  it("diffs against the parent, another snapshot, and the working copy", async () => {
    const device = await makeDevice({ deviceId: "a" });
    await put(device.root, "a.txt", "one\n");
    const first = await device.engine.snapshot(device.projectId, "manual");
    await put(device.root, "a.txt", "two\n");
    await put(device.root, "new.txt", "n\n");
    const second = await device.engine.snapshot(device.projectId, "manual");

    const own = await device.engine.diff({ snapshotId: must(second).id });
    expect(own.map((f) => [f.path, f.status])).toEqual([
      ["a.txt", "modified"],
      ["new.txt", "added"],
    ]);
    expect(must(own[0]).patch).toContain("-one");
    expect(must(own[0]).patch).toContain("+two");

    const root = await device.engine.diff({ snapshotId: must(first).id });
    expect(root.map((f) => f.status)).toEqual(["added"]);

    const between = await device.engine.diff({
      snapshotId: must(second).id,
      against: must(first).id,
    });
    expect(between.map((f) => f.path)).toEqual(["a.txt", "new.txt"]);

    await put(device.root, "a.txt", "three\n");
    const working = await device.engine.diff({ snapshotId: must(second).id, against: "working" });
    expect(working.map((f) => f.path)).toEqual(["a.txt"]);
    expect(must(working[0]).patch).toContain("-three");
    expect(must(working[0]).patch).toContain("+two");
  });
});
