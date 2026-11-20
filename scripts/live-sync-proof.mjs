// Live proof: two real Wooky server processes, paired through the real pairing flow, syncing a
// project folder that lives at a different path on each. Run from the repo root:
//   node scripts/live-sync-proof.mjs
// Needs `pnpm install` done. Uses ports 47311 and 47312 and throwaway temp dirs; exits 1 on any failed check.
import { spawn, execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const REPO = process.cwd();
const { WebSocket } = await import(join(REPO, "apps/server/node_modules/ws/wrapper.mjs"));
const TSX = join(REPO, "apps/server/node_modules/.bin/tsx");

const base = mkdtempSync(join(tmpdir(), "wooky-live-"));
const A = {
  name: "A (mac)",
  port: 47311,
  home: join(base, "mac-home"),
  root: join(base, "mac", "work", "app"),
};
const B = {
  name: "B (windows)",
  port: 47312,
  home: join(base, "win-home"),
  root: join(base, "win", "Users", "me", "app"),
};
const procs = [];
const out = (text) => process.stdout.write(`${text}\n`);
let step = 0;
const say = (text) => out(`\n[${++step}] ${text}`);
const log = (text) => out(`    ${text}`);
let failures = 0;
function check(label, ok, detail = "") {
  if (!ok) failures += 1;
  out(`    ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}

function start(device) {
  mkdirSync(device.home, { recursive: true });
  const child = spawn(
    TSX,
    ["apps/server/src/bin.ts", "--port", String(device.port), "--home", device.home],
    {
      cwd: REPO,
      env: { ...process.env, WOOKY_SKIP_SHELL_ENV: "1", WOOKY_PORT: "", WOOKY_HOME: "" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  device.log = [];
  child.stdout.on("data", (d) => device.log.push(String(d)));
  child.stderr.on("data", (d) => device.log.push(String(d)));
  procs.push(child);
  device.child = child;
  device.url = `http://127.0.0.1:${device.port}`;
}

async function waitUp(device) {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`${device.url}/healthz`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${device.name} did not start:\n${device.log.join("")}`);
}

function rpc(device, method, params = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${device.url.replace("http", "ws")}/ws`);
    const timer = setTimeout(
      () => (ws.terminate(), reject(new Error(`${method} timed out`))),
      60000,
    );
    ws.on("error", reject);
    ws.on("open", () => ws.send(JSON.stringify({ id: 1, method, params })));
    ws.on("message", (data) => {
      const msg = JSON.parse(String(data));
      if (msg.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (msg.ok === false) reject(new Error(`${method}: ${JSON.stringify(msg.error)}`));
      else resolve(msg.result);
    });
  });
}

const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();
const read = (root, file) => readFileSync(join(root, file), "utf8");
const put = (root, file, text) => (
  mkdirSync(join(root, file, ".."), { recursive: true }),
  writeFileSync(join(root, file), text)
);

