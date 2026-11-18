import { execFile as execFileCb } from "node:child_process";
import { existsSync } from "node:fs";
import { ServiceError } from "../errors.ts";

/** Commands the server may launch. Nothing else is ever executed. */
const SIGN_IN_COMMANDS = {
  claude: "claude auth login",
  codex: "codex login",
  cursor: "agent login",
} as const;

type SignInProvider = keyof typeof SIGN_IN_COMMANDS;

const AUTOMATION_HINT =
  "Allow Wooky to control Terminal in System Settings → Privacy & Security → Automation, then try again.";

export type SignInExecFile = (file: string, args: readonly string[]) => Promise<void>;

export interface OpenSignInOptions {
  platform?: NodeJS.Platform;
  execFile?: SignInExecFile;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
}

/**
 * Escape for an AppleScript double-quoted string.
 * Backslash first, so the slash in `\"` is not escaped a second time.
 */
export function escapeAppleScriptString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export function appleScriptDoScript(command: string): string {
  return `tell application "Terminal" to do script "${escapeAppleScriptString(command)}"`;
}

function isSignInProvider(provider: string): provider is SignInProvider {
  return provider === "claude" || provider === "codex" || provider === "cursor";
}

function commandFor(provider: string): string {
  if (!isSignInProvider(provider)) {
    throw new ServiceError("bad_request", `Unknown provider "${provider}".`);
  }
  return SIGN_IN_COMMANDS[provider];
}

function shellName(shell: string): string {
  const slash = shell.lastIndexOf("/");
  return slash === -1 ? shell : shell.slice(slash + 1);
}

/** Absolute $SHELL, otherwise bash when it exists, otherwise sh. */
function linuxShell(env: NodeJS.ProcessEnv, exists: (path: string) => boolean): string {
  const fromEnv = env.SHELL?.trim();
  if (fromEnv && fromEnv.startsWith("/")) return fromEnv;
  if (exists("/bin/bash")) return "/bin/bash";
  return "/bin/sh";
}

function linuxArgs(shell: string, command: string): string[] {
  if (shellName(shell) === "fish") return ["-e", shell, "-l", "-c", command];
  return ["-e", shell, "-ilc", command];
}

function launchArgv(
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
): { file: string; args: string[] } {
  if (platform === "darwin") {
    return {
      file: "osascript",
      args: ["-e", appleScriptDoScript(command), "-e", 'tell application "Terminal" to activate'],
    };
  }
  if (platform === "win32") {
    return { file: "cmd", args: ["/c", "start", "", command] };
  }
  return { file: "x-terminal-emulator", args: linuxArgs(linuxShell(env, exists), command) };
}

function stderrText(stderr: unknown): string {
  if (typeof stderr === "string") return stderr;
  if (stderr instanceof Uint8Array) return Buffer.from(stderr).toString("utf8");
  return "";
}

function defaultExecFile(file: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFileCb(file, [...args], { encoding: "utf8" }, (error, _stdout, stderr) => {
      if (!error) {
        resolve();
        return;
      }
      const status = typeof error.code === "number" ? error.code : null;
      reject(Object.assign(error, { stderr: stderrText(stderr), status }));
    });
  });
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

interface LaunchDetails {
  stderr: string;
  status: number | null;
  message: string;
}

function launchDetails(error: unknown): LaunchDetails {
  const record =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  const code = record.status ?? record.code;
  return {
    stderr: stderrText(record.stderr),
    status: typeof code === "number" ? code : null,
    message: error instanceof Error ? error.message : "",
  };
}

function firstStderrLine(stderr: string): string {
  return (stderr.split(/\r?\n/, 1)[0] ?? "").slice(0, 200);
}

function launchError(platform: NodeJS.Platform, error: unknown): ServiceError {
  if (platform === "darwin") {
    const details = launchDetails(error);
    const haystack = `${details.stderr}\n${details.message}\n${details.status ?? ""}`;
    if (haystack.includes("Not authorized to send Apple events") || haystack.includes("-1743")) {
      return new ServiceError("unavailable", AUTOMATION_HINT);
    }
    const line = firstStderrLine(details.stderr);
    if (!line) return new ServiceError("unavailable", "Could not open Terminal.");
    return new ServiceError("unavailable", `Could not open Terminal: ${line}`);
  }
  if (platform === "win32") {
    return new ServiceError("unavailable", "Could not open a command window.");
  }
  if (isEnoent(error)) {
    return new ServiceError(
      "unavailable",
      "Could not open a terminal. x-terminal-emulator was not found.",
    );
  }
  return new ServiceError("unavailable", "Could not open a terminal.");
}

/** Open the provider's sign-in command in the system terminal. Never runs a client-supplied string. */
export async function openSignInTerminal(
  provider: string,
  options: OpenSignInOptions = {},
): Promise<{ opened: true; command: string }> {
  const command = commandFor(provider);
  const platform = options.platform ?? process.platform;
  const exec = options.execFile ?? defaultExecFile;
  const launch = launchArgv(
    command,
    platform,
    options.env ?? process.env,
    options.exists ?? existsSync,
  );
  try {
    await exec(launch.file, launch.args);
  } catch (error) {
    throw launchError(platform, error);
  }
  return { opened: true, command };
}
