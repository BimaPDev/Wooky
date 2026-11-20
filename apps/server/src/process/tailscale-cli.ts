import { spawn } from "node:child_process";
import { resolveCommand } from "./resolve-command.ts";

const MAC_APP = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const MAX_OUTPUT = 2 * 1024 * 1024;

export function findTailscale(env: NodeJS.ProcessEnv = process.env): string | null {
  const resolved = resolveCommand("tailscale", env);
  if (resolved) return resolved.command;
  if (process.platform === "darwin") {
    const mac = resolveCommand(MAC_APP, env);
    if (mac) return mac.command;
  }
  return null;
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Spawns `command` with an argv array. Kills the child when `timeoutMs` elapses. */
export function runArgv(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      stderr = stderr || error.message;
      finish(null);
    });
    child.once("close", (code) => finish(code));
  });
}