try {
  say(
    "Create the project on A, a git repo with one commit; copy the same folder to B at a different path",
  );
  mkdirSync(A.root, { recursive: true });
  put(A.root, "README.md", "# demo\n");
  put(A.root, "src/app.txt", "one\ntwo\nthree\nfour\nfive\n");
  put(A.root, "obsolete.txt", "delete me\n");
  put(A.root, "notes.txt", "n1\nn2\nn3\n");
  git(A.root, "init", "-q", "-b", "main");
  git(A.root, "-c", "user.name=t", "-c", "user.email=t@t", "add", "-A");
  git(A.root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  mkdirSync(join(B.root, ".."), { recursive: true });
  cpSync(A.root, B.root, { recursive: true });
  log(`A root: ${A.root}`);
  log(`B root: ${B.root}`);

  say("Start two real server processes on two ports with separate WOOKY_HOME dirs");
  start(A);
  start(B);
  await Promise.all([waitUp(A), waitUp(B)]);
  const infoA = await rpc(A, "device.info");
  const infoB = await rpc(B, "device.info");
  log(`A ${A.url} deviceId=${infoA.deviceId}`);
  log(`B ${B.url} deviceId=${infoB.deviceId}`);
  check("distinct device identities", infoA.deviceId !== infoB.deviceId);

  say("Unauthenticated and bogus-token /sync requests are refused (401), even from loopback");
  for (const [label, headers] of [
    ["no token", {}],
    ["bogus token", { authorization: "Bearer nope" }],
  ]) {
    const res = await fetch(`${A.url}/sync/tips`, { headers });
    check(`GET /sync/tips with ${label} -> 401`, res.status === 401, `status ${res.status}`);
  }

  say("Pair both ways with the real pairing flow (code on one side, remote.join on the other)");
  const codeA = await rpc(A, "remote.pairingCode.create");
  const joinedOnB = await rpc(B, "remote.join", {
    connection: { kind: "direct", url: A.url },
    code: codeA.code,
  });
  log(`B joined A: host ${joinedOnB.host.name} (${joinedOnB.host.deviceId})`);
  const codeB = await rpc(B, "remote.pairingCode.create");
  const joinedOnA = await rpc(A, "remote.join", {
    connection: { kind: "direct", url: B.url },
    code: codeB.code,
  });
  log(`A joined B: host ${joinedOnA.host.name} (${joinedOnA.host.deviceId})`);
  check(
    "A knows B, B knows A",
    joinedOnB.host.deviceId === infoA.deviceId && joinedOnA.host.deviceId === infoB.deviceId,
  );
  check(
    "pairing code is single use",
    await rpc(B, "remote.join", {
      connection: { kind: "direct", url: A.url },
      code: codeA.code,
    }).then(
      () => false,
      () => true,
    ),
  );
  const devicesA = await rpc(A, "remote.devices.list");
  log(`A's paired devices: ${devicesA.map((d) => d.name).join(", ")}`);

  say(
    "Register the same project on both (different paths) and turn sync on with a shared project map",
  );
  const addProject = async (device, name) => {
    await rpc(device, "dispatch", {
      type: "project.add",
      commandId: randomUUID(),
      root: device.root,
      name,
    });
    const model = await rpc(device, "snapshot");
    const project = Object.values(model.projects).find((p) => p.root === device.root);
    if (!project) throw new Error(`project not registered on ${device.name}`);
    return project.id;
  };
  A.projectId = await addProject(A, "demo");
  B.projectId = await addProject(B, "demo");
  log(`A projectId=${A.projectId}`);
  log(`B projectId=${B.projectId}`);
  const projectMap = { "shared-demo": { [infoA.deviceId]: A.root, [infoB.deviceId]: B.root } };
  await rpc(A, "settings.put", {
    settings: { sync: { enabled: true, intervalSec: 3600, peers: [infoB.deviceId], projectMap } },
  });
  await rpc(B, "settings.put", {
    settings: { sync: { enabled: true, intervalSec: 3600, peers: [infoA.deviceId], projectMap } },
  });
  await rpc(A, "sync.now", {});
  await rpc(B, "sync.now", {});
  await rpc(A, "sync.now", {});
  const statusB0 = await rpc(B, "sync.status");
  log(
    `B peers: ${JSON.stringify(statusB0.peers.map((p) => ({ name: p.name, state: p.state, error: p.error })))}`,
  );
  check(
    "baseline: B holds A's files",
    read(B.root, "src/app.txt") === "one\ntwo\nthree\nfour\nfive\n",
  );

  say("Edit on A: change a tracked file (uncommitted), add an untracked file, delete a file");
  put(A.root, "src/app.txt", "one\nTWO from A\nthree\nfour\nfive\n");
  put(A.root, "docs/new-on-a.md", "created on A, never committed\n");
  rmSync(join(A.root, "obsolete.txt"));
  log(`A git status: ${git(A.root, "status", "--short").replace(/\n/g, " | ")}`);
  await rpc(A, "sync.now", {});
  await rpc(B, "sync.now", {});
  check(
    "modified file arrived on B",
    read(B.root, "src/app.txt") === "one\nTWO from A\nthree\nfour\nfive\n",
  );
  check(
    "uncommitted new file arrived on B",
    existsSync(join(B.root, "docs/new-on-a.md")) &&
      read(B.root, "docs/new-on-a.md").includes("created on A"),
  );
  check("deletion arrived on B", !existsSync(join(B.root, "obsolete.txt")));
  log(`B git status: ${git(B.root, "status", "--short").replace(/\n/g, " | ")}`);
  check(
    "B's own git history is untouched (still one commit)",
    git(B.root, "rev-list", "--count", "HEAD") === "1",
  );
  const snapsB1 = await rpc(B, "sync.snapshots.list", { projectId: B.projectId });
  log(`B snapshots (newest first): ${snapsB1.map((s) => s.reason).join(", ")}`);

  say("Edit conflicting lines on both sides (same line of notes.txt), A first, then B, then sync");
  put(A.root, "notes.txt", "n1\nA says hello\nn3\n");
  await rpc(A, "sync.now", {});
  put(B.root, "notes.txt", "n1\nB says goodbye\nn3\n");
  await rpc(B, "sync.now", {});
  const statusB1 = await rpc(B, "sync.status");
  log(
    `B conflicts: ${JSON.stringify(statusB1.conflicts.map((c) => ({ id: c.id, paths: c.paths, peer: c.peerDeviceId })))}`,
  );
  check(
    "a SyncConflict was raised on B",
    statusB1.conflicts.length === 1 && statusB1.conflicts[0].paths.includes("notes.txt"),
  );
  check(
    "the conflicting incoming change was NOT applied",
    read(B.root, "notes.txt") === "n1\nB says goodbye\nn3\n",
  );
  check(
    "A's copy is unchanged by B's side",
    read(A.root, "notes.txt") === "n1\nA says hello\nn3\n",
  );

  say(
    "Resolve with 'theirs' (takes a before-apply backup first), then revert B to that before-apply snapshot",
  );
  put(B.root, "scratch-on-b.txt", "B's unsynced work, made after the last snapshot\n");
  await rpc(B, "sync.conflicts.resolve", {
    conflictId: statusB1.conflicts[0].id,
    resolution: "theirs",
  });
  check(
    "B now has A's line after resolving",
    read(B.root, "notes.txt") === "n1\nA says hello\nn3\n",
  );
  const snapsB2 = await rpc(B, "sync.snapshots.list", { projectId: B.projectId });
  log(
    `B snapshots (newest first): ${snapsB2.map((s) => `${s.reason}:${s.id.slice(0, 8)}`).join(", ")}`,
  );
  const beforeApply = snapsB2.find((s) => s.reason === "before-apply");
  check("a before-apply snapshot exists", Boolean(beforeApply));
  const restored = await rpc(B, "sync.snapshots.restore", { snapshotId: beforeApply.id });
  log(`restore returned backupSnapshotId=${restored.backupSnapshotId.slice(0, 8)}`);
  check(
    "revert put B's own pre-merge line back",
    read(B.root, "notes.txt") === "n1\nB says goodbye\nn3\n",
  );
  check(
    "revert kept B's unsynced scratch file",
    read(B.root, "scratch-on-b.txt").includes("unsynced work"),
  );
  check(
    "revert keeps the earlier synced changes (app.txt, new file, deletion)",
    read(B.root, "src/app.txt").includes("TWO from A") &&
      existsSync(join(B.root, "docs/new-on-a.md")) &&
      !existsSync(join(B.root, "obsolete.txt")),
  );

  say("Revoke B on A: B's token must stop working");
  const peers = JSON.parse(readFileSync(join(B.home, "peers.json"), "utf8")).peers;
  const tokenB = peers[0].token;
  const before = await fetch(`${A.url}/sync/tips`, {
    headers: { authorization: `Bearer ${tokenB}` },
  });
  check("B's token works on A before revoke", before.status === 200, `status ${before.status}`);
  await rpc(A, "remote.devices.revoke", { deviceId: infoB.deviceId });
  const after = await fetch(`${A.url}/sync/tips`, {
    headers: { authorization: `Bearer ${tokenB}` },
  });
  check("B's token is refused after revoke", after.status === 401, `status ${after.status}`);
  put(A.root, "after-revoke.txt", "should not reach B\n");
  await rpc(A, "sync.now", {});
  await rpc(B, "sync.now", {});
  const statusB3 = await rpc(B, "sync.status");
  log(
    `B peer state after revoke: ${JSON.stringify(statusB3.peers.map((p) => ({ state: p.state, error: p.error })))}`,
  );
  check("a revoked device receives nothing", !existsSync(join(B.root, "after-revoke.txt")));
} catch (error) {
  failures += 1;
  console.error("\nPROOF ERROR:", error);
  for (const d of [A, B]) console.error(`--- ${d.name} server log ---\n${(d.log ?? []).join("")}`);
} finally {
  for (const child of procs) child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 800));
  rmSync(base, { recursive: true, force: true });
  out(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}
