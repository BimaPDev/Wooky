import {
  accessSync,
  constants,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";

export type ResolvedCommand = {
  /** Absolute or bare executable path passed to spawn/execFile (never a .cmd/.bat). */
  command: string;
  /** Args inserted before the caller's args (e.g. PowerShell -File script). */
  prefixArgs: string[];
};

const WIN = process.platform === "win32";

/** Resolve a CLI name or path to something Node can spawn without `shell: true`. */
export function resolveCommand(
  input: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedCommand | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (isAbsolute(trimmed) || trimmed.includes("/") || trimmed.includes("\\")) {
    return resolvePath(trimmed, env);
  }

  for (const candidate of pathCandidates(trimmed, env)) {
    const resolved = resolvePath(candidate, env);
    if (resolved) return resolved;
  }
  return null;
}

function pathCandidates(name: string, env: NodeJS.ProcessEnv): string[] {
  const pathEnv = env.PATH ?? env.Path ?? "";
  const dirs = pathEnv.split(delimiter).filter(Boolean);
  const exts = WIN
    ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];
  const out: string[] = [];
  for (const dir of dirs) {
    if (WIN) {
      for (const ext of exts) {
        const lower = ext.toLowerCase();
        if (name.toLowerCase().endsWith(lower)) out.push(join(dir, name));
        else out.push(join(dir, name + ext));
      }
    } else {
      out.push(join(dir, name));
    }
  }
  return out;
}

function resolvePath(path: string, env: NodeJS.ProcessEnv): ResolvedCommand | null {
  if (!exists(path)) return null;
  let real = path;
  try {
    real = realpathSync(path);
  } catch {
    /* keep path */
  }
  const lower = real.toLowerCase();
  if (lower.endsWith(".cmd") || lower.endsWith(".bat")) return unwrapBatch(real, env);
  if (lower.endsWith(".ps1")) return powershellFile(real, env);
  return { command: real, prefixArgs: [] };
}

function unwrapBatch(batchPath: string, env: NodeJS.ProcessEnv): ResolvedCommand | null {
  let text = "";
  try {
    text = readFileSync(batchPath, "utf8");
  } catch {
    return null;
  }
  const dir = dirname(batchPath);
  const base = dir.endsWith("\\") || dir.endsWith("/") ? dir : `${dir}\\`;
  const expanded = text
    .replace(/%~dp0%/gi, base)
    .replace(/%dp0%/gi, base)
    .replace(/%~dp0/gi, base);

  const psQuoted = /(?:^|\s)-File\s+"([^"]+\.ps1)"/i.exec(expanded)?.[1];
  if (psQuoted && exists(psQuoted)) return powershellFile(psQuoted, env);

  const psBare = /(?:^|\s)-File\s+(\S+\.ps1)/i.exec(expanded)?.[1];
  if (psBare && exists(psBare)) return powershellFile(psBare, env);

  // npm shims: node … "<dp0>\node_modules\…\bin\tool.js"
  for (const match of expanded.matchAll(/"([^"\r\n]+\.js)"/gi)) {
    const script = match[1];
    if (!script || !exists(script)) continue;
    const localNode = join(dir, "node.exe");
    if (exists(localNode)) return { command: localNode, prefixArgs: [script] };
    const node = resolveCommand("node", env);
    if (node) return { command: node.command, prefixArgs: [...node.prefixArgs, script] };
  }

  for (const match of expanded.matchAll(/"([^"\r\n]+\.exe)"/gi)) {
    const exe = match[1];
    if (!exe || !exists(exe)) continue;
    // Bare node.exe is a runner, not the tool — keep looking / prefer .js above.
    if (/(^|[\\/])node\.exe$/i.test(exe)) continue;
    return { command: exe, prefixArgs: [] };
  }

  // cursor-agent layout: <root>/versions/<ver>/node.exe + index.js
  const versions = join(dir, "versions");
  if (exists(versions)) {
    try {
      const newest = readdirSync(versions)
        .map((name) => join(versions, name))
        .filter((entry) => {
          try {
            return statSync(entry).isDirectory();
          } catch {
            return false;
          }
        })
        .sort()
        .at(-1);
      if (newest) {
        const node = join(newest, "node.exe");
        const index = join(newest, "index.js");
        if (exists(node) && exists(index)) return { command: node, prefixArgs: [index] };
      }
    } catch {
      /* fall through */
    }
  }

  return null;
}

function powershellFile(script: string, env: NodeJS.ProcessEnv): ResolvedCommand | null {
  const system =
    env.SystemRoot ?? (WIN ? "C:\\Windows" : undefined);
  const candidates = [
    ...(system
      ? [join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")]
      : []),
    "powershell.exe",
  ];
  for (const candidate of candidates) {
    if (isAbsolute(candidate)) {
      if (exists(candidate)) {
        return {
          command: candidate,
          prefixArgs: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
        };
      }
      continue;
    }
    const nested = resolveCommand(candidate, env);
    if (nested) {
      return {
        command: nested.command,
        prefixArgs: [
          ...nested.prefixArgs,
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          script,
        ],
      };
    }
  }
  return null;
}

function exists(path: string): boolean {
  try {
    accessSync(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
