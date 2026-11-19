#!/usr/bin/env node
export const FAKE_CURSOR_AGENT_VERSION = "0.0.0-test";

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { writeFile, rename } from "node:fs/promises";

const here = dirname(fileURLToPath(import.meta.url));
const mode = process.env.WOOKY_FAKE_CURSOR_MODE ?? "replay";
const fixture = process.env.WOOKY_FAKE_CURSOR_FIXTURE ?? join(here, "turn-complete.ndjson");

const args = process.argv.slice(2);

if (process.env.WOOKY_FAKE_CURSOR_LOG_ARGV) {
  await writeFile(process.env.WOOKY_FAKE_CURSOR_LOG_ARGV, JSON.stringify(args));
}

if (args.includes("--version")) {
  if (mode === "version-hang") {
    process.stdin.resume();
    setInterval(() => {}, 2 ** 31 - 1);
    await new Promise(() => {}); // block: never fall through to the replay below
  } else {
    process.stdout.write("fake-cursor-agent 0.0.0-test\n");
    process.exit(0);
  }
}

if (args.includes("status")) {
  const auth = process.env.WOOKY_FAKE_CURSOR_AUTH ?? "logged-in";
  if (auth === "logged-in") {
    process.stdout.write("✓ Logged in as user@example.com\n");
  } else {
    process.stdout.write("Authentication is required. Run cursor-agent login.\n");
  }
  process.exit(0);
}

if (args.includes("--list-models")) {
  process.stdout.write("Available models\n\nauto - Auto (current, default)\ngpt-test - GPT Test\n");
  process.exit(0);
}

if (mode === "hang") {
  process.stdout.write(`PID ${process.pid}\n`);
  if (process.env.WOOKY_FAKE_CURSOR_PID_FILE) {
    const tmp = `${process.env.WOOKY_FAKE_CURSOR_PID_FILE}.tmp`;
    await writeFile(tmp, String(process.pid));
    await rename(tmp, process.env.WOOKY_FAKE_CURSOR_PID_FILE);
  }
  process.stdin.resume();
  setInterval(() => {}, 2 ** 31 - 1);
  await new Promise(() => {}); // block: never fall through to the replay below
}

if (mode === "crash") {
  process.stderr.write("fatal: simulated crash\n");
  process.exit(1);
}

if (mode === "null-line") {
  process.stdout.write("null\n");
  process.stdout.write(
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
    }) + "\n",
  );
  process.exit(0);
}

if (mode === "signal-exit") {
  process.stdout.write(`PID ${process.pid}\n`);
  process.stdin.resume();
  setInterval(() => {}, 2 ** 31 - 1);
  await new Promise(() => {}); // block: never fall through to the replay below
}

const prompt = args[args.length - 1] ?? "";
if (prompt === "__probe_only__") {
  process.exit(0);
}

const body = await readFile(fixture, "utf8");
for (const line of body.split("\n")) {
  if (line.trim()) {
    process.stdout.write(line + "\n");
    await yieldChunk();
  }
}

function yieldChunk() {
  return new Promise((resolve) => setImmediate(resolve));
}
