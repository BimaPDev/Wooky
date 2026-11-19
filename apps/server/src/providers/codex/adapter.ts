import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  ApprovalRequest,
  ProviderEvent,
  ProviderSettings,
  ProviderStatus,
} from "@age/contracts";
import { resolveCommand } from "../../process/resolve-command.ts";
import { fleetChildEnv, prefixSessionPrompt } from "../agent-env.ts";
import { resolveLaunch, withUserEnv } from "../settings.ts";
import type { ProviderAdapter, TurnInput } from "../types.ts";
import {
  JsonRpcClient,
  type JsonRpcServerRequestMessage,
  UnhandledServerRequestError,
} from "./jsonrpc.ts";
import {
  type AccountReadResponse,
  AccountReadResponseSchema,
  type CodexApprovalDecision,
  CommandExecutionRequestApprovalParamsSchema,
  FileChangeRequestApprovalParamsSchema,
  InitializeResponseSchema,
  ThreadEnvelopeResponseSchema,
  TurnStartedNotificationSchema,
  TurnStartResponseSchema,
  runtimeModeToCodexSettings,
} from "./protocol.ts";
import {
  type CodexTranslator,
  createCodexTranslator,
  normalizeId,
  truncateTitle,
} from "./translate.ts";
import { createUsageBaselineStore } from "./usage-baselines.ts";

const PROBE_TIMEOUT_MS = 5_000;
const NOT_FOUND_PROBLEM = "Codex CLI was not found on PATH. Install it and sign in, then refresh.";
const CODEX_SIGNED_OUT_PROBLEM = "Run `codex login`, then refresh.";
const CODEX_AUTH_UNKNOWN_NOTE = "Could not verify sign-in.";

// Rollback, user-input requests and plan collaboration mode are not in the protocol types
// this adapter is built against, so those capabilities stay off.
const CODEX_CAPABILITIES = { rewind: false, questions: false, planMode: false, queue: true };

const CODEX_MODELS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "default", label: "Default" },
  { id: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
  { id: "gpt-6-astra", label: "GPT-6 Astra" },
  { id: "gpt-6.1-terra", label: "GPT-6.1 Terra" },
  { id: "gpt-6-luna", label: "GPT-6 Luna" },
];

export interface CodexAdapterOptions {
  codexBin?: string;
  codexArgs?: readonly string[];
  /**
   * The user's settings for this provider, read at each probe and turn. `binaryPath` replaces
   * `codex`. `extraArgs` follow `app-server` on its argv (not on `--version`). `env` is merged
   * over the child environment.
   */
  settings?: () => ProviderSettings | undefined;
}

class AsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private ended = false;

  push(item: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
      return;
    }
    this.items.push(item);
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.({ value: undefined as never, done: true });
    }
  }

  next(): Promise<IteratorResult<T>> {
    if (this.items.length > 0) {
      const value = this.items.shift() as T;
      return Promise.resolve({ value, done: false });
    }
    if (this.ended) {
      return Promise.resolve({ value: undefined as never, done: true });
    }
    return new Promise<IteratorResult<T>>((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

function parseVersionOutput(stdout: string, stderr: string): string | null {
  const raw = (stdout.trim() || stderr.trim()).split(/\r?\n/)[0]?.trim() ?? "";
  if (raw.length === 0) return null;
  const match = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(raw);
  return match?.[1] ?? raw;
}

function isErrnoCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === code;
}

function authFromAccountRead(response: AccountReadResponse): boolean | null {
  if (response.account !== undefined && response.account !== null) return true;
  if (response.requiresOpenaiAuth) return false;
  return true;
}

function probeAuthProblem(authenticated: boolean | null): string | null {
  if (authenticated === false) return CODEX_SIGNED_OUT_PROBLEM;
  if (authenticated === null) return CODEX_AUTH_UNKNOWN_NOTE;
  return null;
}

async function probeCodexAuth(
  command: string,
  launchArgs: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ authenticated: boolean | null; problem: string | null }> {
  const client = new JsonRpcClient({
    bin: command,
    args: launchArgs,
    env,
    cwd: process.cwd(),
    onNotification: () => undefined,
    onServerRequest: async (request) => {
      throw new UnhandledServerRequestError(`Unsupported server request: ${request.method}`);
    },
  });

  const work = async (): Promise<{ authenticated: boolean | null; problem: string | null }> => {
    await client.request(
      "initialize",
      {
        clientInfo: { name: "wooky", title: "Wooky", version: "0.0.0" },
        capabilities: null,
      },
      InitializeResponseSchema,
    );
    client.notify("initialized");
    const account = await client.request("account/read", {}, AccountReadResponseSchema);
    const authenticated = authFromAccountRead(account);
    return { authenticated, problem: probeAuthProblem(authenticated) };
  };

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const timed = new Promise<{ authenticated: null; problem: string }>((resolve) => {
      timeoutId = setTimeout(
        () => resolve({ authenticated: null, problem: CODEX_AUTH_UNKNOWN_NOTE }),
        timeoutMs,
      );
    });
    return await Promise.race([work(), timed]);
  } catch {
    return { authenticated: null, problem: CODEX_AUTH_UNKNOWN_NOTE };
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    await client.close();
  }
}

async function probeCodex(
  bin: string,
  configuredArgs: readonly string[] | undefined,
  userArgs: readonly string[],
  userEnv: Readonly<Record<string, string>>,
): Promise<ProviderStatus> {
  const base = {
    kind: "codex" as const,
    label: "Codex",
    models: [...CODEX_MODELS],
    modelsSource: "static" as const,
    capabilities: CODEX_CAPABILITIES,
  };
  const resolved = resolveCommand(bin);
  const command = resolved?.command ?? bin;
  const env = withUserEnv(userEnv);
  const versionArgs = [...(resolved?.prefixArgs ?? []), ...(configuredArgs ?? []), "--version"];
  const launchArgs = [
    ...(resolved?.prefixArgs ?? []),
    ...(configuredArgs ?? ["app-server"]),
    ...userArgs,
  ];

  if (!resolved && process.platform === "win32") {
    return {
      ...base,
      installed: false,
      authenticated: null,
      version: null,
      problem: NOT_FOUND_PROBLEM,
    };
  }

  const execFileAsync = promisify(execFile);
  try {
    const { stdout, stderr } = await execFileAsync(command, versionArgs, {
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
      env,
    });
    const auth = await probeCodexAuth(command, launchArgs, env, PROBE_TIMEOUT_MS);
    return {
      ...base,
      installed: true,
      authenticated: auth.authenticated,
      version: parseVersionOutput(stdout, stderr),
      problem: auth.problem,
    };
  } catch (error) {
    const notFound = isErrnoCode(error, "ENOENT");
    return {
      ...base,
      installed: false,
      authenticated: null,
      version: null,
      problem: notFound
        ? NOT_FOUND_PROBLEM
        : `Codex CLI check failed: ${error instanceof Error ? error.message.split(/\r?\n/)[0] : "unknown error"}.`,
    };
  }
}

function buildUserPrompt(input: TurnInput): string {
  const prompt = prefixSessionPrompt(input.prompt, input);
  const handoff = input.handoffContext?.trim();
  if (!handoff) return prompt;
  return `Earlier conversation in this thread, from another agent:\n\n${handoff}\n\n${prompt}`;
}

function raceApprovalWithAbort(
  signal: AbortSignal,
  ask: () => Promise<"allow" | "deny">,
): Promise<"allow" | "deny"> {
  if (signal.aborted) return Promise.resolve("deny");
  return new Promise<"allow" | "deny">((resolve) => {
    const onAbort = () => resolve("deny");
    signal.addEventListener("abort", onAbort, { once: true });
    ask().then(
      (decision) => {
        signal.removeEventListener("abort", onAbort);
        resolve(decision);
      },
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve("deny");
      },
    );
  });
}

async function handleApprovalRequest(
  request: JsonRpcServerRequestMessage,
  input: TurnInput,
  translator: CodexTranslator,
): Promise<{ decision: CodexApprovalDecision }> {
  if (request.method === "item/commandExecution/requestApproval") {
    const params = CommandExecutionRequestApprovalParamsSchema.parse(request.params);
    if (input.runtimeMode === "full") {
      return { decision: "accept" };
    }
    const rawCommand =
      params.command ?? translator.getCommandForItem(params.itemId) ?? "Run command";
    const approvalRequest: ApprovalRequest = {
      requestId: normalizeId(
        params.approvalId ?? `${params.itemId}-${String(request.id)}`,
        "approval",
      ),
      tool: "command",
      title: truncateTitle(rawCommand, "Run command"),
      detail: params.reason ?? "",
    };
    const decision = await raceApprovalWithAbort(input.signal, () =>
      input.requestApproval(approvalRequest),
    );
    return { decision: decision === "allow" ? "accept" : "decline" };
  }

  if (request.method === "item/fileChange/requestApproval") {
    const params = FileChangeRequestApprovalParamsSchema.parse(request.params);
    if (input.runtimeMode === "full" || (input.runtimeMode === "auto-edits" && !params.grantRoot)) {
      return { decision: "accept" };
    }

    const cached = translator.getFileChangeForItem(params.itemId);
    const paramFiles = params.changes
      ? params.changes.map((c) => c.path.trim()).filter((p) => p.length > 0)
      : [];
    const files = paramFiles.length > 0 ? paramFiles : (cached?.files ?? []);
    const paramDiff = params.diff?.trim()
      ? params.diff
      : params.changes
          ?.map((c) => c.diff ?? "")
          .filter((d) => d.trim().length > 0)
          .join("\n");
    const diff = paramDiff && paramDiff.length > 0 ? paramDiff : cached?.diff;

    const titleSource =
      files.length > 0
        ? `Edit ${files.join(", ")}`
        : params.grantRoot
          ? `Edit files in ${params.grantRoot}`
          : "Edit files";
    const detail =
      params.reason ?? (params.grantRoot ? `Grant write access under ${params.grantRoot}` : "");

    const approvalRequest: ApprovalRequest = {
      requestId: normalizeId(`${params.itemId}-${String(request.id)}`, "approval"),
      tool: "edit",
      title: truncateTitle(titleSource, "Edit files"),
      detail,
      ...(diff && diff.length > 0 ? { diff } : {}),
    };
    const decision = await raceApprovalWithAbort(input.signal, () =>
      input.requestApproval(approvalRequest),
    );
    return { decision: decision === "allow" ? "accept" : "decline" };
  }

  throw new UnhandledServerRequestError(`Unsupported server request method: ${request.method}`);
}

