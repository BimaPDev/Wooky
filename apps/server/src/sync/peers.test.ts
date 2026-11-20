import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupSyncTests,
  makeDevice,
  pair,
  put,
  read,
  tempDir,
  type Device,
  must,
} from "./testing.ts";

afterEach(cleanupSyncTests);

const BASE = "line1\nline2\nline3\n";

/** Two devices with the same starting content and one synced round, so both know a base. */
async function twoDevices(extra: Record<string, string> = {}) {
  const a = await makeDevice({ deviceId: "devA", projectId: "proj" });
  const b = await makeDevice({ deviceId: "devB", projectId: "proj-b" });
  pair(a, b);
  for (const device of [a, b]) {
    await put(device.root, "f.txt", BASE);
    await put(device.root, "g.txt", "g\n");
    for (const [path, content] of Object.entries(extra)) await put(device.root, path, content);
  }
  await a.engine.now();
  await b.engine.now();
  await a.engine.now();
  return { a, b };
}

const snapshotsOf = async (device: Device) => device.engine.list({});

describe("two devices", () => {
  it("fast-forwards the other device when one edits", async () => {
    const { a, b } = await twoDevices();
    await put(a.root, "f.txt", "line1\nA\nline3\n");
    await put(a.root, "new/deep.txt", "d\n");
    await rm(join(a.root, "g.txt"));
    await a.engine.snapshot(a.projectId, "interval");
    await b.engine.now();
    expect(await read(b.root, "f.txt")).toBe("line1\nA\nline3\n");
    expect(await read(b.root, "new/deep.txt")).toBe("d\n");
    expect(existsSync(join(b.root, "g.txt"))).toBe(false);

    // Nothing was edited on B, so the previous tip already is the backup.
    const reasons = (await snapshotsOf(b)).map((s) => s.reason);
    expect(reasons[0]).toBe("incoming");
    expect(b.engine.status().peers).toEqual([
      expect.objectContaining({ deviceId: "devA", state: "idle", error: null }),
    ]);
    // The round trip does not echo: A finds nothing new to apply.
    await a.engine.now();
    expect(a.engine.status().conflicts).toEqual([]);
    expect(await read(a.root, "f.txt")).toBe("line1\nA\nline3\n");
  });

  it("snapshots uncommitted local work before applying, and a revert undoes the apply", async () => {
    const { a, b } = await twoDevices();
    await put(b.root, "mine.txt", "uncommitted on B\n");
    await put(a.root, "f.txt", "line1\nfrom A\nline3\n");
    await a.engine.snapshot(a.projectId, "interval");
    await b.engine.now();
    expect(await read(b.root, "f.txt")).toBe("line1\nfrom A\nline3\n");
    expect(await read(b.root, "mine.txt")).toBe("uncommitted on B\n");
    // Sync now snapshots B first, so B's uncommitted file is already in the snapshot the
    // incoming one is built on; that snapshot is the backup.
    const listed = await snapshotsOf(b);
    const incoming = listed.findIndex((s) => s.reason === "incoming");
    expect(incoming).toBeGreaterThanOrEqual(0);
    const backup = listed[incoming + 1];
    await b.engine.restore({ snapshotId: must(backup).id });
    expect(await read(b.root, "f.txt")).toBe(BASE);
    expect(await read(b.root, "mine.txt")).toBe("uncommitted on B\n");
  });

  it("merges edits to different files cleanly in both directions", async () => {
    const { a, b } = await twoDevices();
    await put(a.root, "a-only.txt", "from a\n");
    await put(b.root, "g.txt", "g changed on b\n");
    await a.engine.snapshot(a.projectId, "interval");
    await b.engine.snapshot(b.projectId, "interval");
    await b.engine.now();
    await a.engine.now();
    await b.engine.now();
    for (const device of [a, b]) {
      expect(await read(device.root, "a-only.txt")).toBe("from a\n");
      expect(await read(device.root, "g.txt")).toBe("g changed on b\n");
      expect(device.engine.status().conflicts).toEqual([]);
    }
  });

  it("merges edits to different lines of the same file", async () => {
    const { a, b } = await twoDevices();
    await put(a.root, "f.txt", "A1\nline2\nline3\n");
    await put(b.root, "f.txt", "line1\nline2\nB3\n");
    await a.engine.snapshot(a.projectId, "interval");
    await b.engine.now();
    expect(await read(b.root, "f.txt")).toBe("A1\nline2\nB3\n");
  });

  async function conflicted() {
    const { a, b } = await twoDevices();
    await put(a.root, "f.txt", "line1\nFROM-A\nline3\n");
    await put(a.root, "other.txt", "clean incoming change\n");
    await put(b.root, "f.txt", "line1\nFROM-B\nline3\n");
    await a.engine.snapshot(a.projectId, "interval");
    await b.engine.now();
    return { a, b };
  }

  it("raises a conflict for the same line and applies nothing", async () => {
    const { b } = await conflicted();
    const { conflicts } = b.engine.status();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      projectId: "proj-b",
      peerDeviceId: "devA",
      paths: ["f.txt"],
    });
    expect(await read(b.root, "f.txt")).toBe("line1\nFROM-B\nline3\n");
    expect(existsSync(join(b.root, "other.txt"))).toBe(false);
    expect(b.pushes.some((push) => push.kind === "conflict")).toBe(true);
    // A second pull does not raise the same conflict again.
    await b.engine.now();
    expect(b.engine.status().conflicts).toHaveLength(1);
  });

  it("resolves a conflict with mine: keeps local lines, never re-raises", async () => {
    const { b } = await conflicted();
    const [conflict] = b.engine.status().conflicts;
    await b.engine.resolve({ conflictId: must(conflict).id, resolution: "mine" });
    expect(await read(b.root, "f.txt")).toBe("line1\nFROM-B\nline3\n");
    expect(await read(b.root, "other.txt")).toBe("clean incoming change\n");
    expect(b.engine.status().conflicts).toEqual([]);
    await b.engine.now();
    expect(b.engine.status().conflicts).toEqual([]);
    expect(await read(b.root, "f.txt")).toBe("line1\nFROM-B\nline3\n");
  });

  it("resolves a conflict with theirs: takes the incoming lines after a backup", async () => {
    const { b } = await conflicted();
    const [conflict] = b.engine.status().conflicts;
    await b.engine.resolve({ conflictId: must(conflict).id, resolution: "theirs" });
    expect(await read(b.root, "f.txt")).toBe("line1\nFROM-A\nline3\n");
    expect(await read(b.root, "other.txt")).toBe("clean incoming change\n");
    const backup = (await snapshotsOf(b)).find((s) => s.id === must(conflict).mine);
    expect(backup).toBeDefined();
    const restored = await b.engine.diff({ snapshotId: must(conflict).mine, against: "working" });
    expect(restored.map((f) => f.path)).toContain("f.txt");
    expect(must(restored.find((f) => f.path === "f.txt")).patch).toContain("+FROM-B");
  });

  it("resolves a conflict with both: keeps local and writes the incoming file as .theirs", async () => {
    const { b } = await conflicted();
    const [conflict] = b.engine.status().conflicts;
    await b.engine.resolve({ conflictId: must(conflict).id, resolution: "both" });
    expect(await read(b.root, "f.txt")).toBe("line1\nFROM-B\nline3\n");
    expect(await read(b.root, "f.theirs.txt")).toBe("line1\nFROM-A\nline3\n");
    expect(b.engine.status().conflicts).toEqual([]);
  });

  it("queues an incoming change while a turn runs and applies it when the turn finishes", async () => {
    const { a, b } = await twoDevices();
    await put(a.root, "f.txt", "line1\nA\nline3\n");
    await a.engine.snapshot(a.projectId, "interval");
    b.running.add(b.projectId);
    await b.engine.now();
    expect(await read(b.root, "f.txt")).toBe(BASE);

    b.running.delete(b.projectId);
    await b.engine.turnFinished({ projectId: b.projectId, threadId: "t", turnId: "u" });
    expect(await read(b.root, "f.txt")).toBe("line1\nA\nline3\n");
  });

  it("keeps a change made during a turn instead of overwriting it with the queued apply", async () => {
    const { a, b } = await twoDevices();
    await put(a.root, "g.txt", "g from a\n");
    await a.engine.snapshot(a.projectId, "interval");
    b.running.add(b.projectId);
    await b.engine.now();
    await put(b.root, "f.txt", "line1\nagent edit\nline3\n");
    b.running.delete(b.projectId);
    await b.engine.turnFinished({ projectId: b.projectId, threadId: "t", turnId: "u" });
    expect(await read(b.root, "f.txt")).toBe("line1\nagent edit\nline3\n");
    expect(await read(b.root, "g.txt")).toBe("g from a\n");
  });

  it("lists a project the peer shares but this device has not mapped, without calling the peer errored", async () => {
    const a = await makeDevice({ deviceId: "devA", projectId: "proj", name: "Billing API" });
    const b = await makeDevice({ deviceId: "devB", projectId: "proj-b" });
    pair(a, b);
    b.settings.sync = { ...b.settings.sync, projectMap: {} };
    await put(a.root, "f.txt", "x\n");
    await a.engine.snapshot(a.projectId, "manual");
    await b.engine.now();
    const [peer] = b.engine.status().peers;
    // Neutral: nothing is wrong, the project just is not mapped here yet.
    expect(peer).toMatchObject({ deviceId: "devA", state: "idle", error: null });
    expect(must(peer).projects).toEqual([
      expect.objectContaining({
        id: "proj",
        sharedId: "proj",
        name: "Billing API",
        mappedTo: null,
      }),
    ]);
    expect(existsSync(join(b.root, "f.txt"))).toBe(false);
  });

  it("suggests the local project with the same remote, however the remote is spelled", async () => {
    const a = await makeDevice({
      deviceId: "devA",
      projectId: "proj",
      name: "Billing API",
      remote: "github.com/acme/billing",
      branch: "main",
    });
    const b = await makeDevice({
      deviceId: "devB",
      projectId: "proj-b",
      name: "work",
      remote: "github.com/acme/billing",
    });
    pair(a, b);
    b.settings.sync = { ...b.settings.sync, projectMap: {} };
    await a.engine.snapshot(a.projectId, "manual");
    await b.engine.now();
    const [project] = must(b.engine.status().peers[0]).projects;
    expect(project).toMatchObject({
      remote: "github.com/acme/billing",
      branch: "main",
      mappedTo: null,
      suggestion: { projectId: "proj-b", by: "remote" },
    });
  });

  it("falls back to the same folder name, and suggests nothing when two projects tie", async () => {
    const a = await makeDevice({ deviceId: "devA", projectId: "proj", name: "App" });
    const folder = basename(a.root);
    const b = await makeDevice({
      deviceId: "devB",
      projectId: "proj-b",
      root: join(await tempDir("wooky-parent-"), folder),
    });
    pair(a, b);
    b.settings.sync = { ...b.settings.sync, projectMap: {} };
    await put(b.root, "keep.txt", "k\n");
    await a.engine.snapshot(a.projectId, "manual");
    await b.engine.now();
    expect(must(b.engine.status().peers[0]).projects[0]?.suggestion).toEqual({
      projectId: "proj-b",
      by: "folder",
    });
    // A second local folder with the same name makes the answer ambiguous: no one-click guess.
    const second = join(await tempDir("wooky-parent2-"), folder);
    await put(second, "x.txt", "x\n");
    b.projects.push({ id: "proj-c", name: "other", root: second });
    await b.engine.now();
    expect(must(b.engine.status().peers[0]).projects[0]?.suggestion).toBeNull();
  });

  it("syncs into the local project once the user maps it, keyed by the peer's project id", async () => {
    const a = await makeDevice({ deviceId: "devA", projectId: "proj", name: "App" });
    const b = await makeDevice({ deviceId: "devB", projectId: "proj-b" });
    pair(a, b);
    b.settings.sync = { ...b.settings.sync, projectMap: {} };
    await put(a.root, "f.txt", "from a\n");
    await a.engine.snapshot(a.projectId, "manual");
    await b.engine.now();
    expect(existsSync(join(b.root, "f.txt"))).toBe(false);
    b.settings.sync = {
      ...b.settings.sync,
      projectMap: { proj: { devB: b.root } },
    };
    await b.engine.now();
    expect(await read(b.root, "f.txt")).toBe("from a\n");
    expect(must(b.engine.status().peers[0]).projects[0]).toMatchObject({ mappedTo: "proj-b" });
  });

  it("an entry that names a path outside the registered projects maps nothing", async () => {
    const a = await makeDevice({ deviceId: "devA", projectId: "proj" });
    const b = await makeDevice({ deviceId: "devB", projectId: "proj-b" });
    const outside = await tempDir("wooky-outside-");
    pair(a, b);
    b.settings.sync = { ...b.settings.sync, projectMap: { proj: { devB: outside } } };
    await put(a.root, "f.txt", "x\n");
    await a.engine.snapshot(a.projectId, "manual");
    await b.engine.now();
    expect(existsSync(join(outside, "f.txt"))).toBe(false);
    expect(existsSync(join(b.root, "f.txt"))).toBe(false);
    expect(must(b.engine.status().peers[0]).projects[0]).toMatchObject({ mappedTo: null });
  });

  it("marks an unreachable peer offline", async () => {
    const { a, b } = await twoDevices();
    await new Promise<void>((done) => must(a.server).close(() => done()));
    must(a.server).closeAllConnections();
    await b.engine.now();
    expect(b.engine.status().peers[0]).toMatchObject({ deviceId: "devA", state: "offline" });
  });

  it("recovers when the sender squashed its history", async () => {
    const { a, b } = await twoDevices();
    for (let i = 0; i < 4; i += 1) {
      await put(a.root, "f.txt", `v${i}\n`);
      await a.engine.snapshot(a.projectId, "interval");
    }
    await b.engine.now();
    a.settings.sync = { ...a.settings.sync, retention: { keepDays: 1, keepMin: 1 } };
    a.clock.time += 10 * 24 * 3600_000;
    await put(a.root, "f.txt", "after squash\n");
    await a.engine.snapshot(a.projectId, "interval");
    await a.engine.retain();
    await b.engine.now();
    expect(await read(b.root, "f.txt")).toBe("after squash\n");
  });
});

