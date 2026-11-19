import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import {
  classifyGenericText,
  isInterruptText,
  timingFrom,
  type TurnFailure,
  type TurnFailureKind,
} from "../failure.ts";

const PLAN_WINDOWS = new Set([
  "five_hour",
  "seven_day",
  "seven_day_opus",
  "seven_day_sonnet",
  "seven_day_overage_included",
  "overage",
]);

const ORDINARY_SUBTYPES = new Set(["error_max_turns", "error_max_structured_output_retries"]);

export function classifyClaudeFailure(input: {
  resultSubtype?: string;
  errorText?: string;
  rateLimit?: SDKRateLimitInfo | null;
  apiStatus?: number;
  now?: Date;
}): TurnFailure | null {
  const now = input.now ?? new Date();
  const errorText = input.errorText?.trim() ?? "";
  if (errorText !== "" && isInterruptText(errorText)) return null;
  if (input.resultSubtype && ORDINARY_SUBTYPES.has(input.resultSubtype)) return null;

  if (input.apiStatus === 401 || input.apiStatus === 403) {
    return { kind: "auth", message: errorText || `HTTP ${input.apiStatus}` };
  }

  const fromRateLimit = classifyRateLimit(input.rateLimit, errorText, now);
  if (fromRateLimit) return fromRateLimit;

  if (input.apiStatus === 529 || input.apiStatus === 503) {
    return {
      kind: "overloaded",
      message: errorText || `HTTP ${input.apiStatus}`,
      ...timingFrom(errorText, now),
    };
  }
  if (input.apiStatus === 429) {
    return {
      kind: "rate_limit",
      message: errorText || "429 Too Many Requests",
      ...timingFrom(errorText, now),
    };
  }

  if (input.resultSubtype === "error_max_budget_usd") {
    return {
      kind: "quota",
      message: errorText || "Claude Code stopped after reaching its spending limit.",
      ...timingFrom(errorText, now),
    };
  }

  if (errorText === "") return null;
  return classifyGenericText(errorText, now);
}

function classifyRateLimit(
  info: SDKRateLimitInfo | null | undefined,
  errorText: string,
  now: Date,
): TurnFailure | null {
  if (!info) return null;
  const credits =
    info.errorCode === "credits_required" || info.overageDisabledReason === "out_of_credits";
  if (info.status !== "rejected" && !credits) return null;

  const resetAt =
    typeof info.resetsAt === "number"
      ? new Date(info.resetsAt * 1000).toISOString()
      : timingFrom(errorText, now).resetAt;
  const retryAfterMs = resetAt
    ? Math.max(0, Date.parse(resetAt) - now.getTime())
    : timingFrom(errorText, now).retryAfterMs;
  const message = errorText || "Claude AI usage limit reached";
  const kind: TurnFailureKind =
    credits || (info.rateLimitType !== undefined && PLAN_WINDOWS.has(info.rateLimitType))
      ? "quota"
      : "rate_limit";
  return {
    kind,
    message,
    ...(resetAt ? { resetAt } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}
