import { spawn, type ChildProcess } from "node:child_process";
import { userInfo } from "node:os";
import { basename, delimiter, isAbsolute } from "node:path";

export const PATH_CAPTURE_START = "__AGE_PATH_START__";
export const PATH_CAPTURE_END = "__AGE_PATH_END__";

const CAPTURE_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

export type HydrateLoginShellPathResult = {
  source: "shell" | "skipped" | "failed";
  added: string[];
};

export type SpawnShell = (
  file: string,
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    detached: true;
    stdio: ["ignore", "pipe", "pipe"];
  },
) => ChildProcess;

export type KillProcess = (pid: number, signal: NodeJS.Signals) => void;

export type HydrateLoginShellPathOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  spawnShell?: SpawnShell;
  killProcess?: KillProcess;
  onActiveShell?: (kill: (() => void) | undefined) => void;
  log?: (line: string) => void;
};

export function stripAnsi(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code !== 0x1b && code !== 0x9b) {
      out += text[i];
      continue;
    }
    i++;
    if (text[i] === "[") {
      i++;
      while (i < text.length) {
        const ch = text.charCodeAt(i);
        if (ch >= 0x40 && ch <= 0x7e) break;
        i++;
      }
    }
  }
  return out;
}

export function buildPosixPathCaptureScript(): string {
  return [
    "(trap - DEBUG) 2>/dev/null && trap - DEBUG",
    `printf '%s\\n' '${PATH_CAPTURE_START}'`,
    'printf "%s\\n" "$PATH"',
    `printf '%s\\n' '${PATH_CAPTURE_END}'`,
  ].join("; ");
}

export function buildFishPathCaptureScript(): string {
  return [`echo '${PATH_CAPTURE_START}'`, "string join : $PATH", `echo '${PATH_CAPTURE_END}'`].join(
    "; ",
  );
}

export function extractPathFromCapture(output: string): string | null {
  const lines = stripAnsi(output).split(/\r?\n/);
  let lastPath: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== PATH_CAPTURE_START) continue;
    if (i + 2 >= lines.length) continue;
    if (lines[i + 2] !== PATH_CAPTURE_END) continue;
    const pathLine = stripAnsi(lines[i + 1] ?? "").trim();
    if (pathLine.length > 0) lastPath = pathLine;
    i += 2;
  }

  return lastPath;
}

export function normalizeShellPathEntry(entry: string, home: string): string | null {
  const trimmed = entry.trim();
  if (!trimmed) return null;
  let expanded = trimmed;
  if (expanded === "~" || expanded.startsWith("~/")) {
    expanded = home + expanded.slice(1);
  }
  return isAbsolute(expanded) ? expanded : null;
}

export function mergeLoginShellPath(
  shellPath: string,
  existingPath: string,
  home: string,
): {
  path: string;
  added: string[];
} {
  const existing = existingPath.split(delimiter).filter(Boolean);
  const fromShell = shellPath.split(delimiter);
  const existingSet = new Set(existing);
  const seen = new Set<string>();
  const ordered: string[] = [];
  const added: string[] = [];

  for (const raw of fromShell) {
    const entry = normalizeShellPathEntry(raw, home);
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    ordered.push(entry);
    if (!existingSet.has(entry)) added.push(entry);
  }
  for (const entry of existing) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    ordered.push(entry);
  }

  return { path: ordered.join(delimiter), added };
}

function defaultShell(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  const fromEnv = env.SHELL?.trim();
  if (fromEnv) return fromEnv;
  return platform === "darwin" ? "/bin/zsh" : "/bin/bash";
}

function shellCaptureArgs(shell: string): readonly string[] {
  if (basename(shell).toLowerCase() === "fish") {
    return ["-l", "-c", buildFishPathCaptureScript()];
  }
  return ["-ilc", buildPosixPathCaptureScript()];
}

function killProcessGroup(pid: number, kill: KillProcess): void {
  try {
    kill(-pid, "SIGKILL");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return;
    throw error;
  }
}

function appendOutputTail(current: string, piece: string, maxBytes: number): string {
  let combined = current + piece;
  while (Buffer.byteLength(combined, "utf8") > maxBytes) {
    const trim = Buffer.byteLength(combined, "utf8") - maxBytes;
    let removed = 0;
    let i = 0;
    while (i < combined.length && removed < trim) {
      const unit = combined[i];
      if (unit === undefined) break;
      removed += Buffer.byteLength(unit, "utf8");
      i++;
    }
    combined = combined.slice(i);
  }
  return combined;
}

export async function captureLoginShellPath(
  shell: string,
  env: NodeJS.ProcessEnv,
  options: {
    spawnShell?: SpawnShell;
    killProcess?: KillProcess;
    onActiveShell?: (kill: (() => void) | undefined) => void;
  } = {},
): Promise<string> {
  const spawnFn = options.spawnShell ?? spawn;
  const killFn = options.killProcess ?? process.kill.bind(process);

  return new Promise((resolve, reject) => {
    const child = spawnFn(shell, shellCaptureArgs(shell), {
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let timedOut = false;
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        killGroup();
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") {
          /* already gone */
        }
        /* timer callback rejects on other kill errors; here we only best-effort cleanup */
      }
      options.onActiveShell?.(undefined);
      fn();
    };

    const killGroup = () => {
      if (child.pid !== undefined) killProcessGroup(child.pid, killFn);
    };

    options.onActiveShell?.(killGroup);

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        killGroup();
      } catch (error) {
        finish(() => reject(error));
      }
    }, CAPTURE_TIMEOUT_MS);

    const settleIfMarked = () => {
      const path = extractPathFromCapture(stdout);
      if (path) finish(() => resolve(path));
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendOutputTail(stdout, chunk.toString("utf8"), MAX_OUTPUT_BYTES);
      settleIfMarked();
    });
    child.stderr?.on("data", () => undefined);

    child.on("error", (error) => {
      finish(() => reject(error));
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      const path = extractPathFromCapture(stdout);
      if (path) {
        finish(() => resolve(path));
        return;
      }
      if (timedOut && signal === "SIGKILL") {
        finish(() =>
          reject(Object.assign(new Error("login-shell PATH capture timed out"), { code, signal })),
        );
        return;
      }
      finish(() =>
        reject(
          Object.assign(new Error("login-shell PATH capture failed"), {
            code: code ?? undefined,
            signal: signal ?? undefined,
          }),
        ),
      );
    });
  });
}

export async function hydrateLoginShellPath(
  options: HydrateLoginShellPathOptions = {},
): Promise<HydrateLoginShellPathResult> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.error(line));

  if (platform === "win32" || env.WOOKY_SKIP_SHELL_ENV === "1") {
    return { source: "skipped", added: [] };
  }

  if (!env.HOME) {
    env.HOME = userInfo().homedir;
  }

  const home = env.HOME;
  const shell = defaultShell(platform, env);
  const existingPath = env.PATH ?? "";

  try {
    const shellPath = await captureLoginShellPath(shell, env, {
      spawnShell: options.spawnShell,
      killProcess: options.killProcess,
      onActiveShell: options.onActiveShell,
    });
    const { path, added } = mergeLoginShellPath(shellPath, existingPath, home);
    env.PATH = path;
    return { source: "shell", added };
  } catch {
    log("login-shell PATH capture failed; keeping inherited PATH");
    return { source: "failed", added: [] };
  }
}