describe("retention", () => {
  it("squashes old snapshots, keeps the newest, and leaves a valid repo", async () => {
    const a = await makeDevice({
      deviceId: "devA",
      sync: { retention: { keepDays: 1, keepMin: 3 } },
    });
    const ids: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      await put(a.root, "f.txt", `v${i}\n`);
      ids.push(must(await a.engine.snapshot(a.projectId, "interval")).id);
    }
    a.clock.time += 5 * 24 * 3600_000;
    await put(a.root, "f.txt", "recent\n");
    const recent = must(await a.engine.snapshot(a.projectId, "interval"));
    const before = await a.engine.list({});
    expect(before).toHaveLength(9);

    await a.engine.retain();

    const after = await a.engine.list({});
    // keepMin 3 newest are rewritten, plus one squashed base for everything older.
    expect(after).toHaveLength(4);
    expect(after[0]).toMatchObject({ reason: "interval", summary: recent.summary });
    expect(must(after[3]).parentId).toBeNull();
    expect(must(must(after[3]).summary).filesChanged).toBe(1);
    const repo = a.engine.repoFor({ id: a.projectId, root: a.root });
    await a.engine.shadow.fsck(repo);
    expect(await a.engine.shadow.rev(repo, must(ids[0]))).toBeNull();
    const newestTree = await a.engine.shadow.treeOf(repo, must(after[0]).id);
    expect(await a.engine.shadow.treeOf(repo, recent.id).catch(() => newestTree)).toBe(newestTree);
    // The rewritten chain still restores.
    await a.engine.restore({ snapshotId: must(after[1]).id });
    expect(await read(a.root, "f.txt")).toBe("v7\n");
  });

  it("keeps everything newer than keepDays even below keepMin", async () => {
    const a = await makeDevice({
      deviceId: "devA",
      sync: { retention: { keepDays: 30, keepMin: 1 } },
    });
    for (let i = 0; i < 4; i += 1) {
      await put(a.root, "f.txt", `v${i}\n`);
      await a.engine.snapshot(a.projectId, "interval");
    }
    await a.engine.retain();
    expect(await a.engine.list({})).toHaveLength(4);
  });

  it("never prunes the backup an open conflict points at", async () => {
    const { a, b } = await twoDevices();
    await put(a.root, "f.txt", "line1\nFROM-A\nline3\n");
    await put(b.root, "f.txt", "line1\nFROM-B\nline3\n");
    await a.engine.snapshot(a.projectId, "interval");
    await b.engine.now();
    const [conflict] = b.engine.status().conflicts;
    for (let i = 0; i < 5; i += 1) {
      await put(b.root, "g.txt", `g${i}\n`);
      await b.engine.snapshot(b.projectId, "interval");
    }
    b.settings.sync = { ...b.settings.sync, retention: { keepDays: 1, keepMin: 1 } };
    b.clock.time += 10 * 24 * 3600_000;
    await b.engine.retain();
    const open = must(b.engine.status().conflicts[0]);
    const listed = await b.engine.list({});
    expect(listed.some((s) => s.id === open.mine)).toBe(true);
    expect(must(conflict).id).toBe(open.id);
    await b.engine.resolve({ conflictId: open.id, resolution: "mine" });
  });
});

