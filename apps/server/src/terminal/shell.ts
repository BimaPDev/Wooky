import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { win32 } from "node:path";

export interface ShellCommand {
  file: string;
  args: string[];
  label: string;
}

/** Pick a login shell to spawn directly, without going through another shell. Prefer PowerShell on Windows. */
export function resolveShellCommand(
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ShellCommand {
  if (platform === "win32") {
    const pwsh = findOnPath(["pwsh.exe", "powershell.exe"], env);
    if (pwsh)
      return {
        file: pwsh,
        args: ["-NoLogo"],
        label: pwsh.endsWith("pwsh.exe") ? "pwsh" : "powershell",
      };
    return { file: "cmd.exe", args: [], label: "cmd" };
  }
  const fromEnv = env.SHELL?.trim();
  if (fromEnv) return { file: fromEnv, args: ["-l"], label: baseName(fromEnv) };
  for (const candidate of ["/bin/zsh", "/bin/bash", "/bin/sh"]) {
    if (existsSync(candidate)) return { file: candidate, args: ["-l"], label: baseName(candidate) };
  }
  return { file: "/bin/sh", args: [], label: "sh" };
}

export function defaultCwd(preferred?: string | null): string {
  if (preferred && existsSync(preferred)) return preferred;
  return process.cwd() || homedir();
}

function findOnPath(names: string[], env: NodeJS.ProcessEnv): string | null {
  const pathEnv = env.PATH ?? env.Path ?? "";
  const parts = pathEnv.split(win32.delimiter).filter(Boolean);
  for (const dir of parts) {
    for (const name of names) {
      const full = win32.join(dir, name);
      if (existsSync(full)) return full;
    }
  }
  return names[0] ?? null;
}

function baseName(path: string) {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}
