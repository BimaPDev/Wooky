import { spawn, type ChildProcess } from "node:child_process";

type SpawnFn = (
  command: string,
  args: readonly string[],
  options: import("node:child_process").SpawnOptions,
) => ChildProcess;

export type KillTreeSignal = "SIGTERM" | "SIGKILL";

export interface KillTreeOptions {
  platform?: NodeJS.Platform;
  spawn?: SpawnFn;
}

function isErrno(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === code
  );
}

function notFoundMessage(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes("not found") || lower.includes("no running instance");
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

/** Stop a spawned process and its descendants. Kill only a PID we own. */
export async function killTree(
  pid: number,
  signal: KillTreeSignal,
  opts?: KillTreeOptions,
): Promise<void> {
  const platform = opts?.platform ?? process.platform;
  if (platform === "win32") {
    const spawnFn = opts?.spawn ?? spawn;
    const args = ["/pid", String(pid), "/t"];
    if (signal === "SIGKILL") args.push("/f");
    // wooky-allow child-process: taskkill targets only the PID we spawned (and its tree).
    await new Promise<void>((resolve) => {
      const child: ChildProcess = spawnFn("taskkill", args, {
        stdio: "ignore",
        windowsHide: true,
      });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      const finish = () => resolve();
      child.once("error", finish);
      child.once("exit", (code) => {
        if (code === 128 || code === 1 || notFoundMessage(stderr)) finish();
        else finish();
      });
    });
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch (err) {
    if (!isErrno(err, "ESRCH")) throw err;
    try {
      process.kill(pid, signal);
    } catch (inner) {
      if (!isErrno(inner, "ESRCH")) throw inner;
    }
  }
}
