import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ApprovalRequest, ProviderEvent, ProviderStatus } from "@age/contracts";
import {
  query as sdkQuery,
  type CanUseTool,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type SDKMessage,
  type SDKRateLimitInfo,
} from "@anthropic-ai/claude-agent-sdk";
import { resolveCommand } from "../../process/resolve-command.ts";
import type { ProviderAdapter, TurnInput } from "../types.ts";
import { editPreview } from "./diff.ts";
import {
  ASK_USER_QUESTION,
  EXIT_PLAN_MODE,
  questionRequest,
  planDenyMessage,
  resolvePlanMarkdown,
  toolAnswers,
} from "./interaction.ts";
import { clip } from "./text.ts";
import { describeTool, str, toolKind, type ToolInput } from "./tools.ts";
import { probeClaudeAuth } from "./probe-auth.ts";
import { createTranslator } from "./translate.ts";

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 5_000;
const STDERR_TAIL_CHARS = 2_000;

const CAPABILITIES = { rewind: true, questions: true, planMode: true, queue: true };

const MODELS = [
  { id: "default", label: "Default" },
  { id: "fable", label: "Fable" },
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
];

export interface ClaudeAdapterOptions {
  /** Inject a fake SDK in tests. */
  query?: typeof sdkQuery;
  /** Path or name of the `claude` executable. Defaults to `claude` on PATH for probing. */
  claudeBin?: string;
  /** Passive plan-limit updates from `rate_limit_event` messages during turns. */
  onRateLimit?: (info: SDKRateLimitInfo) => void;
}

export function createClaudeAdapter(options: ClaudeAdapterOptions = {}): ProviderAdapter {
  const runQuery = options.query ?? sdkQuery;
  const bin = options.claudeBin ?? "claude";

  return {
    kind: "claude",
    supportsResumeAt: true,

    async probe(): Promise<ProviderStatus> {
      const base = {
        kind: "claude" as const,
        label: "Claude Code",
        authenticated: null,
        models: MODELS,
        capabilities: CAPABILITIES,
      };
      const resolved = resolveCommand(bin);
      if (!resolved && process.platform === "win32") {
        return {
          ...base,
          installed: false,
          version: null,
          problem:
            "Claude Code was not found on your PATH. Install it and make sure `claude` runs in a terminal.",
        };
      }
      const command = resolved?.command ?? bin;
      const args = [...(resolved?.prefixArgs ?? []), "--version"];
      try {
        const { stdout } = await execFileAsync(command, args, {
          timeout: PROBE_TIMEOUT_MS,
          windowsHide: true,
        });
        const version = /\d+\.\d+\.\d+\S*/.exec(stdout)?.[0] ?? null;
        const claudeExecutable = resolved?.prefixArgs.length
          ? undefined
          : (resolved?.command ?? options.claudeBin);
        const auth = await probeClaudeAuth(
          runQuery,
          claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {},
          PROBE_TIMEOUT_MS,
        );
        return {
          ...base,
          installed: true,
          version,
          authenticated: auth.authenticated,
          problem: auth.problem,
        };
      } catch (error) {
        if ((error as { code?: unknown }).code === "ENOENT") {
          const problem =
            "Claude Code was not found on your PATH. Install it and make sure `claude` runs in a terminal.";
          return { ...base, installed: false, version: null, problem };
        }
        const problem =
          "Claude Code is installed but `claude --version` failed or timed out; check that it starts in a terminal.";
        return { ...base, installed: true, version: null, problem };
      }
    },

    async *runTurn(input: TurnInput): AsyncGenerator<ProviderEvent> {
      if (input.signal.aborted) {
        yield { type: "done", status: "interrupted", error: null };
        return;
      }
      const planProposed = { value: false };
      const lastPlanWritePath = { value: null as string | null };
      const translator = createTranslator({
        turnId: input.turnId,
        cwd: input.cwd,
        planProposed,
      });
      const abort = new AbortController();
      let settleAborted: (value: typeof ABORTED) => void = () => undefined;
      const aborted = new Promise<typeof ABORTED>((resolve) => {
        settleAborted = resolve;
      });
      const onAbort = () => {
        abort.abort();
        settleAborted(ABORTED);
      };
      input.signal.addEventListener("abort", onAbort, { once: true });

      const side: ProviderEvent[] = [];
      let wake: () => void = () => undefined;
      const emit = (event: ProviderEvent) => {
        if (event.type === "plan") planProposed.value = true;
        side.push(event);
        wake();
      };

      let stderrTail = "";
      const resolved = resolveCommand(bin);
      const claudeExecutable = resolved?.prefixArgs.length
        ? undefined
        : (resolved?.command ?? options.claudeBin);
      const sdkOptions: Options = {
        cwd: input.cwd,
        abortController: abort,
        includePartialMessages: true,
        ...(input.model !== "default" ? { model: input.model } : {}),
        ...(input.resumeSessionId ? { resume: input.resumeSessionId } : {}),
        ...(input.resumeSessionId && input.resumeAt
          ? { resumeSessionAt: input.resumeAt, forkSession: true }
          : {}),
        ...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
        ...permissionOptions(input, emit, input.cwd, lastPlanWritePath),
        stderr: (data) => {
          stderrTail = (stderrTail + data).slice(-STDERR_TAIL_CHARS);
        },
      };

      let running: ReturnType<typeof sdkQuery> | undefined;
      try {
        running = runQuery({ prompt: buildPrompt(input), options: sdkOptions });
        const iterator = running[Symbol.asyncIterator]();
        let pending: ReturnType<typeof iterator.next> | null = null;
        let finished = false;
        while (!finished) {
          pending ??= iterator.next();
          pending.catch(() => undefined);
          const woken = new Promise<typeof WOKEN>((resolve) => {
            wake = () => resolve(WOKEN);
            if (side.length > 0) resolve(WOKEN);
          });
          const step = await Promise.race([pending, aborted, woken]);
          wake = () => undefined;
          for (const event of side.splice(0)) yield event;
          if (step === WOKEN) continue;
          pending = null;
          if (step === ABORTED || step.done) break;
          if (step.value.type === "rate_limit_event") {
            translator.noteRateLimit(step.value.rate_limit_info);
            options.onRateLimit?.(step.value.rate_limit_info);
          }
          trackPlanWrite(step.value, lastPlanWritePath);
          for (const event of translator.push(step.value)) {
            yield event;
            if (event.type === "done") finished = true;
          }
        }
        for (const event of side.splice(0)) yield event;
        yield* translator.finish(
          input.signal.aborted ? { kind: "aborted" } : { kind: "ended", stderr: stderrTail },
        );
      } catch (error) {
        for (const event of side.splice(0)) yield event;
        yield* translator.finish(
          input.signal.aborted
            ? { kind: "aborted" }
            : { kind: "error", error: withStderr(error, stderrTail) },
        );
      } finally {
        input.signal.removeEventListener("abort", onAbort);
        running?.close();
      }
    },
  };
}

