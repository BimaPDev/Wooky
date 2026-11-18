import { execFile as execFileCb } from "node:child_process";
import { ServiceError } from "../errors.ts";

/** Commands the server may launch. Nothing else is ever executed. */
const SIGN_IN_COMMANDS = {
  claude: "claude auth login",
  codex: "codex login",
  cursor: "agent login",
} as const;

type SignInProvider = keyof typeof SIGN_IN_COMMANDS;

const LINUX_SHELL = "/bin/sh";

export type SignInExecFile = (file: string, args: readonly string[]) => Promise<void>;

export interface OpenSignInOptions {
  platform?: NodeJS.Platform;
  execFile?: SignInExecFile;
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

function launchArgv(command: string, platform: NodeJS.Platform): { file: string; args: string[] } {
  if (platform === "darwin") {
    return {
      file: "osascript",
      args: ["-e", appleScriptDoScript(command), "-e", 'tell application "Terminal" to activate'],
    };
  }
  if (platform === "win32") {
    return { file: "cmd", args: ["/c", "start", "", command] };
  }
  return { file: "x-terminal-emulator", args: ["-e", LINUX_SHELL, "-lc", command] };
}

function defaultExecFile(file: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFileCb(file, [...args], (error) => {
      if (error) reject(error);
      else resolve();
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

function launchError(platform: NodeJS.Platform, error: unknown): ServiceError {
  if (platform === "darwin") return new ServiceError("unavailable", "Could not open Terminal.");
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
  const launch = launchArgv(command, platform);
  try {
    await exec(launch.file, launch.args);
  } catch (error) {
    throw launchError(platform, error);
  }
  return { opened: true, command };
}
