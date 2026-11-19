import { classifyGenericText, isInterruptText, timingFrom, type TurnFailure } from "../failure.ts";
import { JsonRpcRemoteError } from "./jsonrpc.ts";

export function classifyCodexFailure(input: {
  error?: unknown;
  errorText?: string;
  now?: Date;
}): TurnFailure | null {
  const now = input.now ?? new Date();
  const errorText = input.errorText?.trim() ?? "";
  const structured = inspectError(input.error);
  const message = [errorText, structured.message].filter((part) => part !== "").join("\n");
  if (message !== "" && isInterruptText(message)) return null;

  if (structured.status === 401 || structured.status === 403) {
    return { kind: "auth", message: message || `HTTP ${structured.status}` };
  }
  if (structured.usageLimit) {
    const retryAfterMs =
      structured.resetsInSeconds !== undefined ? structured.resetsInSeconds * 1_000 : undefined;
    const fromText = timingFrom(message, now);
    const resetAt =
      retryAfterMs !== undefined
        ? new Date(now.getTime() + retryAfterMs).toISOString()
        : fromText.resetAt;
    return {
      kind: "quota",
      message: message || "usage_limit_reached",
      ...(resetAt ? { resetAt } : {}),
      ...(retryAfterMs !== undefined
        ? { retryAfterMs }
        : fromText.retryAfterMs !== undefined
          ? { retryAfterMs: fromText.retryAfterMs }
          : {}),
    };
  }
  if (structured.status === 529 || structured.status === 503) {
    return {
      kind: "overloaded",
      message: message || `HTTP ${structured.status}`,
      ...timingFrom(message, now),
    };
  }
  if (structured.status === 429) {
    return {
      kind: "rate_limit",
      message: message || "429 Too Many Requests",
      ...timingFrom(message, now),
    };
  }

  if (message === "") return null;
  return classifyGenericText(message, now);
}

function inspectError(error: unknown): {
  message: string;
  status?: number;
  usageLimit: boolean;
  resetsInSeconds?: number;
} {
  const rec = asRecord(error);
  const remote = error instanceof JsonRpcRemoteError ? error : null;
  const data = remote ? asRecord(remote.data) : rec ? (asRecord(rec.data) ?? rec) : null;
  const nested = data ? (asRecord(data.error) ?? data) : null;

  const messageParts: string[] = [];
  if (error instanceof Error && error.message.trim() !== "") messageParts.push(error.message);
  else if (typeof rec?.message === "string" && rec.message.trim() !== "") {
    messageParts.push(rec.message);
  }
  if (typeof nested?.message === "string" && nested.message.trim() !== "") {
    messageParts.push(nested.message);
  }

  const code = firstString(nested, "code", "type", "error") ?? firstString(data, "code", "type");
  const usageLimit =
    code === "usage_limit_reached" ||
    messageParts.some((part) => /usage_limit_reached/i.test(part));

  const resetsInSeconds = firstNumber(
    nested,
    "resets_in_seconds",
    "resetsInSeconds",
    "resets_at_seconds",
  );
  const status = httpStatus(remote?.code, rec?.code, nested?.code, data?.status, nested?.status);

  return {
    message: messageParts.join("\n"),
    ...(status !== undefined ? { status } : {}),
    usageLimit,
    ...(resetsInSeconds !== undefined ? { resetsInSeconds } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function firstString(
  record: Record<string, unknown> | null,
  ...keys: string[]
): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

function firstNumber(
  record: Record<string, unknown> | null,
  ...keys: string[]
): number | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
}

function httpStatus(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (
      typeof value === "number" &&
      (value === 401 || value === 403 || value === 429 || value === 503 || value === 529)
    ) {
      return value;
    }
  }
  return undefined;
}
