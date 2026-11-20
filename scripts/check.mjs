#!/usr/bin/env node
// Single entry point for every gate. `--fast` is what the pre-commit hook runs;
// the full run is what CI and the head chef run before accepting a worker's dish.
import { spawnSync } from "node:child_process";

const fast = process.argv.includes("--fast");

const steps = [
  ["format", ["pnpm", "exec", "prettier", "--check", "."]],
  ["lint", ["pnpm", "exec", "oxlint", "--deny-warnings", "."]],
  ["boundaries", ["node", "scripts/check-boundaries.mjs"]],
  ...(fast
    ? []
    : [
        ["typecheck", ["pnpm", "-r", "--workspace-concurrency=1", "run", "typecheck"]],
        ["test", ["pnpm", "exec", "vitest", "run"]],
        ["knip", ["pnpm", "exec", "knip", "--no-progress"]],
      ]),
];

function runCommand(cmd, args) {
  if (cmd === "node") {
    return spawnSync(process.execPath, args, { stdio: "inherit" });
  }
  if (cmd === "pnpm") {
    const cli = process.env.npm_execpath;
    if (!cli) {
      console.error("pnpm steps require npm_execpath (run via `pnpm check`).");
      return { status: 1 };
    }
    return spawnSync(process.execPath, [cli, ...args], {
      stdio: "inherit",
      env: process.env,
    });
  }
  return spawnSync(cmd, args, { stdio: "inherit" });
}

const results = [];
for (const [name, [cmd, ...args]] of steps) {
  const started = Date.now();
  process.stdout.write(`\n── ${name} ──\n`);
  const run = runCommand(cmd, args);
  results.push({ name, ok: run.status === 0, ms: Date.now() - started });
}

console.info("\nSummary");
for (const r of results)
  console.info(`  ${r.ok ? "pass" : "FAIL"}  ${r.name.padEnd(11)} ${r.ms} ms`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
