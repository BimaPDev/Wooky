import {
  query as sdkQuery,
  type Options,
  type SDKControlGetUsageResponse,
  type SDKRateLimitInfo,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { LimitWindow, ProviderLimits } from "@age/contracts";
import { resolveCommand } from "../../process/resolve-command.ts";

type ClaudeWindowKey =
  | "five_hour"
  | "seven_day"
  | "seven_day_opus"
  | "seven_day_sonnet";

type ClaudeRawWindow = {
  utilization: number | null;
  resets_at: string | null;
} | null;

export type ClaudeUsageRaw = Pick<
  SDKControlGetUsageResponse,
  "subscription_type" | "rate_limits_available" | "rate_limits"
>;

export type ClaudeLimitsProbeOptions = {
  query?: typeof sdkQuery;
  claudeBin?: string;
  cwd?: string;
  now?: () => Date;
};

const WINDOW_LABELS: Record<ClaudeWindowKey, string> = {
  five_hour: "5-hour",
  seven_day: "Weekly",
  seven_day_opus: "Weekly · Opus",
  seven_day_sonnet: "Weekly · Sonnet",
};

const NAMED_WINDOWS: ClaudeWindowKey[] = [
  "five_hour",
  "seven_day",
  "seven_day_opus",
  "seven_day_sonnet",
];

/** Never yields — lets us call the usage control method without spending a turn. */
function silentPrompt(): AsyncIterable<SDKUserMessage> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<SDKUserMessage>>(() => undefined),
      };
    },
  };
}

function hasWindowData(window: { utilization: number | null; resets_at: string | null }): boolean {
  return window.utilization !== null || window.resets_at !== null;
}

function pushNamedWindow(
  windows: LimitWindow[],
  id: ClaudeWindowKey,
  raw: ClaudeRawWindow | undefined,
): void {
  if (!raw || !hasWindowData(raw)) return;
  windows.push({
    id,
    label: WINDOW_LABELS[id],
    usedPercent: raw.utilization,
    resetsAt: raw.resets_at,
  });
}

export function normalizeClaudeUsage(
  raw: ClaudeUsageRaw,
  checkedAt: string = new Date().toISOString(),
): ProviderLimits {
  if (!raw.rate_limits_available || !raw.rate_limits) {
    return {
      provider: "claude",
      available: false,
      plan: raw.subscription_type,
      windows: [],
      checkedAt,
      problem: "Claude plan limits are not available for this account.",
    };
  }

  const windows: LimitWindow[] = [];
  for (const key of NAMED_WINDOWS) {
    pushNamedWindow(windows, key, raw.rate_limits[key]);
  }

  for (const scoped of raw.rate_limits.model_scoped ?? []) {
    if (!hasWindowData(scoped)) continue;
    const name = scoped.display_name.trim() || "Model";
    windows.push({
      id: `model_scoped:${name}`,
      label: `Weekly · ${name}`,
      usedPercent: scoped.utilization,
      resetsAt: scoped.resets_at,
    });
  }

  return {
    provider: "claude",
    available: true,
    plan: raw.subscription_type,
    windows,
    checkedAt,
    problem: null,
  };
}

export function applyClaudeRateLimitEvent(
  current: ProviderLimits | null,
  info: SDKRateLimitInfo,
  checkedAt: string = new Date().toISOString(),
): ProviderLimits {
  const type = info.rateLimitType;
  const base: ProviderLimits = current ?? {
    provider: "claude",
    available: true,
    plan: null,
    windows: [],
    checkedAt,
    problem: null,
  };

  if (
    !type ||
    type === "seven_day_overage_included" ||
    type === "overage" ||
    !(type in WINDOW_LABELS)
  ) {
    return { ...base, available: true, checkedAt, problem: null };
  }

  const id = type as ClaudeWindowKey;
  const usedPercent = typeof info.utilization === "number" ? info.utilization : null;
  const resetsAt =
    typeof info.resetsAt === "number" ? new Date(info.resetsAt * 1000).toISOString() : null;
  if (usedPercent === null && resetsAt === null) {
    return { ...base, available: true, checkedAt, problem: null };
  }

  const nextWindow: LimitWindow = {
    id,
    label: WINDOW_LABELS[id],
    usedPercent,
    resetsAt,
  };
  const windows = [...base.windows];
  const index = windows.findIndex((window) => window.id === id);
  const existing = index >= 0 ? windows[index] : undefined;
  if (existing) windows[index] = { ...existing, ...nextWindow };
  else windows.push(nextWindow);

  return {
    ...base,
    available: true,
    windows,
    checkedAt,
    problem: null,
  };
}

export async function fetchClaudeLimits(
  options: ClaudeLimitsProbeOptions = {},
): Promise<ProviderLimits> {
  const now = options.now ?? (() => new Date());
  const checkedAt = now().toISOString();
  const runQuery = options.query ?? sdkQuery;
  const bin = options.claudeBin ?? "claude";
  const resolved = resolveCommand(bin);
  const claudeExecutable = resolved?.prefixArgs.length
    ? undefined
    : (resolved?.command ?? options.claudeBin);

  const abort = new AbortController();
  const sdkOptions: Options = {
    cwd: options.cwd ?? process.cwd(),
    abortController: abort,
    ...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
  };

  let running: ReturnType<typeof sdkQuery> | undefined;
  try {
    running = runQuery({ prompt: silentPrompt(), options: sdkOptions });
    const raw = await running.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
      skipBehaviors: true,
    });
    return normalizeClaudeUsage(raw, checkedAt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      provider: "claude",
      available: false,
      plan: null,
      windows: [],
      checkedAt,
      problem: message.trim() || "Could not read Claude plan limits.",
    };
  } finally {
    abort.abort();
    running?.close();
  }
}
