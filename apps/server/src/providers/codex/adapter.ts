import { execFile } from "node:child_process";
import type { ApprovalRequest, ProviderEvent, ProviderStatus } from "@age/contracts";
import { resolveCommand } from "../../process/resolve-command.ts";
import type { ProviderAdapter, TurnInput } from "../types.ts";
import {
  JsonRpcClient,
  type JsonRpcServerRequestMessage,
  UnhandledServerRequestError,
} from "./jsonrpc.ts";
import {
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

const PROBE_TIMEOUT_MS = 5_000;
const NOT_FOUND_PROBLEM = "Codex CLI was not found on PATH. Install it and sign in, then refresh.";

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

function probeCodex(bin: string, extraArgs?: readonly string[]): Promise<ProviderStatus> {
  const resolved = resolveCommand(bin);
  const command = resolved?.command ?? bin;
  const args = [...(resolved?.prefixArgs ?? []), ...(extraArgs ?? []), "--version"];
  return new Promise<ProviderStatus>((resolve) => {
    if (!resolved && process.platform === "win32") {
      resolve({
        kind: "codex",
        label: "Codex",
        installed: false,
        authenticated: null,
        version: null,
        models: [...CODEX_MODELS],
        problem: NOT_FOUND_PROBLEM,
      });
      return;
    }
    execFile(command, args, { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const notFound = isErrnoCode(err, "ENOENT");
        resolve({
          kind: "codex",
          label: "Codex",
          installed: false,
          authenticated: null,
          version: null,
          models: [...CODEX_MODELS],
          problem: notFound
            ? NOT_FOUND_PROBLEM
            : `Codex CLI check failed: ${err.message.split(/\r?\n/)[0] ?? "unknown error"}.`,
        });
        return;
      }

      resolve({
        kind: "codex",
        label: "Codex",
        installed: true,
        authenticated: null,
        version: parseVersionOutput(stdout, stderr),
        models: [...CODEX_MODELS],
        problem: null,
      });
    });
  });
}

function buildUserPrompt(prompt: string, handoffContext: string | null): string {
  const handoff = handoffContext?.trim();
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

  const launch = () => {
    const resolved = resolveCommand(configuredBin);
    if (!resolved) return { bin: configuredBin, args: configuredArgs };
    return {
      bin: resolved.command,
      args: [...resolved.prefixArgs, ...(configuredArgs ?? [])],
    };
  };

  return {
    kind: "codex",

    probe(): Promise<ProviderStatus> {
      return probeCodex(configuredBin, configuredArgs);
    },

    async *runTurn(input: TurnInput): AsyncIterable<ProviderEvent> {
      if (input.signal.aborted) {
        yield { type: "done", status: "interrupted", error: null };
        return;
      }

      const translator = createCodexTranslator();
      const queue = new AsyncQueue<ProviderEvent>();
      let deferredDone: Extract<ProviderEvent, { type: "done" }> | null = null;
      let protocolFailure: Error | null = null;
      let activeThreadId: string | null = input.resumeSessionId;
      let activeTurn: { threadId: string; turnId: string } | null = null;

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

      const { bin: codexBin, args: codexArgs } = launch();
      const client = new JsonRpcClient({
        bin: codexBin,
        args: codexArgs,
        cwd: input.cwd,
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
        onProtocolError: (err) => {
          if (!protocolFailure) protocolFailure = err;
          resolveTurnWaiter?.();
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
          pushEvents(translator.bindSession(codexThreadId));

          const promptText = buildUserPrompt(input.prompt, input.handoffContext);
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
            setupError?.message ??
            protocolFailure?.message ??
            translator.getLastError() ??
            `Codex app-server exited unexpectedly (code ${exitInfo.code !== null ? String(exitInfo.code) : "unknown"})`;
          if (stderr && !message.includes(stderr)) {
            message = `${message}: ${stderr}`;
          }
          const fallback = translator.finish("failed", message)[0];
          if (fallback && fallback.type === "done") {
            finalDone = fallback;
          }
        }

        if (finalDone) {
          queue.push(finalDone);
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