export function createCodexAdapter(options?: CodexAdapterOptions): ProviderAdapter {
  const envBin = process.env.AGE_CODEX_BIN?.trim();
  const configuredBin = options?.codexBin ?? (envBin && envBin.length > 0 ? envBin : "codex");
  const configuredArgs = options?.codexArgs;

  // Cumulative thread token totals seen at the end of each turn, keyed by native
  // thread id. The next turn on that thread subtracts this baseline so AGE sees
  // the per-turn delta rather than the app-server's running total. It is memory
  // only, so the translator seeds a resumed turn that finds no entry here.
  const cumulativeUsageByThread = createUsageBaselineStore();

  const launch = () => {
    const user = resolveLaunch(options?.settings?.(), configuredBin, "Codex");
    const resolved = resolveCommand(user.bin);
    return {
      bin: resolved?.command ?? user.bin,
      args: [
        ...(resolved?.prefixArgs ?? []),
        ...(configuredArgs ?? ["app-server"]),
        ...user.extraArgs,
      ],
      problem: user.problem,
      env: withUserEnv(user.env),
    };
  };

  return {
    kind: "codex",

    probe(): Promise<ProviderStatus> {
      const user = resolveLaunch(options?.settings?.(), configuredBin, "Codex");
      return probeCodex(user.bin, configuredArgs, user.extraArgs, user.env);
    },

    async *runTurn(input: TurnInput): AsyncIterable<ProviderEvent> {
      if (input.signal.aborted) {
        yield { type: "done", status: "interrupted", error: null };
        return;
      }

      const usageBaseline = input.resumeSessionId
        ? cumulativeUsageByThread.get(input.resumeSessionId)
        : null;
      const translator = createCodexTranslator({
        usageBaseline,
        resumed: input.resumeSessionId !== null,
      });
      const queue = new AsyncQueue<ProviderEvent>();
      let deferredDone: Extract<ProviderEvent, { type: "done" }> | null = null;
      let protocolFailure: Error | null = null;
      let activeThreadId: string | null = input.resumeSessionId;
      let activeTurn: { threadId: string; turnId: string } | null = null;
      const nativeTurnId = () => activeTurn?.turnId;

      let resolveTurnWaiter: (() => void) | null = null;
      const turnWaiter = new Promise<void>((resolve) => {
        resolveTurnWaiter = resolve;
      });

      const pushEvents = (events: readonly ProviderEvent[]) => {
        for (const event of events) {
          if (event.type === "done") {
            deferredDone = event;
            resolveTurnWaiter?.();
          } else {
            queue.push(event);
          }
        }
      };

      const { bin: codexBin, args: codexArgs, problem, env: userEnv } = launch();
      if (problem) {
        yield { type: "done", status: "failed", error: problem };
        return;
      }
      const client = new JsonRpcClient({
        bin: codexBin,
        args: codexArgs,
        cwd: input.cwd,
        env: fleetChildEnv(input.threadId, userEnv),
        onNotification: ({ method, params }) => {
          if (method === "turn/started") {
            const started = TurnStartedNotificationSchema.safeParse(params);
            if (started.success) {
              const threadId = started.data.threadId ?? activeThreadId;
              if (threadId) activeTurn = { threadId, turnId: started.data.turn.id };
            }
          }
          pushEvents(translator.translateNotification(method, params));
        },
        onServerRequest: (request) => handleApprovalRequest(request, input, translator),
        // Decline any approval still pending when the client is torn down (e.g. the
        // turn was interrupted), so the app-server's JSON-RPC request never dangles.
        // Only the two approval methods take a decision; anything else gets a
        // JSON-RPC error reply from the client.
        cancelServerRequest: (request) =>
          request.method === "item/commandExecution/requestApproval" ||
          request.method === "item/fileChange/requestApproval"
            ? { decision: "decline" as CodexApprovalDecision }
            : undefined,
        onProtocolError: (err) => {
          if (!protocolFailure) protocolFailure = err;
          resolveTurnWaiter?.();
          // A dropped response leaves its request pending forever. Stopping the
          // client rejects every pending request so the turn can fail.
          void client.close();
        },
      });

      const onAbort = () => {
        void client.abort(activeTurn).finally(() => {
          resolveTurnWaiter?.();
        });
      };
      input.signal.addEventListener("abort", onAbort, { once: true });

      const driveTurn = async (): Promise<void> => {
        let setupError: Error | null = null;
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

          const settings = runtimeModeToCodexSettings(input.runtimeMode, input.cwd);
          const modelOverride =
            input.model.trim().length > 0 && input.model !== "default" ? input.model : undefined;

          const threadResponse = input.resumeSessionId
            ? await client.request(
                "thread/resume",
                {
                  threadId: input.resumeSessionId,
                  cwd: input.cwd,
                  approvalPolicy: settings.approvalPolicy,
                  approvalsReviewer: settings.approvalsReviewer,
                  sandbox: settings.sandbox,
                  ...(modelOverride ? { model: modelOverride } : {}),
                },
                ThreadEnvelopeResponseSchema,
              )
            : await client.request(
                "thread/start",
                {
                  cwd: input.cwd,
                  approvalPolicy: settings.approvalPolicy,
                  approvalsReviewer: settings.approvalsReviewer,
                  sandbox: settings.sandbox,
                  ...(modelOverride ? { model: modelOverride } : {}),
                },
                ThreadEnvelopeResponseSchema,
              );

          const codexThreadId = threadResponse.thread.id;
          activeThreadId = codexThreadId;
          if (input.resumeSessionId !== null && codexThreadId !== input.resumeSessionId) {
            translator.rebaseline(cumulativeUsageByThread.get(codexThreadId));
          }
          pushEvents(translator.bindSession(codexThreadId));

          const promptText = buildUserPrompt(input);
          translator.beginTurn();
          const turnResponse = await client.request(
            "turn/start",
            {
              threadId: codexThreadId,
              input: [{ type: "text", text: promptText, text_elements: [] }],
              cwd: input.cwd,
              approvalPolicy: settings.approvalPolicy,
              approvalsReviewer: settings.approvalsReviewer,
              sandboxPolicy: settings.sandboxPolicy,
              ...(modelOverride ? { model: modelOverride } : {}),
            },
            TurnStartResponseSchema,
          );

          activeTurn = { threadId: codexThreadId, turnId: turnResponse.turn.id };
          if (input.signal.aborted) {
            await client.abort(activeTurn);
          } else {
            await Promise.race([turnWaiter, client.closed.then(() => undefined)]);
          }
        } catch (err) {
          setupError = err instanceof Error ? err : new Error(String(err));
        }

        const exitInfo = await client.close();

        let finalDone = deferredDone;
        if (input.signal.aborted) {
          finalDone =
            deferredDone?.status === "interrupted"
              ? deferredDone
              : ((translator.finish("interrupted", null)[0] as
                  Extract<ProviderEvent, { type: "done" }> | undefined) ?? {
                  type: "done",
                  status: "interrupted",
                  error: null,
                });
        } else if (!finalDone) {
          const stderr = client.getStderrTail();
          let message =
            protocolFailure?.message ??
            setupError?.message ??
            translator.getLastError() ??
            `Codex app-server exited unexpectedly (code ${exitInfo.code !== null ? String(exitInfo.code) : "unknown"})`;
          if (stderr && !message.includes(stderr)) {
            message = `${message}: ${stderr}`;
          }
          const fallback = translator.finish("failed", message, setupError ?? protocolFailure)[0];
          if (fallback && fallback.type === "done") {
            finalDone = fallback;
          }
        }

        // Carry this turn's ending cumulative total forward so the next turn on
        // this thread emits a per-turn delta.
        const cumulativeUsage = translator.getCumulativeUsage();
        if (cumulativeUsage && activeThreadId) {
          cumulativeUsageByThread.set(activeThreadId, cumulativeUsage);
        }

        if (finalDone) {
          const nativeRef = nativeTurnId();
          queue.push(nativeRef ? { ...finalDone, nativeRef } : finalDone);
        }
        queue.close();
      };

      const driverPromise = driveTurn();

      try {
        while (true) {
          const step = await queue.next();
          if (step.done) break;
          yield step.value;
        }
        await driverPromise;
      } finally {
        input.signal.removeEventListener("abort", onAbort);
        await client.close();
      }
    },
  };
}
