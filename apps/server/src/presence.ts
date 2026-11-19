import { chmodSync, mkdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { setAgentRuntime, currentAgentRuntime } from "./providers/agent-env.ts";

export const SERVER_DOWN = "AGE server is not running";

const ServerPresence = z.object({
  url: z.string().min(1),
  pid: z.number().int().positive(),
  startedAt: z.string().min(1),
});

function ageHome(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.AGE_HOME?.trim();
  return resolve(fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), ".age"));
}

function shimMarker(): string {
  return `age-shim pid=${process.pid}`;
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** `$AGE_SERVER_URL`, else a live `AGE_HOME/server.json`, else {@link SERVER_DOWN}. */
export function discoverServerUrl(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.AGE_SERVER_URL?.trim();
  if (fromEnv) return fromEnv;
  const file = join(ageHome(env), "server.json");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Error(SERVER_DOWN);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(SERVER_DOWN);
  }
  const parsed = ServerPresence.safeParse(raw);
  if (!parsed.success || !pidAlive(parsed.data.pid)) throw new Error(SERVER_DOWN);
  return parsed.data.url;
}

function takesValue(flag: string): boolean {
  return (
    flag === "--require" ||
    flag === "-r" ||
    flag === "--import" ||
    flag === "--loader" ||
    flag === "--experimental-loader"
  );
}

function absolutize(value: string): string {
  if (
    value.startsWith(".") ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    isAbsolute(value)
  ) {
    return resolve(value);
  }
  return value;
}

/** The node (or tsx) invocation that is running this process, plus the entry script. */
function launchArgv(): string[] {
  const script = process.argv[1];
  if (!script) throw new Error("Cannot locate the age entry script.");
  const args = [process.execPath];
  const execArgv = process.execArgv;
  for (let i = 0; i < execArgv.length; i++) {
    const arg = execArgv[i] ?? "";
    args.push(arg);
    if (!takesValue(arg)) continue;
    const value = execArgv[i + 1];
    if (value === undefined || value.startsWith("-")) continue;
    i += 1;
    args.push(absolutize(value));
  }
  args.push(resolve(script));
  return args;
}

function renderShim(args: readonly string[]): string {
  const marker = shimMarker();
  if (process.platform === "win32") {
    const command = args.map((arg) => `"${arg.replaceAll('"', '""')}"`).join(" ");
    return `@echo off\r\nrem ${marker}\r\n${command} %*\r\n`;
  }
  const command = args.map((arg) => `'${arg.replaceAll("'", `'\\''`)}'`).join(" ");
  return `#!/bin/sh\n# ${marker}\nexec ${command} "$@"\n`;
}

function installAgeShim(home: string): string {
  const binDir = join(home, "bin");
  mkdirSync(binDir, { recursive: true });
  const target = join(binDir, process.platform === "win32" ? "age.cmd" : "age");
  writeFileSync(target, renderShim(launchArgv()), { encoding: "utf8", mode: 0o755 });
  if (process.platform !== "win32") chmodSync(target, 0o755);
  return target;
}

function removeServerFile(home: string): void {
  const file = join(home, "server.json");
  try {
    const parsed = ServerPresence.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (!parsed.success || parsed.data.pid !== process.pid) return;
    rmSync(file, { force: true });
  } catch {
    // Already gone, or not ours to delete.
  }
}

function removeShim(home: string): void {
  const binDir = join(home, "bin");
  const marker = shimMarker();
  for (const name of ["age", "age.cmd"]) {
    const file = join(binDir, name);
    try {
      if (!readFileSync(file, "utf8").includes(marker)) continue;
      rmSync(file, { force: true });
    } catch {
      // Already gone.
    }
  }
  try {
    rmdirSync(binDir);
  } catch {
    // Not empty, or already gone.
  }
}

/**
 * Write `AGE_HOME/server.json` and the `age` shim, and remember the URL for
 * provider children. The returned function removes both when this process
 * still owns them.
 */
export function publishServerPresence(
  home: string,
  url: string,
  now: () => string = () => new Date().toISOString(),
): () => void {
  mkdirSync(home, { recursive: true });
  const file = join(home, "server.json");
  const record = { url, pid: process.pid, startedAt: now() };
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  let ageBin: string;
  try {
    ageBin = installAgeShim(home);
  } catch (error) {
    rmSync(file, { force: true });
    throw error;
  }
  setAgentRuntime({ serverUrl: url, ageBin });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    removeServerFile(home);
    removeShim(home);
    if (currentAgentRuntime()?.ageBin === ageBin) setAgentRuntime(null);
  };
}