const ABORTED = Symbol("aborted");
const WOKEN = Symbol("woken");

function buildPrompt(input: TurnInput): string {
  if (!input.handoffContext) return input.prompt;
  return [
    "Earlier conversation in this thread, from another agent:",
    "---",
    input.handoffContext,
    "---",
    "",
    input.prompt,
  ].join("\n");
}

function permissionOptions(
  input: TurnInput,
  emit: (event: ProviderEvent) => void,
  cwd: string,
  lastPlanWritePath: { value: string | null },
): Partial<Options> {
  // Always installed: AskUserQuestion and ExitPlanMode need the callback in every mode.
  const canUseTool = createPermissionHandler(input, emit, cwd, lastPlanWritePath);
  if (input.interactionMode === "plan") return { permissionMode: "plan", canUseTool };
  if (input.runtimeMode === "full") {
    return {
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      canUseTool,
    };
  }
  const permissionMode: PermissionMode =
    input.runtimeMode === "auto-edits" ? "acceptEdits" : "default";
  return { permissionMode, canUseTool };
}

const INTERRUPTED: PermissionResult = {
  behavior: "deny",
  message: "The turn was interrupted.",
  interrupt: true,
};

function createPermissionHandler(
  input: TurnInput,
  emit: (event: ProviderEvent) => void,
  cwd: string,
  lastPlanWritePath: { value: string | null },
): CanUseTool {
  return async (toolName, toolInput, context): Promise<PermissionResult> => {
    let onAbort: () => void = () => undefined;
    const aborted = new Promise<"abort">((resolve) => {
      onAbort = () => resolve("abort");
      if (context.signal.aborted) resolve("abort");
      else context.signal.addEventListener("abort", onAbort, { once: true });
    });
    const requestId = `${input.turnId}:${context.toolUseID}`;
    try {
      if (toolName === ASK_USER_QUESTION) {
        return await answerQuestions(input, requestId, toolInput, aborted);
      }
      if (toolName === EXIT_PLAN_MODE) {
        return proposePlan(requestId, toolInput, emit, cwd, lastPlanWritePath.value);
      }
      // Plan mode never skips the card, even in full: the agent must not change anything.
      if (input.runtimeMode === "full" && input.interactionMode !== "plan") {
        return { behavior: "allow", updatedInput: toolInput };
      }
      const request = approvalRequest(input, toolName, toolInput, context.toolUseID);
      const decision = await Promise.race([input.requestApproval(request), aborted]);
      if (decision === "allow") return { behavior: "allow", updatedInput: toolInput };
      if (decision === "abort") return INTERRUPTED;
    } catch {
      // An approval that cannot be built or asked is treated as declined.
    } finally {
      context.signal.removeEventListener("abort", onAbort);
    }
    return { behavior: "deny", message: "The user declined this action." };
  };
}

