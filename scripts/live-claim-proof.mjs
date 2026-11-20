// Live proof: "Continue on this device" set up from the RECEIVING device, with no hand editing.
// Two real Wooky server processes, paired through the real pairing flow. The same repository sits at
// different paths with differently spelled remotes (one with credentials). Nothing is mapped. The
// receiver (B) sees the owner's (A) project as "not mapped here" without calling the peer errored,
// is offered a one-click match by remote, maps it, and a claim then moves the thread and its files.
// B is then restarted to show the mapping survives.
//
//   node scripts/live-claim-proof.mjs            run the whole thing and exit
//   node scripts/live-claim-proof.mjs --pause    stop after the unmapped state, print B's URL, and wait
//                                                for the file it names (to drive B's UI by hand or from a
//                                                browser); the claim step uses a mapping made there
// Needs `pnpm install`; with --pause, also `pnpm --filter @wooky/web build`. Ports 47321 and 47322.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const REPO = process.cwd();
const PAUSE = process.argv.includes("--pause");
const { WebSocket } = await import(join(REPO, "apps/server/node_modules/ws/wrapper.mjs"));
const TSX = join(REPO, "apps/server/node_modules/.bin/tsx");

const base = mkdtempSync(join(tmpdir(), "wooky-claim-"));
const A = {
  name: "A (work Mac)",
  port: 47321,
  home: join(base, "mac-home"),
  root: join(base, "mac", "work", "billing-api"),
  remote: "https://deploy:s3cret-token@GitHub.com/Acme/Billing.git",
};
const B = {
  name: "B (home PC)",
  port: 47322,
  home: join(base, "pc-home"),
  root: join(base, "pc", "Users", "me", "home-billing"),
  remote: "git@github.com:acme/billing",
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function start(device) {
  mkdirSync(device.home, { recursive: true });
  const args = ["apps/server/src/bin.ts", "--port", String(device.port), "--home", device.home];
  if (PAUSE) args.push("--web-dist", join(REPO, "apps/web/dist"));
  const child = spawn(TSX, args, {
    cwd: REPO,
    env: { ...process.env, WOOKY_SKIP_SHELL_ENV: "1", WOOKY_PORT: "", WOOKY_HOME: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
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
      if ((await fetch(`${device.url}/healthz`)).ok) return;
    } catch {}
    await sleep(200);
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

async function until(read, what, ms = 40000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();
const put = (root, file, text) => (
  mkdirSync(join(root, file, ".."), { recursive: true }),
  writeFileSync(join(root, file), text)
);

try {
  say("Create the same repository at two different paths, with differently spelled remotes");
  for (const device of [A, B]) {
    mkdirSync(device.root, { recursive: true });
    git(device.root, "init", "-q", "-b", "main");
    git(device.root, "remote", "add", "origin", device.remote);
  }
  put(A.root, "README.md", "# billing\n");
  put(A.root, "src/invoice.txt", "invoice v1\n");
  log(`A: ${A.root}  origin ${A.remote}`);
  log(`B: ${B.root}  origin ${B.remote}`);

  say("Start two real servers and pair them both ways with labels the user chose");
  start(A);
  start(B);
  await Promise.all([waitUp(A), waitUp(B)]);
  const infoA = await rpc(A, "device.info");
  const infoB = await rpc(B, "device.info");
  const codeA = await rpc(A, "remote.pairingCode.create");
  await rpc(B, "remote.join", {
    connection: { kind: "direct", url: A.url },
    code: codeA.code,
    label: "Work Mac",
  });
  const codeB = await rpc(B, "remote.pairingCode.create");
  await rpc(A, "remote.join", {
    connection: { kind: "direct", url: B.url },
    code: codeB.code,
    label: "Home PC",
  });
  const sync = (peer) => ({ enabled: true, intervalSec: 3600, peers: [peer] });
  await rpc(A, "settings.put", { settings: { sync: sync(infoB.deviceId) } });
  await rpc(B, "settings.put", { settings: { sync: sync(infoA.deviceId) } });
  log(`A ${A.url} (${infoA.deviceId})   B ${B.url} (${infoB.deviceId})`);

  say("Register each folder as a project and start a thread on A. Nothing is mapped on B");
  const addProject = async (device) => {
    await rpc(device, "dispatch", {
      type: "project.add",
      commandId: randomUUID(),
      root: device.root,
    });
    const model = await rpc(device, "snapshot");
    return Object.values(model.projects).find((p) => p.root.endsWith(device.root.split("/").pop()))
      .id;
  };
  A.projectId = await addProject(A);
  B.projectId = await addProject(B);
  await rpc(A, "dispatch", {
    type: "thread.create",
    commandId: randomUUID(),
    projectId: A.projectId,
    provider: "demo",
    model: "demo",
    runtimeMode: "full",
    isolate: false,
  });
  A.threadId = Object.keys((await rpc(A, "snapshot")).threads)[0];
  await rpc(A, "dispatch", {
    type: "turn.start",
    commandId: randomUUID(),
    threadId: A.threadId,
    prompt: "Add invoice totals",
  });
  await until(
    async () => (await rpc(A, "snapshot")).threads[A.threadId]?.status === "idle",
    "A's turn to finish",
  );
  const settings0 = await rpc(B, "settings.get");
  check("nothing is mapped on B", Object.keys(settings0.sync.projectMap).length === 0);

  say("B syncs: the owner's project shows up as 'not mapped here', and the peer is NOT errored");
  await rpc(B, "sync.now", {});
  await rpc(A, "sync.now", {});
  await rpc(B, "sync.now", {});
  const status1 = await rpc(B, "sync.status");
  const peer1 = status1.peers.find((p) => p.deviceId === infoA.deviceId);
  const listed = peer1?.projects.find((p) => p.id === A.projectId);
  log(`peer: ${JSON.stringify({ name: peer1?.name, state: peer1?.state, error: peer1?.error })}`);
  log(`listed: ${JSON.stringify(listed)}`);
  check("peer is listed by the label the user gave the machine", peer1?.name === "Work Mac");
  check("peer is idle, not errored", peer1?.state === "idle" && peer1?.error === null);
  check(
    "the project carries its display name, folder name, remote and branch",
    listed?.name === "billing-api" &&
      listed?.folder === "billing-api" &&
      listed?.remote === "github.com/acme/billing" &&
      listed?.branch === "main",
  );
  check("no credential left A's machine", !JSON.stringify(status1).includes("s3cret"));
  check("the project is not mapped here", listed?.mappedTo === null);
  check(
    "B is offered its own project, matched by remote",
    listed?.suggestion?.projectId === B.projectId && listed?.suggestion?.by === "remote",
  );
  check("no files were written to B yet", !existsSync(join(B.root, "src/invoice.txt")));

  if (PAUSE) {
    const flag = join(base, "continue");
    out(`\n    PAUSED. Open B in a browser: ${B.url}   (A: ${A.url})`);
    out(`    Work Mac thread id: ${A.threadId}`);
    out(`    When done, create this file to continue: ${flag}`);
    await until(async () => existsSync(flag), "the continue file", 3_600_000);
  }

  say("One click: map the suggestion (what the banner's 'Use <project>' button does)");
  let settings1 = await rpc(B, "settings.get");
  if (Object.keys(settings1.sync.projectMap).length === 0) {
    await rpc(B, "sync.projects.map", {
      sharedId: listed.sharedId,
      localProjectId: listed.suggestion.projectId,
    });
    settings1 = await rpc(B, "settings.get");
  } else log("(already mapped from the browser)");
  log(`B projectMap: ${JSON.stringify(settings1.sync.projectMap)}`);
  check(
    "stored keyed by the owner's project id, pointing at B's own folder",
    settings1.sync.projectMap[A.projectId]?.[infoB.deviceId]?.endsWith("home-billing") === true,
  );

  say("Continue on this device: the claim finds the mapping, pulls the files and moves the thread");
  await rpc(B, "sync.now", {});
  await rpc(B, "dispatch", {
    type: "thread.claim",
    commandId: randomUUID(),
    ownerDeviceId: infoA.deviceId,
    ownerThreadId: A.threadId,
    projectId: B.projectId,
  });
  const imported = await until(async () => {
    const model = await rpc(B, "snapshot");
    return Object.values(model.threads).find((t) => t.movedFrom?.threadId === A.threadId);
  }, "the claim to land");
  check("the thread now lives on B, in B's project", imported.projectId === B.projectId);
  check(
    "A's files arrived in B's own folder",
    existsSync(join(B.root, "src/invoice.txt")) &&
      readFileSync(join(B.root, "src/invoice.txt"), "utf8") === "invoice v1\n",
  );
  const modelA = await rpc(A, "snapshot");
  check(
    "A's copy says it moved to B",
    modelA.threads[A.threadId]?.movedTo?.deviceId === infoB.deviceId,
  );

  say("Restart B: the mapping is stored, so it survives");
  B.child.kill("SIGTERM");
  await sleep(1500);
  start(B);
  await waitUp(B);
  const settings2 = await rpc(B, "settings.get");
  check(
    "projectMap is unchanged after the restart",
    JSON.stringify(settings2.sync.projectMap) === JSON.stringify(settings1.sync.projectMap),
  );
  await rpc(B, "sync.now", {}).catch(() => {});
  const status2 = await rpc(B, "sync.status");
  const listed2 = status2.peers
    .find((p) => p.deviceId === infoA.deviceId)
    ?.projects.find((p) => p.id === A.projectId);
  check("the peer's project is still mapped to B's project", listed2?.mappedTo === B.projectId);
} catch (error) {
  failures += 1;
  console.error("\nPROOF ERROR:", error);
  for (const d of [A, B]) console.error(`--- ${d.name} server log ---\n${(d.log ?? []).join("")}`);
} finally {
  for (const child of procs) child.kill("SIGTERM");
  await sleep(800);
  rmSync(base, { recursive: true, force: true });
  out(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}
