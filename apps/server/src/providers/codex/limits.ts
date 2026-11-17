import { z } from "zod";
import type { LimitWindow, ProviderLimits } from "@age/contracts";
import { resolveCommand } from "../../process/resolve-command.ts";
import { JsonRpcClient } from "./jsonrpc.ts";
import { InitializeResponseSchema } from "./protocol.ts";

const RateLimitWindowSchema = z.object({
  usedPercent: z.number(),
  windowDurationMins: z.number().nullable(),
  resetsAt: z.number().nullable(),
});

const RateLimitSnapshotSchema = z.object({
  primary: RateLimitWindowSchema.nullable().optional(),
  secondary: RateLimitWindowSchema.nullable().optional(),
  planType: z.string().nullable().optional(),
});

export const CodexRateLimitsReadResponseSchema = z.object({
  rateLimits: RateLimitSnapshotSchema,
});
export type CodexRateLimitsReadResponse = z.infer<typeof CodexRateLimitsReadResponseSchema>;

export type CodexLimitsProbeOptions = {
  codexBin?: string;
  codexArgs?: readonly string[];
  cwd?: string;
  now?: () => Date;
  /** Inject a fake client factory in tests. */
  openClient?: (opts: {
    bin: string;
    args?: readonly string[];
    cwd: string;
  }) => {
    request: JsonRpcClient["request"];
    notify: JsonRpcClient["notify"];
    close: () => Promise<unknown>;
  };
};

const FIVE_HOUR_MINS = 5 * 60;
const WEEKLY_MINS = 7 * 24 * 60;

export function labelFromWindowDurationMins(mins: number | null): string {
  if (mins === FIVE_HOUR_MINS) return "5-hour";
  if (mins === WEEKLY_MINS) return "Weekly";
  if (mins === null || !Number.isFinite(mins) || mins <= 0) return "Window";
  const hours = Math.round(mins / 60);
  return `${hours}h`;
}

function toIsoFromEpochSeconds(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000).toISOString();
}

function pushCodexWindow(
  windows: LimitWindow[],
  id: "primary" | "secondary",
  raw: z.infer<typeof RateLimitWindowSchema> | null | undefined,
): void {
  if (!raw) return;
  const usedPercent = Number.isFinite(raw.usedPercent) ? raw.usedPercent : null;
  const resetsAt = toIsoFromEpochSeconds(raw.resetsAt);
  if (usedPercent === null && resetsAt === null) return;
  windows.push({
    id,
    label: labelFromWindowDurationMins(raw.windowDurationMins),
    usedPercent,
    resetsAt,
  });
}

export function normalizeCodexRateLimits(
  raw: CodexRateLimitsReadResponse,
  checkedAt: string = new Date().toISOString(),
): ProviderLimits {
  const windows: LimitWindow[] = [];
  pushCodexWindow(windows, "primary", raw.rateLimits.primary);
  pushCodexWindow(windows, "secondary", raw.rateLimits.secondary);
  const plan = raw.rateLimits.planType ?? null;
  return {
    provider: "codex",
    available: true,
    plan,
    windows,
    checkedAt,
    problem: null,
  };
}

export async function fetchCodexLimits(
  options: CodexLimitsProbeOptions = {},
): Promise<ProviderLimits> {
  const now = options.now ?? (() => new Date());
  const checkedAt = now().toISOString();
  const envBin = process.env.AGE_CODEX_BIN?.trim();
  const configuredBin = options.codexBin ?? (envBin && envBin.length > 0 ? envBin : "codex");
  const resolved = resolveCommand(configuredBin);
  const bin = resolved?.command ?? configuredBin;
  // Always append `app-server`: JsonRpcClient only defaults that when args is omitted,
  // and Windows node-wrapper resolution supplies prefixArgs without it.
  const args = [...(resolved?.prefixArgs ?? []), ...(options.codexArgs ?? []), "app-server"];
  const cwd = options.cwd ?? process.cwd();

  // Codex refuses to start when TERM=dumb (common under agent/CI shells).
  const env = { ...process.env };
  if (env.TERM === "dumb") delete env.TERM;

  const open =
    options.openClient ??
    ((opts) =>
      new JsonRpcClient({
        bin: opts.bin,
        args: opts.args,
        cwd: opts.cwd,
        env,
        onNotification: () => undefined,
        onServerRequest: async () => {
          throw new Error("Unexpected server request during rate-limit probe.");
        },
      }));

  const client = open({ bin, args, cwd });
  try {
    await client.request(
      "initialize",
      {
        clientInfo: { name: "wooky", title: "Wooky", version: "0.0.0" },
        capabilities: null,
      },
      InitializeResponseSchema,
    );
    client.notify("initialized");
    const raw = await client.request(
      "account/rateLimits/read",
      {},
      CodexRateLimitsReadResponseSchema,
    );
    return normalizeCodexRateLimits(raw, checkedAt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      provider: "codex",
      available: false,
      plan: null,
      windows: [],
      checkedAt,
      problem: message.trim() || "Could not read Codex plan limits.",
    };
  } finally {
    await client.close();
  }
}
