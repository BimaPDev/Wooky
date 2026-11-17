#!/usr/bin/env node
export const FAKE_CURSOR_AGENT_VERSION = "0.0.0-test";

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { writeFile } from "node:fs/promises";

const here = dirname(fileURLToPath(import.meta.url));
const mode = process.env.AGE_FAKE_CURSOR_MODE ?? "replay";
const fixture = process.env.AGE_FAKE_CURSOR_FIXTURE ?? join(here, "turn-complete.ndjson");

const args = process.argv.slice(2);

if (process.env.AGE_FAKE_CURSOR_LOG_ARGV) {
  await writeFile(process.env.AGE_FAKE_CURSOR_LOG_ARGV, JSON.stringify(args));
}

if (args.includes("--version")) {
  process.stdout.write("fake-cursor-agent 0.0.0-test\n");
  process.exit(0);
}

if (args.includes("status")) {
  const auth = process.env.AGE_FAKE_CURSOR_AUTH ?? "logged-in";
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
  if (process.env.AGE_FAKE_CURSOR_PID_FILE) {
    await writeFile(process.env.AGE_FAKE_CURSOR_PID_FILE, String(process.pid));
  }
  process.stdin.resume();
  await new Promise(() => {});
}

if (mode === "crash") {
  process.stderr.write("fatal: simulated crash\n");
  process.exit(1);
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
