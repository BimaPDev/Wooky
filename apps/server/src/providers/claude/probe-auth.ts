import type { EffortLevel } from "@age/contracts";
import type {
  AccountInfo,
  ModelInfo,
  Options,
  SDKUserMessage,
  query,
} from "@anthropic-ai/claude-agent-sdk";

export const CLAUDE_AUTH_UNKNOWN_NOTE = "Could not verify sign-in.";
export const CLAUDE_SIGNED_OUT_PROBLEM = "Run `claude auth login`, then refresh.";

function idleStreamingPrompt(signal: AbortSignal): AsyncIterable<SDKUserMessage> {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              resolve();
              return;
            }
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          return { done: true, value: undefined as never };
        },
      };
    },
  };
}

export type ClaudeModelOption = {
  id: string;
  label: string;
  /** Canonical model id an alias row resolves to. */
  resolvedModel?: string;
  efforts?: EffortLevel[];
};

export type ClaudeAuthProbeResult = {
  authenticated: boolean | null;
  problem: string | null;
  /** Models the SDK reports, ordered and including "default". Empty when unavailable. */
  models: ClaudeModelOption[];
};

function prettifyModelId(value: string): string {
  const words = value
    .replace(/\[(\w+)\]/g, " ($1)")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) =>
      word.startsWith("(") ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1),
    );
  return words.join(" ") || value;
}

/** Plain aliases (default, opus, sonnet...) first, then explicit ids and 1M-context variants. */
function modelRank(id: string): number {
  if (id === "default") return 0;
  return /^[a-z]+$/.test(id) ? 1 : 2;
}

export function claudeModelOptions(infos: readonly ModelInfo[]): ClaudeModelOption[] {
  const seen = new Set<string>();
  const options: ClaudeModelOption[] = [];
  for (const info of infos) {
    const id = typeof info.value === "string" ? info.value.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const resolvedModel = info.resolvedModel?.trim();
    const efforts = info.supportsEffort === false ? [] : (info.supportedEffortLevels ?? []);
    options.push({
      id,
      label: info.displayName?.trim() || prettifyModelId(id),
      ...(resolvedModel ? { resolvedModel } : {}),
      ...(efforts.length > 0 ? { efforts: [...efforts] } : {}),
    });
  }
  if (options.length === 0) return [];
  if (!seen.has("default")) options.push({ id: "default", label: "Default" });
  return options
    .map((option, index) => ({ option, index }))
    .sort((a, b) => modelRank(a.option.id) - modelRank(b.option.id) || a.index - b.index)
    .map(({ option }) => option);
}

export function accountAuthenticated(account: AccountInfo | undefined): boolean {
  if (!account) return false;
  const set = (value: string | undefined) => {
    const trimmed = value?.trim() ?? "";
    return trimmed.length > 0 && trimmed !== "none";
  };
  if (set(account.tokenSource) || set(account.apiKeySource)) return true;
  // A claude.ai (OAuth) login reports the account, not a token source.
  if (set(account.email) || set(account.subscriptionType)) return true;
  // Bedrock, Vertex, gateways and the like authenticate outside Claude Code.
  return account.apiProvider !== undefined && account.apiProvider !== "firstParty";
}

export async function probeClaudeAuth(
  runQuery: typeof query,
  sdkOptions: Pick<Options, "pathToClaudeCodeExecutable" | "env">,
  timeoutMs: number,
): Promise<ClaudeAuthProbeResult> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  let session: ReturnType<typeof runQuery> | undefined;
  try {
    session = runQuery({
      prompt: idleStreamingPrompt(abort.signal),
      options: {
        ...sdkOptions,
        persistSession: false,
        tools: [],
        abortController: abort,
      },
    });
    const active = session;
    const untilAborted = <T>(work: Promise<T>) =>
      Promise.race([
        work,
        new Promise<never>((_, reject) => {
          abort.signal.addEventListener(
            "abort",
            () => reject(new Error("Claude auth probe timed out")),
            { once: true },
          );
        }),
      ]);
    const init = await untilAborted(active.initializationResult());
    const authenticated = accountAuthenticated(init.account);
    let models: ClaudeModelOption[] = [];
    try {
      models = claudeModelOptions(await untilAborted(active.supportedModels()));
    } catch {
      // The model list is a nicety; auth stays valid without it.
    }
    return {
      authenticated,
      problem: authenticated ? null : CLAUDE_SIGNED_OUT_PROBLEM,
      models,
    };
  } catch {
    return { authenticated: null, problem: CLAUDE_AUTH_UNKNOWN_NOTE, models: [] };
  } finally {
    clearTimeout(timer);
    if (!abort.signal.aborted) abort.abort();
    session?.close();
  }
}
