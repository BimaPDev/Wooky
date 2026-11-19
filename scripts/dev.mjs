#!/usr/bin/env node
// `pnpm dev`: the Wooky server on a free port (state in .wooky-dev), then the web dev server.
// Each child leads its own process group, so shutdown reaches exactly what this script started.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const devHome = join(repo, ".wooky-dev");
const WEB_URL = "http://localhost:5173";
const DEFAULT_PORT = 4317; // WOOKY_DEFAULT_PORT in packages/contracts
const READY_TIMEOUT_MS = 60_000;
const KILL_AFTER_MS = 3_000;
const TAGS = { server: "server │", web: "web    │" };

const flags = process.argv.slice(2);
const serverOnly = flags.includes("--server-only");
const webOnly = flags.includes("--web-only");
const unknown = flags.filter((flag) => flag !== "--server-only" && flag !== "--web-only");
if (unknown.length > 0 || (serverOnly && webOnly)) {
  console.error("usage: pnpm dev [--server-only | --web-only]");
  process.exit(2);
}

const colour = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
const children = [];
let shuttingDown = false;
let exitCode = 0;

function prefix(name) {
  return colour ? `\x1b[2m${TAGS[name]}\x1b[22m ` : `${TAGS[name]} `;
}

function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function shutdown(code, reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  exitCode = code;
  if (reason) console.error(reason);
  const spawned = children.filter((child) => child.pid !== undefined);
  for (const child of spawned) signalGroup(child.pid, "SIGTERM");

  const finish = () => {
    clearInterval(poll);
    clearTimeout(forceKill);
    process.exit(exitCode);
  };
  const poll = setInterval(() => {
    if (spawned.every((child) => !groupAlive(child.pid))) finish();
  }, 100);
  const forceKill = setTimeout(() => {
    for (const child of spawned) {
      if (groupAlive(child.pid)) signalGroup(child.pid, "SIGKILL");
    }
    finish();
  }, KILL_AFTER_MS);
}

function start(name, args, env, onLine) {
  const child = spawn("pnpm", args, {
    cwd: repo,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const entry = { name, pid: child.pid };
  children.push(entry);

  createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
    onLine?.(line);
    process.stdout.write(`${prefix(name)}${line}\n`);
  });
  createInterface({ input: child.stderr, crlfDelay: Infinity }).on("line", (line) => {
    process.stderr.write(`${prefix(name)}${line}\n`);
  });

  child.on("error", (error) => shutdown(1, `${name} failed to start: ${error.message}`));
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    const clean = code === 0 && signal === null;
    shutdown(clean ? 0 : 1, `${name} exited (${code ?? signal}); stopping Wooky.`);
  });
  return entry;
}

// A fixed port (not --port 0) because `tsx watch` restarts the server on every save
// and the web proxy must keep finding it. The probe-then-bind race is accepted.
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function startWeb(port) {
  start("web", ["--filter", "@wooky/web", "dev"], { ...process.env, WOOKY_PORT: String(port) });
}

async function main() {
  process.on("SIGINT", () => shutdown(130, "stopping Wooky"));
  process.on("SIGTERM", () => shutdown(143, "stopping Wooky"));

  if (webOnly) {
    startWeb(Number(process.env.WOOKY_PORT) || DEFAULT_PORT);
    console.info(`${prefix("web")}dev server → ${WEB_URL}`);
    return;
  }

  const port = await freePort();
  let markReady;
  const ready = new Promise((resolve) => {
    markReady = resolve;
  });
  const timer = setTimeout(
    () => shutdown(1, `server did not report WOOKY_LISTENING within ${READY_TIMEOUT_MS / 1000} s`),
    READY_TIMEOUT_MS,
  );
  start(
    "server",
    ["--filter", "@wooky/server", "dev", "--port", String(port), "--home", devHome],
    { ...process.env, WOOKY_HOME: devHome, WOOKY_PORT: String(port) },
    (line) => {
      const match = /^WOOKY_LISTENING (\S+)/.exec(line);
      if (match) markReady(match[1]);
    },
  );
  const serverUrl = await ready;
  clearTimeout(timer);

  if (serverOnly) {
    console.info(`${prefix("server")}ready at ${serverUrl}`);
    return;
  }
  startWeb(port);
  console.info(`${prefix("web")}dev server → ${WEB_URL}`);
}

main().catch((error) => shutdown(1, error instanceof Error ? error.message : String(error)));
