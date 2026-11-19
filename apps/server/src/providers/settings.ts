import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ProviderKind, ProviderSettings, ProviderStatus } from "@age/contracts";

/** Reads the user's settings for one provider at the moment it is needed. */
export type ProviderSettingsSource = (kind: ProviderKind) => ProviderSettings | undefined;

export type BinaryCheck = { ok: true; path: string } | { ok: false; problem: string };

/**
 * A user-chosen binary must be an absolute path to an existing, executable file.
 * Nothing is run here; this only looks at the file.
 */
export function checkBinaryPath(raw: string, label: string): BinaryCheck {
  const path = raw.trim();
  if (!isAbsolute(path)) {
    return {
      ok: false,
      problem: `The ${label} path must be absolute (it starts with / or a drive).`,
    };
  }
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return { ok: false, problem: `No file at the ${label} path.` };
  }
  if (!stat.isFile()) return { ok: false, problem: `The ${label} path is not a file.` };
  if (process.platform !== "win32") {
    try {
      accessSync(path, constants.X_OK);
    } catch {
      return { ok: false, problem: `The file at the ${label} path is not executable.` };
    }
  }
  return { ok: true, path };
}

export type Launch = {
  /** The executable to run: the validated override, or `fallback`. */
  bin: string;
  /** Set when the override was rejected. Callers must not spawn. */
  problem: string | null;
  extraArgs: readonly string[];
  /** Merged over the child environment. Never log this. */
  env: Readonly<Record<string, string>>;
};

/** Effective launch options for one provider from its settings. */
export function resolveLaunch(
  settings: ProviderSettings | undefined,
  fallbackBin: string,
  label: string,
): Launch {
  const override = settings?.binaryPath?.trim();
  const check = override ? checkBinaryPath(override, label) : null;
  return {
    bin: check?.ok ? check.path : fallbackBin,
    problem: check && !check.ok ? check.problem : null,
    extraArgs: settings?.extraArgs ?? [],
    env: settings?.env ?? {},
  };
}

/** `process.env` itself when the user set nothing, otherwise a copy with their values on top. */
export function withUserEnv(env: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  return Object.keys(env).length > 0 ? { ...process.env, ...env } : process.env;
}

/**
 * The Claude Agent SDK takes flags as a record without the leading `--`. This accepts
 * `--name`, `--name value` and `--name=value`. Short flags and bare words are dropped,
 * because the SDK has no place for them.
 */
export function claudeExtraArgs(args: readonly string[]): Record<string, string | null> {
  const flags: Record<string, string | null> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (!arg.startsWith("--") || arg.length === 2) continue;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("-")) {
      flags[arg.slice(2)] = next;
      i += 1;
    } else {
      flags[arg.slice(2)] = null;
    }
  }
  return flags;
}

/** Add the user's custom model ids to a status, skipping ids the probe already lists. */
export function withCustomModels(
  status: ProviderStatus,
  settings: ProviderSettings | undefined,
): ProviderStatus {
  const custom = settings?.customModels ?? [];
  if (custom.length === 0) return status;
  const seen = new Set(status.models.map((model) => model.id));
  const added = custom.filter((id) => !seen.has(id) && seen.add(id));
  if (added.length === 0) return status;
  return {
    ...status,
    models: [
      ...status.models,
      ...added.map((id) => ({ id, label: id, modelsSource: "custom" as const })),
    ],
  };
}