async function answerQuestions(
  input: TurnInput,
  requestId: string,
  toolInput: ToolInput,
  aborted: Promise<"abort">,
): Promise<PermissionResult> {
  const request = questionRequest(requestId, toolInput);
  if (!request) return { behavior: "deny", message: "The question could not be shown." };
  const answers = await Promise.race([input.requestUserInput(request), aborted]);
  if (answers === "abort") return INTERRUPTED;
  if (answers === null) {
    return { behavior: "deny", message: "The user dismissed the question without answering." };
  }
  return {
    behavior: "allow",
    updatedInput: { ...toolInput, answers: toolAnswers(request, answers) },
  };
}

async function proposePlan(
  requestId: string,
  toolInput: ToolInput,
  emit: (event: ProviderEvent) => void,
  cwd: string,
  lastPlanWritePath: string | null,
): Promise<PermissionResult> {
  const resolved = await resolvePlanMarkdown(toolInput, lastPlanWritePath, cwd);
  if (!resolved.ok) {
    return { behavior: "deny", message: planDenyMessage(resolved.reason) };
  }
  emit({ type: "plan", itemId: requestId, markdown: resolved.markdown });
  return {
    behavior: "deny",
    message: "The user will review the plan.",
    interrupt: true,
  };
}

function trackPlanWrite(message: SDKMessage, lastPlanWritePath: { value: string | null }): void {
  if (message.type !== "assistant" || message.parent_tool_use_id !== null) return;
  for (const block of message.message.content) {
    if (block.type !== "tool_use") continue;
    if (block.name !== "Write" && block.name !== "Edit") continue;
    const input =
      typeof block.input === "object" && block.input !== null
        ? (block.input as Record<string, unknown>)
        : {};
    const filePath = input.file_path;
    if (typeof filePath === "string" && filePath !== "") lastPlanWritePath.value = filePath;
  }
}

function approvalRequest(
  input: TurnInput,
  toolName: string,
  toolInput: ToolInput,
  toolUseId: string,
): ApprovalRequest {
  const described = describeTool(toolName, toolInput, input.cwd);
  const diff = editPreview(toolName, toolInput, input.cwd);
  return {
    requestId: `${input.turnId}:${toolUseId}`,
    tool: toolKind(toolName),
    title: described.title,
    detail: approvalDetail(toolName, toolInput, described.files?.[0]),
    ...(diff ? { diff } : {}),
  };
}

function approvalDetail(toolName: string, toolInput: ToolInput, file: string | undefined): string {
  if (file) return file;
  const command = str(toolInput, "command");
  if (command) return clip(command, 2_000);
  const target = str(toolInput, "url") ?? str(toolInput, "query") ?? str(toolInput, "pattern");
  if (target) return clip(target, 500);
  return clip(`${toolName} ${JSON.stringify(toolInput)}`, 500);
}

function withStderr(error: unknown, stderrTail: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  const last = stderrTail.trim().split("\n").at(-1)?.trim();
  return new Error(last ? `${message} (${clip(last, 300)})` : message);
}
