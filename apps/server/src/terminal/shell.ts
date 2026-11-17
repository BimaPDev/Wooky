import { existsSync } from "node:fs";
import { homedir } from "node:os";

export interface ShellCommand {
  file: string;
  args: string[];
  label: string;
}

/** Pick a login shell without `shell: true`. Prefer PowerShell on Windows. */
export function resolveShellCommand(platform = process.platform): ShellCommand {
  if (platform === "win32") {
    const pwsh = findOnPath(["pwsh.exe", "powershell.exe"]);
    if (pwsh) return { file: pwsh, args: ["-NoLogo"], label: pwsh.endsWith("pwsh.exe") ? "pwsh" : "powershell" };
    return { file: "cmd.exe", args: [], label: "cmd" };
  }
  const fromEnv = process.env.SHELL?.trim();
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

function findOnPath(names: string[]): string | null {
  const pathEnv = process.env.PATH ?? process.env.Path ?? "";
  const parts = pathEnv.split(";").filter(Boolean);
  for (const dir of parts) {
    for (const name of names) {
      const full = `${dir}\\${name}`;
      if (existsSync(full)) return full;
    }
  }
  return names[0] ?? null;
}

function baseName(path: string) {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}
