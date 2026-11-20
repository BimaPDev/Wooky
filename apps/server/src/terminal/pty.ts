import { chmodSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { IPty, IWindowsPtyForkOptions } from "node-pty";

export type PtyModule = {
  spawn: (file: string, args: string[], options: IWindowsPtyForkOptions) => IPty;
};

export type PtyLoader = () => Promise<PtyModule>;

let fallbackLogged = false;

export function logPtyFallback(reason: unknown): void {
  if (fallbackLogged) return;
  fallbackLogged = true;
  const detail = reason instanceof Error ? reason.message : String(reason);
  console.warn(`node-pty unavailable; terminal sessions will use pipes. ${detail}`);
}

function ensureSpawnHelperExecutable() {
  if (process.platform === "win32") return;
  try {
    const require = createRequire(import.meta.url);
    const root = dirname(require.resolve("node-pty/package.json"));
    for (const candidate of [
      join(root, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
      join(root, "build", "Release", "spawn-helper"),
    ]) {
      if (existsSync(candidate)) chmodSync(candidate, 0o755);
    }
  } catch {
    // spawn may still fail; the session layer falls back to pipes
  }
}

export async function loadNodePty(): Promise<PtyModule> {
  ensureSpawnHelperExecutable();
  const loaded = await import("node-pty");
  const spawn = loaded.spawn;
  if (typeof spawn !== "function") throw new Error("node-pty.spawn is missing.");
  return { spawn };
}

export function terminalEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) env[key] = value;
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  return env;
}

export function spawnPty(
  pty: PtyModule,
  file: string,
  args: string[],
  options: { cwd: string; cols: number; rows: number; env?: NodeJS.ProcessEnv },
): IPty {
  const forkOptions: IWindowsPtyForkOptions = {
    name: "xterm-256color",
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: terminalEnv(options.env),
  };
  if (process.platform === "win32") forkOptions.useConpty = true;
  return pty.spawn(file, args, forkOptions);
}