describe("peer routes", () => {
  it("answers 401 without a token and 403 to a device that is not a peer", async () => {
    const a = await makeDevice({ deviceId: "devA", projectId: "proj" });
    await put(a.root, "f.txt", "x\n");
    await a.engine.snapshot(a.projectId, "manual");
    for (const path of ["/sync/bundle?project=proj", "/sync/tips", "/sync/unknown"]) {
      expect((await fetch(`${a.url}${path}`)).status).toBe(401);
      expect(
        (await fetch(`${a.url}${path}`, { headers: { authorization: "Bearer wrong" } })).status,
      ).toBe(401);
    }
    a.auth.caller = "stranger";
    const headers = { authorization: "Bearer secret" };
    expect((await fetch(`${a.url}/sync/tips`, { headers })).status).toBe(403);
  });

  it("serves tips and a bundle to a peer", async () => {
    const a = await makeDevice({ deviceId: "devA", projectId: "proj" });
    const b = await makeDevice({ deviceId: "devB", projectId: "proj-b" });
    pair(a, b);
    await put(a.root, "f.txt", "x\n");
    const snap = await a.engine.snapshot(a.projectId, "manual");
    const headers = { authorization: "Bearer secret" };
    const tips = await (await fetch(`${a.url}/sync/tips`, { headers })).json();
    expect(tips).toEqual([{ projectId: "proj", tip: must(snap).id }]);
    const bundle = await fetch(
      `${a.url}/sync/bundle?project=proj&have=0000000000000000000000000000000000000000`,
      { headers },
    );
    expect(bundle.status).toBe(200);
    expect(bundle.headers.get("content-type")).toBe("application/octet-stream");
    expect(new TextDecoder().decode((await bundle.arrayBuffer()).slice(0, 16))).toContain(
      "# v2 git bundle",
    );
    expect((await fetch(`${a.url}/sync/bundle?project=missing`, { headers })).status).toBe(404);
    expect((await fetch(`${a.url}/sync/bundle`, { headers })).status).toBe(400);
    expect((await fetch(`${a.url}/sync/tips`, { method: "POST", headers })).status).toBe(405);
  });

  it("serves nothing while sync is off", async () => {
    const a = await makeDevice({ deviceId: "devA", projectId: "proj" });
    const b = await makeDevice({ deviceId: "devB", projectId: "proj-b" });
    pair(a, b);
    a.settings.sync = { ...a.settings.sync, enabled: false };
    const response = await fetch(`${a.url}/sync/tips`, {
      headers: { authorization: "Bearer secret" },
    });
    expect(response.status).toBe(403);
  });
});
