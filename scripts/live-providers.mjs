// Live proof against REAL agent CLIs (spends a few tokens each). One real Wooky server with a clean
// home and a throwaway git project, driven over its WebSocket RPC exactly like the web client.
//
//   node scripts/live-providers.mjs <claude|opencode|cursor> [model] [--keep]
//
// Per provider: providers.list, a turn that streams and creates a file under approve mode (approval card
// answered), a resumed second turn, a queued prompt, interrupt mid-turn, checkpoint + revert, usage
// limits, an isolated-worktree thread, the Ship commit, then shutdown with an orphan-process check.
// Needs `pnpm install`. Uses port 47411.
import { spawn, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const REPO = process.cwd();
const provider = process.argv[2];
const modelArg = process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : null;
const KEEP = process.argv.includes("--keep");
if (!provider) throw new Error("usage: live-providers.mjs <claude|opencode|cursor> [model]");
const { WebSocket } = await import(join(REPO, "apps/server/node_modules/ws/wrapper.mjs"));
const TSX = join(REPO, "apps/server/node_modules/.bin/tsx");

const base = realpathSync(mkdtempSync(join(tmpdir(), `wooky-live-${provider}-`)));
const home = join(base, "home");
const root = join(base, "project");
const port = 47411;
const url = `http://127.0.0.1:${port}`;
const out = (t) => process.stdout.write(`${t}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const results = [];
function check(label, ok, detail = "") {
  if (!ok) failures += 1;
  results.push({ label, ok });
  out(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}
const say = (t) => out(`\n== ${t}`);
const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();

mkdirSync(home, { recursive: true });
mkdirSync(root, { recursive: true });
git(root, "init", "-q", "-b", "main");
git(root, "config", "user.email", "t@example.com");
git(root, "config", "user.name", "T");
writeFileSync(join(root, "README.md"), "# throwaway\n");
git(root, "add", "-A");
git(root, "commit", "-qm", "init");

const serverLog = [];
const server = spawn(TSX, ["apps/server/src/bin.ts", "--port", String(port), "--home", home], {
  cwd: REPO,
  env: { ...process.env, WOOKY_PORT: "", WOOKY_HOME: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (d) => serverLog.push(String(d)));
server.stderr.on("data", (d) => serverLog.push(String(d)));

process.on("exit", () => server.kill("SIGTERM"));
process.on("unhandledRejection", (e) => {
  out(`unhandled: ${e}`);
  process.exit(2);
});

// ---- ps helpers (read-only; we only ever signal pids we spawned) -------------------------------
function psTable() {
  const text = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  return text
    .split("\n")
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] }));
}
function descendants(rootPid) {
  const table = psTable();
  const found = [];
  const queue = [rootPid];
  while (queue.length) {
    const p = queue.shift();
    for (const row of table) {
      if (row.ppid === p && !found.some((f) => f.pid === row.pid)) {
        found.push(row);
        queue.push(row.pid);
      }
    }
  }
  return found;
}

// ---- RPC over one persistent socket -------------------------------------------------------------
const events = [];
let nextId = 1;
const pending = new Map();
let ws;
async function connect() {
  for (let i = 0; i < 150; i += 1) {
    try {
      if ((await fetch(`${url}/healthz`)).ok) break;
    } catch {}
    await sleep(200);
    if (i === 149) throw new Error(`server did not start:\n${serverLog.join("")}`);
  }
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((res, rej) => (ws.on("open", res), ws.on("error", rej)));
  ws.on("message", (data) => {
    const msg = JSON.parse(String(data));
    if (msg.push === "event") return void events.push({ ...msg.event, _t: Date.now() });
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok === false) p.reject(new Error(`${p.method}: ${JSON.stringify(msg.error)}`));
    else p.resolve(msg.result);
  });
}
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(
      () => (pending.delete(id), reject(new Error(`${method} timed out`))),
      60000,
    );
    pending.set(id, {
      method,
      resolve: (v) => (clearTimeout(timer), resolve(v)),
      reject: (e) => (clearTimeout(timer), reject(e)),
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
const dispatch = (command) => rpc("dispatch", { ...command, commandId: randomUUID() });
const snapshot = () => rpc("snapshot");
async function until(read, what, ms = 120000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await read();
    if (v) return v;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const turnsOf = async (threadId) => (await snapshot()).turns[threadId] ?? [];
const finished = async (threadId, count) => {
  let lastReport = 0;
  return until(
    async () => {
      const ts = await turnsOf(threadId);
      const turn = ts[count - 1];
      if (Date.now() - lastReport > 10000) {
        lastReport = Date.now();
        out(
          `  .. waiting: turn ${count} status=${turn?.status ?? "(none)"} items=${turn ? itemKinds(turn).join(",") : "-"} events=${events.length}`,
        );
      }
      return ts.length >= count && turn && turn.status !== "running" ? turn : null;
    },
    `turn ${count} to finish`,
    Number(process.env.WOOKY_TURN_TIMEOUT_MS ?? 180000),
  );
};
async function dumpState() {
  try {
    const snap = await snapshot();
    for (const [id, t] of Object.entries(snap.threads)) {
      out(
        `  thread ${id}: status=${t.status} model=${t.model ?? ""} session=${t.providerSessionId ?? ""} queue=${t.queue?.length ?? 0}`,
      );
    }
    for (const [id, ts] of Object.entries(snap.turns)) {
      for (const t of ts) {
        out(
          `  turn ${id}/${t.id}: status=${t.status} error=${t.error ?? ""} items=${itemKinds(t).join(",")}`,
        );
        for (const item of t.items) {
          if (item.kind === "notice" || item.kind === "tool")
            out(`    ${item.kind}: ${JSON.stringify(item).slice(0, 300)}`);
        }
      }
    }
    out(`  last events: ${JSON.stringify(events.slice(-12).map((e) => e.type)).slice(0, 600)}`);
    for (const e of events.slice(-12)) out(`    event ${JSON.stringify(e).slice(0, 300)}`);
  } catch (error) {
    out(`  dumpState failed: ${error}`);
  }
}

// auto-answer approvals while we wait, remembering what was asked
const approvals = [];
let approvalMode = "allow";
async function approvalPump() {
  const seen = new Set();
  while (!pumpState.stop) {
    for (const e of events) {
      if (e.type === "approval.requested" && !seen.has(e.requestId)) {
        seen.add(e.requestId);
        approvals.push(e);
        if (approvalMode) {
          await dispatch({
            type: "approval.respond",
            threadId: e.threadId,
            requestId: e.requestId,
            decision: approvalMode,
          }).catch((err) => out(`  (approval ${e.requestId} not answerable: ${err.message})`));
        }
      }
    }
    await sleep(100);
  }
}
const pumpState = { stop: false };

const itemKinds = (turn) => turn.items.map((i) => i.kind + (i.kind === "tool" ? `:${i.tool}` : ""));
const text = (turn) =>
  turn.items
    .filter((i) => i.kind === "message")
    .map((i) => i.text)
    .join("\n");

try {
  await connect();
  await rpc("subscribe", { fromSeq: 0 });
  const pump = approvalPump();

  say(`providers.list (${provider})`);
  const list = await rpc("providers.list");
  const status = list.find((p) => p.kind === provider);
  out(`  ${JSON.stringify({ ...status, models: status?.models?.length })}`);
  out(
    `  models: ${(status?.models ?? [])
      .slice(0, 12)
      .map((m) => m.id)
      .join(", ")}`,
  );
  check("installed", status?.installed === true);
  check(
    "model list present",
    (status?.models?.length ?? 0) > 0,
    `${status?.models?.length} models`,
  );
  const model = modelArg ?? status.models[0]?.id;
  out(`  using model: ${model}`);

  await dispatch({ type: "project.add", root });
  const projectId = Object.values((await snapshot()).projects).find((p) => p.root === root)?.id;
  check("project registered", !!projectId);

  say("thread + turn 1: create hello.txt in approve mode");
  await dispatch({
    type: "thread.create",
    projectId,
    provider,
    model,
    runtimeMode: "approve",
    isolate: false,
  });
  const threadId = Object.keys((await snapshot()).threads)[0];
  const t0 = Date.now();
  await dispatch({
    type: "turn.start",
    threadId,
    prompt:
      "Create a file hello.txt in the current directory containing exactly: hi. Then reply with the single word done.",
  });
  const turn1 = await finished(threadId, 1);
  out(
    `  ${((Date.now() - t0) / 1000).toFixed(1)}s status=${turn1.status} items=${itemKinds(turn1).join(",")}`,
  );
  out(`  reply: ${JSON.stringify(text(turn1).slice(0, 200))}  error=${turn1.error}`);
  check("turn 1 completed", turn1.status === "completed", turn1.error ?? "");
  const deltas = events.filter((e) => e.type === "turn.itemDelta" && e.turnId === turn1.id);
  const upserts = events.filter((e) => e.type === "turn.itemUpserted" && e.turnId === turn1.id);
  check(
    "streaming (deltas or progressive upserts)",
    deltas.length > 0 || upserts.length > 2,
    `${deltas.length} deltas, ${upserts.length} upserts`,
  );
  check(
    "a tool item for the edit",
    turn1.items.some((i) => i.kind === "tool" && (i.tool === "edit" || i.tool === "command")),
  );
  check(
    "approval card requested + resolved",
    approvals.length > 0 && events.some((e) => e.type === "approval.resolved"),
    `${approvals.length} approvals`,
  );
  check(
    "hello.txt exists with hi",
    existsSync(join(root, "hello.txt")) &&
      readFileSync(join(root, "hello.txt"), "utf8").trim() === "hi",
  );
  check("checkpoints captured", !!turn1.checkpointBefore && !!turn1.checkpointAfter);
  check(
    "changedFiles lists hello.txt",
    turn1.changedFiles.includes("hello.txt"),
    JSON.stringify(turn1.changedFiles),
  );
  check("usage reported", !!turn1.usage, JSON.stringify(turn1.usage));
  const thread1 = (await snapshot()).threads[threadId];
  out(
    `  session: ${thread1.providerSessionId ?? thread1.sessionId ?? JSON.stringify(Object.keys(thread1))}`,
  );
  check("thread idle after turn", thread1.status === "idle", thread1.status);
  const sessionAfter1 = JSON.stringify(thread1.providerSessionId ?? null);

  say("turn 2: resume the same session (memory of turn 1)");
  await dispatch({
    type: "turn.start",
    threadId,
    prompt: "What did I ask you to put inside hello.txt? Answer with just that word.",
  });
  const turn2 = await finished(threadId, 2);
  out(
    `  status=${turn2.status} reply=${JSON.stringify(text(turn2).slice(0, 120))} error=${turn2.error}`,
  );
  out(
    `  turn2 items: ${JSON.stringify(turn2.items.map((i) => (i.kind === "notice" ? i.text : i.kind)))}`,
  );
  check("turn 2 completed", turn2.status === "completed", turn2.error ?? "");
  check("turn 2 remembers (session resumed)", /\bhi\b/i.test(text(turn2)));
  const thread2 = (await snapshot()).threads[threadId];
  check(
    "same native session id",
    JSON.stringify(thread2.providerSessionId ?? null) === sessionAfter1,
    `${sessionAfter1} -> ${thread2.providerSessionId}`,
  );

  say("queue: a prompt submitted while a turn runs");
  await dispatch({
    type: "turn.start",
    threadId,
    prompt: "Count slowly from 1 to 30, one number per line, no commentary.",
  });
  await until(async () => (await snapshot()).threads[threadId].status === "running", "running");
  await dispatch({
    type: "turn.start",
    threadId,
    prompt: "Reply with the single word queued.",
    whenBusy: "queue",
  });
  check(
    "queue.added event",
    events.some((e) => e.type === "queue.added" && e.threadId === threadId) ||
      (await snapshot()).threads[threadId].queue?.length > 0,
  );
  const turn4 = await finished(threadId, 4);
  out(`  turn4 status=${turn4.status} reply=${JSON.stringify(text(turn4).slice(0, 80))}`);
  check(
    "queued prompt ran after the first",
    turn4.status === "completed" && /queued/i.test(text(turn4)),
    turn4.error ?? "",
  );
  const turn3 = (await turnsOf(threadId))[2];
  check("turn 3 completed", turn3.status === "completed", turn3.status);

  say("interrupt mid-turn (long shell command)");
  const nTurns = (await turnsOf(threadId)).length;
  await dispatch({
    type: "turn.start",
    threadId,
    prompt: "Run the shell command `sleep 120` and wait for it, then reply done.",
  });
  await until(
    async () => {
      const ts = await turnsOf(threadId);
      return ts[nTurns]?.items.some((i) => i.kind === "tool" || i.kind === "approval");
    },
    "tool or approval item",
    90000,
  );
  const before = descendants(server.pid);
  out(`  descendants during turn: ${before.map((d) => d.cmd.slice(0, 60)).join(" | ")}`);
  const ti = Date.now();
  await dispatch({ type: "turn.interrupt", threadId });
  const turn5 = await finished(threadId, nTurns + 1);
  out(`  interrupted in ${Date.now() - ti}ms status=${turn5.status}`);
  check("turn marked interrupted", turn5.status === "interrupted", turn5.status);
  check("thread back to idle", (await snapshot()).threads[threadId].status === "idle");
  await sleep(2500);
  const after = descendants(server.pid).filter((d) => !/\bps\b/.test(d.cmd));
  out(
    `  descendants after interrupt: ${after.map((d) => `${d.pid}:${d.cmd.slice(0, 70)}`).join(" | ") || "(none)"}`,
  );
  check(
    "no orphan/live processes after interrupt",
    after.length === 0 || after.every((d) => /tsx|esbuild/.test(d.cmd)),
  );
  check("no stray sleep 120", !psTable().some((r) => /sleep 120/.test(r.cmd)));

  say("turn after interrupt still resumes");
  await dispatch({ type: "turn.start", threadId, prompt: "Reply with the single word alive." });
  const turn6 = await finished(threadId, nTurns + 2);
  check(
    "turn after interrupt completed",
    turn6.status === "completed" && /alive/i.test(text(turn6)),
    `${turn6.status} ${turn6.error ?? ""} reply=${JSON.stringify(text(turn6).slice(0, 100))}`,
  );

  say("checkpoint + revert of turn 1");
  await dispatch({ type: "turn.revert", threadId, turnId: turn1.id });
  await until(
    async () => events.some((e) => e.type === "turn.reverted" && e.turnId === turn1.id),
    "turn.reverted",
  );
  check("hello.txt gone after revert", !existsSync(join(root, "hello.txt")));
  const afterRevert = (await turnsOf(threadId)).length;
  check("later turns trimmed", afterRevert === 0, `${afterRevert} turns left`);
  await dispatch({
    type: "turn.start",
    threadId,
    prompt: "Reply with the single word post-revert.",
  });
  const turn7 = await finished(threadId, 1);
  check(
    "turn after revert completes",
    turn7.status === "completed",
    `${turn7.status} ${turn7.error ?? ""}`,
  );

  say("usage / rate limits");
  const limits = await rpc("usage.limits", { refresh: true });
  const mine = limits.find((l) => l.provider === provider || l.kind === provider);
  out(`  ${JSON.stringify(mine ?? limits).slice(0, 400)}`);
  check("usage.limits answers", Array.isArray(limits));
  const history = await rpc("usage.history", { windowDays: 1, timeZone: "UTC" }).catch(
    (e) => e.message,
  );
  out(`  history: ${JSON.stringify(history).slice(0, 200)}`);

  say("model selection mid-thread");
  const alt = status.models.find((m) => m.id !== model);
  if (alt) {
    await dispatch({ type: "thread.configure", threadId, model: alt.id });
    check(
      "thread.configure model applied",
      (await snapshot()).threads[threadId].model === alt.id,
      alt.id,
    );
    await dispatch({ type: "thread.configure", threadId, model });
  } else out("  (only one model)");

  say("worktree-isolated thread");
  await dispatch({
    type: "thread.create",
    projectId,
    provider,
    model,
    runtimeMode: "full",
    isolate: true,
    title: "isolated",
  });
  const iso = Object.values((await snapshot()).threads).find((t) => t.title === "isolated");
  await until(
    async () => (await snapshot()).threads[iso.id].worktree,
    "worktree bound",
    30000,
  ).catch(() => null);
  const isoThread = (await snapshot()).threads[iso.id];
  const wtPath = isoThread.worktree?.path;
  out(`  worktree: ${wtPath} (keys: ${Object.keys(isoThread).join(",")})`);
  check("worktree created", !!wtPath && existsSync(wtPath) && wtPath !== root);
  const base0 = (await turnsOf(iso.id)).length;
  await dispatch({
    type: "turn.start",
    threadId: iso.id,
    prompt: "Create a file iso.txt containing exactly: iso. Reply done.",
  });
  const isoTurn = await finished(iso.id, base0 + 1);
  check("isolated turn completed", isoTurn.status === "completed", isoTurn.error ?? isoTurn.status);
  check(
    "iso.txt only in the worktree",
    !!wtPath && existsSync(join(wtPath, "iso.txt")) && !existsSync(join(root, "iso.txt")),
  );

  say("Ship: git.status + git.commit after a real edit");
  const gs = await rpc("git.status", { threadId: iso.id });
  out(`  ${JSON.stringify(gs)}`);
  check("git.status dirty", gs.dirty === true);
  const commit = await rpc("git.commit", { threadId: iso.id, message: "add iso.txt" });
  check("git.commit returns sha", /^[0-9a-f]{7,40}$/.test(commit.sha), commit.sha);
  check(
    "commit contains iso.txt",
    git(wtPath, "show", "--name-only", "--format=", "HEAD").includes("iso.txt"),
  );
  check("tree clean after commit", (await rpc("git.status", { threadId: iso.id })).dirty === false);

  pumpState.stop = true;
  await pump;

  say("shutdown with a turn in flight");
  approvalMode = null;
  const ids = (await snapshot()).threads;
  await dispatch({
    type: "turn.start",
    threadId,
    prompt: "Run the shell command `sleep 117` and wait for it, then reply done.",
  });
  await until(
    async () => (await turnsOf(threadId)).slice(-1)[0]?.items.length > 0,
    "turn activity",
    60000,
  ).catch(() => null);
  void ids;
} catch (e) {
  failures += 1;
  out(`\nERROR ${e.stack ?? e}`);
  await dumpState();
  out(`server log tail:\n${serverLog.join("").slice(-2500)}`);
} finally {
  pumpState.stop = true;
  const kids = descendants(server.pid).map((d) => d.pid);
  const t = Date.now();
  server.kill("SIGTERM");
  await new Promise((r) => (server.on("exit", r), setTimeout(r, 15000)));
  out(`\nserver exit after ${Date.now() - t}ms`);
  await sleep(1500);
  const live = new Set(psTable().map((r) => r.pid));
  const orphans = kids.filter((pid) => live.has(pid));
  const rows = psTable().filter((r) => orphans.includes(r.pid));
  check(
    "no orphans after server shutdown",
    orphans.length === 0,
    rows.map((r) => `${r.pid}:${r.cmd.slice(0, 60)}`).join(" | "),
  );
  for (const r of rows) process.kill(r.pid, "SIGKILL"); // pids we found as our server's own children
  out(
    `\n${provider}: ${results.filter((r) => r.ok).length}/${results.length} passed; FAILED: ${
      results
        .filter((r) => !r.ok)
        .map((r) => r.label)
        .join("; ") || "none"
    }`,
  );
  if (!KEEP) out(`(temp dir ${base})`);
  process.exit(failures ? 1 : 0);
}
