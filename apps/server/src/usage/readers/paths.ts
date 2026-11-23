import { homedir } from "node:os";
import path from "node:path";
import type { HistoryReaderContext } from "../history-reader.ts";

type PathApi = typeof path.posix | typeof path.win32;

function pathApiFor(platform: NodeJS.Platform): PathApi {
  return platform === "win32" ? path.win32 : path.posix;
}

function trimmed(value: string | undefined): string | null {
  const clean = value?.trim();
  return clean && clean.length > 0 ? clean : null;
}

function absoluteEnvDir(env: NodeJS.ProcessEnv, key: string, api: PathApi): string | null {
  const value = trimmed(env[key]);
  return value && api.isAbsolute(value) ? value : null;
}

function absoluteEnvDirList(env: NodeJS.ProcessEnv, key: string, api: PathApi): string[] {
  const raw = trimmed(env[key]);
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && api.isAbsolute(entry));
}

function dedupe(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of paths) {
    if (entry.length === 0 || seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

/** Resolves the user home from explicit env overrides first, then OS defaults. */
export function resolveUserHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    const profile = trimmed(env["USERPROFILE"]);
    if (profile) return profile;
    const drive = trimmed(env["HOMEDRIVE"]);
    const homePath = trimmed(env["HOMEPATH"]);
    if (drive && homePath) return `${drive}${homePath}`;
  }
  const home = trimmed(env["HOME"]);
  if (home) return home;
  return homedir();
}

function readerHome(
  ctx: Pick<HistoryReaderContext, "homeDir" | "env">,
  platform: NodeJS.Platform,
): string {
  return trimmed(ctx.homeDir) ?? resolveUserHome(ctx.env, platform);
}

export function claudeConfigDir(
  ctx: Pick<HistoryReaderContext, "homeDir" | "env">,
  platform: NodeJS.Platform = process.platform,
): string {
  const configured = trimmed(ctx.env["CLAUDE_CONFIG_DIR"]);
  if (configured) return configured;
  return `${readerHome(ctx, platform)}/.claude`;
}

export function codexSessionsDir(
  ctx: Pick<HistoryReaderContext, "homeDir" | "env">,
  platform: NodeJS.Platform = process.platform,
): string {
  const api = pathApiFor(platform);
  const configured = absoluteEnvDir(ctx.env, "CODEX_HOME", api);
  const codexHome = configured ?? api.join(readerHome(ctx, platform), ".codex");
  return api.join(codexHome, "sessions");
}

export function cursorProjectsDir(
  ctx: Pick<HistoryReaderContext, "homeDir" | "env">,
  platform: NodeJS.Platform = process.platform,
): string {
  const api = pathApiFor(platform);
  return api.join(readerHome(ctx, platform), ".cursor", "projects");
}

export function cursorAccountCachePaths(
  ctx: Pick<HistoryReaderContext, "homeDir" | "env">,
  fileName: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const api = pathApiFor(platform);
  const home = readerHome(ctx, platform);
  const wookyHome = absoluteEnvDir(ctx.env, "WOOKY_HOME", api);
  const dirs = dedupe([
    ...(wookyHome ? [wookyHome] : []),
    api.join(home, ".t3", "userdata"),
    api.join(home, ".wooky"),
  ]);
  return dirs.map((dir) => api.join(dir, fileName));
}

export function cursorIdeDatabasePaths(
  ctx: Pick<HistoryReaderContext, "homeDir" | "env">,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const api = pathApiFor(platform);
  const home = readerHome(ctx, platform);
  const tail = ["Cursor", "User", "globalStorage", "state.vscdb"] as const;
  const xdgConfig = absoluteEnvDir(ctx.env, "XDG_CONFIG_HOME", api);
  const appData = absoluteEnvDir(ctx.env, "APPDATA", api);
  return dedupe([
    api.join(home, "Library", "Application Support", ...tail),
    ...(xdgConfig ? [api.join(xdgConfig, ...tail)] : []),
    api.join(home, ".config", ...tail),
    ...(appData ? [api.join(appData, ...tail)] : []),
    api.join(home, "AppData", "Roaming", ...tail),
  ]);
}

export function opencodeDataDirs(
  ctx: Pick<HistoryReaderContext, "homeDir" | "env">,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const api = pathApiFor(platform);
  if (trimmed(ctx.env["OPENCODE_DATA_DIR"])) {
    return dedupe(absoluteEnvDirList(ctx.env, "OPENCODE_DATA_DIR", api));
  }
  const xdg = absoluteEnvDir(ctx.env, "XDG_DATA_HOME", api);
  if (xdg) return [api.join(xdg, "opencode")];
  const home = readerHome(ctx, platform);
  const localAppData = absoluteEnvDir(ctx.env, "LOCALAPPDATA", api);
  const appData = absoluteEnvDir(ctx.env, "APPDATA", api);
  return dedupe([
    api.join(home, ".local", "share", "opencode"),
    ...(localAppData ? [api.join(localAppData, "opencode")] : []),
    ...(appData ? [api.join(appData, "opencode")] : []),
    ...(platform === "win32"
      ? [
          api.join(home, "AppData", "Local", "opencode"),
          api.join(home, "AppData", "Roaming", "opencode"),
        ]
      : []),
  ]);
}

export function antigravityDataDirs(
  ctx: Pick<HistoryReaderContext, "homeDir" | "env">,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const api = pathApiFor(platform);
  const configured = absoluteEnvDirList(ctx.env, "ANTIGRAVITY_DATA_DIR", api);
  if (configured.length > 0) return dedupe(configured);
  const home = readerHome(ctx, platform);
  const xdgConfig = absoluteEnvDir(ctx.env, "XDG_CONFIG_HOME", api);
  const appData = absoluteEnvDir(ctx.env, "APPDATA", api);
  const localAppData = absoluteEnvDir(ctx.env, "LOCALAPPDATA", api);
  const wookyHome = absoluteEnvDir(ctx.env, "WOOKY_HOME", api);
  return dedupe([
    api.join(home, ".gemini", "antigravity"),
    api.join(home, ".gemini", "antigravity-cli"),
    api.join(home, ".gemini", "antigravity-ide"),
    api.join(home, ".gemini", "antigravity-backup"),
    ...(xdgConfig ? [api.join(xdgConfig, "antigravity")] : []),
    api.join(home, ".config", "antigravity"),
    ...(appData ? [api.join(appData, "antigravity")] : []),
    ...(localAppData ? [api.join(localAppData, "antigravity")] : []),
    ...(platform === "win32"
      ? [
          api.join(home, "AppData", "Roaming", "antigravity"),
          api.join(home, "AppData", "Local", "antigravity"),
        ]
      : []),
    api.join(home, ".t3", "userdata", "providers", "antigravity"),
    api.join(home, ".wooky", "providers", "antigravity"),
    ...(wookyHome ? [api.join(wookyHome, "providers", "antigravity")] : []),
  ]);
}
