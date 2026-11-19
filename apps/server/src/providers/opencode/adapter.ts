import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DeviceSettings, ProviderEvent, ProviderStatus } from "@age/contracts";
import { resolveCommand } from "../../process/resolve-command.ts";
import { childEnv } from "../acp/env.ts";
import { loadSettings, settingsFor } from "../acp/settings.ts";
import { runAcpTurn, type AcpTurnSpec } from "../acp/turn.ts";
import type { ProviderAdapter, TurnInput } from "../types.ts";
import { openCodeArgs, parseOpenCodeModels, parseOpenCodeVersion } from "./models.ts";

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 4_000;
const MODELS_CACHE_MS = 5 * 60 * 1000;
const NOT_INSTALLED = "OpenCode is not installed.";

const CAPABILITIES = { rewind: false, questions: false, planMode: false, queue: true };

let modelsCache: { key: string; at: number; ids: string[] } | null = null;

export function resetOpenCodeModelsCache(): void {
  modelsCache = null;
}

export interface OpenCodeAdapterOptions {
  /** Read at probe and turn time. Defaults to empty device settings. */
  settings?: () => DeviceSettings;
  /** Replaces `opencode` and `providers.opencode.binaryPath`. */
  bin?: string;
  /** Inserted before `acp`, `--version`, and `models`. Tests point this at a fake CLI. */
  argsPrefix?: string[];
  onDebug?: (message: string) => void;
  killGraceMs?: number;
  maxLineBytes?: number;
  now?: () => number;
}

export function createOpenCodeAdapter(options: OpenCodeAdapterOptions = {}): ProviderAdapter {
  return {
    kind: "opencode",
    probe: () => probeOpenCode(options),
    runTurn(input: TurnInput): AsyncIterable<ProviderEvent> {
      return runConfiguredTurn(options, input);
    },
  };
}

async function* runConfiguredTurn(
  options: OpenCodeAdapterOptions,
  input: TurnInput,
): AsyncGenerator<ProviderEvent> {
  const provider = settingsFor(loadSettings(options.settings), "opencode");
  const bin = options.bin ?? provider.binaryPath ?? "opencode";
  const args = openCodeArgs(options.argsPrefix ?? [], provider.extraArgs).acp;
  const spec: AcpTurnSpec = {
    command: bin,
    args,
    env: childEnv(input.threadId, [provider.env]),
    modelId: input.model,
    missingCommand: NOT_INSTALLED,
    ...(options.killGraceMs !== undefined ? { killGraceMs: options.killGraceMs } : {}),
    ...(options.maxLineBytes !== undefined ? { maxLineBytes: options.maxLineBytes } : {}),
    ...(options.onDebug ? { onDebug: options.onDebug } : {}),
  };
  yield* runAcpTurn(spec, input);
}

async function probeOpenCode(options: OpenCodeAdapterOptions): Promise<ProviderStatus> {
  const provider = settingsFor(loadSettings(options.settings), "opencode");
  const bin = options.bin ?? provider.binaryPath ?? "opencode";
  const env = childEnv(null, [provider.env]);
  const custom = provider.customModels.map((id) => ({
    id,
    label: id,
    modelsSource: "custom" as const,
  }));
  const base = {
    kind: "opencode" as const,
    label: "OpenCode",
    capabilities: CAPABILITIES,
  };
  const resolved = resolveCommand(bin, env);
  if (!resolved) {
    return {
      ...base,
      installed: false,
      authenticated: null,
      version: null,
      models: custom,
      ...(custom.length > 0 ? { modelsSource: "custom" as const } : {}),
      problem: NOT_INSTALLED,
    };
  }

  const prefix = [...resolved.prefixArgs, ...(options.argsPrefix ?? [])];
  const argv = openCodeArgs(prefix, provider.extraArgs);
  try {
    const versionRun = await execFileAsync(resolved.command, argv.version, {
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
      env,
      encoding: "utf8",
    });
    const listed = await listModels(
      resolved.command,
      argv.models,
      env,
      options.now?.() ?? Date.now(),
    );
    const live = listed.ids.map((id) => ({ id, label: id, modelsSource: "live" as const }));
    const seen = new Set(live.map((model) => model.id));
    const models = [...live, ...custom.filter((model) => !seen.has(model.id))];
    const authText = `${listed.stdout}\n${listed.stderr}`;
    const authenticated = /not (?:logged|signed) in|authentication required/i.test(authText)
      ? false
      : null;
    return {
      ...base,
      installed: true,
      authenticated,
      version: parseOpenCodeVersion(versionRun.stdout, versionRun.stderr ?? ""),
      models,
      ...(live.length > 0 ? { modelsSource: "live" as const } : {}),
      problem: listed.problem,
    };
  } catch (error) {
    const missing = isErrno(error, "ENOENT");
    return {
      ...base,
      installed: !missing,
      authenticated: null,
      version: null,
      models: custom,
      ...(custom.length > 0 ? { modelsSource: "custom" as const } : {}),
      problem: missing ? NOT_INSTALLED : "OpenCode did not respond. Try again.",
    };
  }
}

async function listModels(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  now: number,
): Promise<{ ids: string[]; stdout: string; stderr: string; problem: string | null }> {
  const key = `${command}\0${args.join("\0")}`;
  if (modelsCache && modelsCache.key === key && now - modelsCache.at < MODELS_CACHE_MS) {
    return { ids: modelsCache.ids, stdout: "", stderr: "", problem: null };
  }
  try {
    const run = await execFileAsync(command, args, {
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
      env,
      encoding: "utf8",
    });
    const ids = parseOpenCodeModels(run.stdout);
    if (ids.length > 0) modelsCache = { key, at: now, ids };
    return {
      ids,
      stdout: run.stdout,
      stderr: run.stderr ?? "",
      problem: ids.length > 0 ? null : "OpenCode did not list any models.",
    };
  } catch {
    return { ids: [], stdout: "", stderr: "", problem: "OpenCode could not list models." };
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
