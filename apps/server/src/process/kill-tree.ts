import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";

type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export type KillTreeSignal = "SIGTERM" | "SIGKILL";
export type KillTreeMode = "group" | "tree";

export interface KillTreeOptions {
  platform?: NodeJS.Platform;
  spawn?: SpawnFn;
  spawnSync?: typeof spawnSync;
  mode?: KillTreeMode;
  log?: (message: string) => void;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
}

function isErrno(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === code
  );
}

function swallowKillError(err: unknown, log?: (message: string) => void): void {
  if (isErrno(err, "ESRCH") || isErrno(err, "EPERM")) return;
  log?.(`killTree: ${err instanceof Error ? err.message : String(err)}`);
}

export function win32TaskkillArgs(pid: number, signal: KillTreeSignal): string[] {
  const args = ["/pid", String(pid), "/t"];
  if (signal === "SIGKILL") args.push("/f");
  return args;
}

/** Whether the process (POSIX: group; Windows: pid) appears to be running. */
export function isTreeAlive(pid: number, opts?: Pick<KillTreeOptions, "platform">): boolean {
  const platform = opts?.platform ?? process.platform;
  try {
    if (platform === "win32") process.kill(pid, 0);
    else process.kill(-pid, 0);
    return true;
  } catch (err) {
    if (isErrno(err, "EPERM")) return true;
    return false;
  }
}

function posixKill(
  pid: number,
  signal: KillTreeSignal,
  mode: KillTreeMode,
  killFn: (pid: number, signal: NodeJS.Signals) => void,
  log?: (message: string) => void,
): void {
  try {
    killFn(-pid, signal);
  } catch (err) {
    if (mode === "group") {
      swallowKillError(err, log);
      return;
    }
    if (!isErrno(err, "ESRCH")) {
      swallowKillError(err, log);
      return;
    }
    try {
      killFn(pid, signal);
    } catch (inner) {
      swallowKillError(inner, log);
    }
  }
}

/** Stop a spawned process and its descendants. Kill only a PID we own. Never rejects. */
export async function killTree(
  pid: number,
  signal: KillTreeSignal,
  opts?: KillTreeOptions,
): Promise<void> {
  const platform = opts?.platform ?? process.platform;
  const log = opts?.log;
  try {
    if (platform === "win32") {
      const spawnFn = opts?.spawn ?? spawn;
      const args = win32TaskkillArgs(pid, signal);
      // wooky-allow child-process: taskkill targets only the PID we spawned (and its tree).
      await new Promise<void>((resolve) => {
        const child = spawnFn("taskkill", args, {
          stdio: "ignore",
          windowsHide: true,
        });
        child.once("error", () => resolve());
        child.once("exit", () => resolve());
      });
      return;
    }
    const mode = opts?.mode ?? "tree";
    const killFn = opts?.kill ?? process.kill.bind(process);
    posixKill(pid, signal, mode, killFn, log);
  } catch (err) {
    swallowKillError(err, log);
  }
}

/** Synchronous tree kill for process exit handlers. */
export function killTreeSync(
  pid: number,
  signal: KillTreeSignal = "SIGKILL",
  opts?: KillTreeOptions,
): void {
  const platform = opts?.platform ?? process.platform;
  const log = opts?.log;
  try {
    if (platform === "win32") {
      const sync = opts?.spawnSync ?? spawnSync;
      sync("taskkill", win32TaskkillArgs(pid, signal), {
        stdio: "ignore",
        windowsHide: true,
      });
      return;
    }
    const mode = opts?.mode ?? "tree";
    const killFn = opts?.kill ?? process.kill.bind(process);
    posixKill(pid, signal, mode, killFn, log);
  } catch (err) {
    swallowKillError(err, log);
  }
}
