import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { win32 } from "node:path";

export interface ShellCommand {
  file: string;
  args: string[];
  label: string;
  /** What a submitted line must end with for this shell's stdin. */
  lineEnding: "\n" | "\r\n";
}

function lineEndingFor(platform: NodeJS.Platform): ShellCommand["lineEnding"] {
  return platform === "win32" ? "\r\n" : "\n";
}

/** Pick a login shell to spawn directly, without going through another shell. Prefer PowerShell on Windows. */
export function resolveShellCommand(
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): ShellCommand {
  if (platform === "win32") {
    const pwsh = findOnPath(["pwsh.exe", "powershell.exe"], env, exists);
    if (pwsh)
      return {
        file: pwsh,
        args: ["-NoLogo"],
        label: pwsh.endsWith("pwsh.exe") ? "pwsh" : "powershell",
        lineEnding: lineEndingFor(platform),
      };
    return { file: "cmd.exe", args: [], label: "cmd", lineEnding: lineEndingFor(platform) };
  }
  const ending = lineEndingFor(platform);
  const fromEnv = env.SHELL?.trim();
  if (fromEnv) return { file: fromEnv, args: ["-l"], label: baseName(fromEnv), lineEnding: ending };
  for (const candidate of ["/bin/zsh", "/bin/bash", "/bin/sh"]) {
    if (exists(candidate))
      return { file: candidate, args: ["-l"], label: baseName(candidate), lineEnding: ending };
  }
  return { file: "/bin/sh", args: [], label: "sh", lineEnding: ending };
}

export function defaultCwd(preferred?: string | null): string {
  if (preferred && existsSync(preferred)) return preferred;
  return process.cwd() || homedir();
}

function findOnPath(
  names: string[],
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
): string | null {
  const pathEnv = env.PATH ?? env.Path ?? "";
  const parts = pathEnv.split(win32.delimiter).filter(Boolean);
  for (const dir of parts) {
    for (const name of names) {
      const full = win32.join(dir, name);
      if (exists(full)) return full;
    }
  }
  return null;
}

function baseName(path: string) {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}
