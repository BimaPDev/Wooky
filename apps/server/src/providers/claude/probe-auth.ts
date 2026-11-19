import type { AccountInfo, Options, SDKUserMessage, query } from "@anthropic-ai/claude-agent-sdk";

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

export type ClaudeAuthProbeResult = {
  authenticated: boolean | null;
  problem: string | null;
};

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
    const init = await Promise.race([
      session.initializationResult(),
      new Promise<never>((_, reject) => {
        abort.signal.addEventListener(
          "abort",
          () => reject(new Error("Claude auth probe timed out")),
          { once: true },
        );
      }),
    ]);
    const authenticated = accountAuthenticated(init.account);
    return {
      authenticated,
      problem: authenticated ? null : CLAUDE_SIGNED_OUT_PROBLEM,
    };
  } catch {
    return { authenticated: null, problem: CLAUDE_AUTH_UNKNOWN_NOTE };
  } finally {
    clearTimeout(timer);
    if (!abort.signal.aborted) abort.abort();
    session?.close();
  }
}
