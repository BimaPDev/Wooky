import { execFile } from "node:child_process";
import { userInfo } from "node:os";
import { basename, delimiter } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const PATH_CAPTURE_START = "__AGE_PATH_START__";
export const PATH_CAPTURE_END = "__AGE_PATH_END__";

const FIRST_TIMEOUT_MS = 5_000;
const RETRY_TIMEOUT_MS = 20_000;

export type HydrateLoginShellPathResult = {
  source: "shell" | "skipped" | "failed";
  added: string[];
};

export type ExecFileAsync = (
  file: string,
  args: readonly string[],
  options: {
    encoding: "utf8";
    timeout: number;
    killSignal: NodeJS.Signals;
    env?: NodeJS.ProcessEnv;
  },
) => Promise<{ stdout: string; stderr: string }>;

export type HydrateLoginShellPathOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  execFile?: ExecFileAsync;
  log?: (line: string) => void;
};

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
  const start = output.indexOf(PATH_CAPTURE_START);
  if (start === -1) return null;
  const valueStart = start + PATH_CAPTURE_START.length;
  const end = output.indexOf(PATH_CAPTURE_END, valueStart);
  if (end === -1) return null;
  const raw = output
    .slice(valueStart, end)
    .replace(/^\r?\n/, "")
    .replace(/\r?\n$/, "");
  const line = raw.split(/\r?\n/).find((row) => row.length > 0);
  return line ?? null;
}

export function mergeLoginShellPath(
  shellPath: string,
  existingPath: string,
): {
  path: string;
  added: string[];
} {
  const existing = existingPath.split(delimiter).filter(Boolean);
  const fromShell = shellPath.split(delimiter).filter(Boolean);
  const existingSet = new Set(existing);
  const seen = new Set<string>();
  const ordered: string[] = [];
  const added: string[] = [];

  for (const entry of fromShell) {
    if (seen.has(entry)) continue;
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

function timedOut(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  const signal = "signal" in error ? String(error.signal) : "";
  return code === "ETIMEDOUT" || signal === "SIGKILL";
}

async function readShellPath(
  shell: string,
  env: NodeJS.ProcessEnv,
  exec: ExecFileAsync,
): Promise<string | null> {
  const run = async (timeout: number) => {
    const { stdout } = await exec(shell, shellCaptureArgs(shell), {
      encoding: "utf8",
      timeout,
      killSignal: "SIGKILL",
      env,
    });
    return extractPathFromCapture(stdout);
  };

  try {
    const first = await run(FIRST_TIMEOUT_MS);
    if (first) return first;
  } catch (error) {
    if (!timedOut(error)) return null;
    try {
      return await run(RETRY_TIMEOUT_MS);
    } catch {
      return null;
    }
  }

  try {
    return await run(RETRY_TIMEOUT_MS);
  } catch {
    return null;
  }
}

export async function hydrateLoginShellPath(
  options: HydrateLoginShellPathOptions = {},
): Promise<HydrateLoginShellPathResult> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.error(line));
  const exec = options.execFile ?? execFileAsync;

  if (platform === "win32" || env.AGE_SKIP_SHELL_ENV === "1") {
    return { source: "skipped", added: [] };
  }

  if (!env.HOME) {
    env.HOME = userInfo().homedir;
  }

  const shell = defaultShell(platform, env);
  const existingPath = env.PATH ?? "";
  const shellPath = await readShellPath(shell, env, exec);
  if (!shellPath) {
    log("login-shell PATH capture failed; keeping inherited PATH");
    return { source: "failed", added: [] };
  }

  const { path, added } = mergeLoginShellPath(shellPath, existingPath);
  env.PATH = path;
  return { source: "shell", added };
}
