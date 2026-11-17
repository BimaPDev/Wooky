import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProviderAdapter, TurnInput } from "../types.ts";
import type { ApprovalRequest, ProviderEvent, ProviderStatus } from "@age/contracts";
import {
  query as sdkQuery,
  type CanUseTool,
  type Options,
  type PermissionMode,
  type PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import { editPreview } from "./diff.ts";
import { clip } from "./text.ts";
import { describeTool, str, toolKind, type ToolInput } from "./tools.ts";
import { createTranslator } from "./translate.ts";

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 5_000;
const STDERR_TAIL_CHARS = 2_000;

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
}

export function createClaudeAdapter(options: ClaudeAdapterOptions = {}): ProviderAdapter {
  const runQuery = options.query ?? sdkQuery;
  const bin = options.claudeBin ?? "claude";

  return {
    kind: "claude",

    async probe(): Promise<ProviderStatus> {
      const base = {
        kind: "claude" as const,
        label: "Claude Code",
        authenticated: null,
        models: MODELS,
      };
      try {
        const { stdout } = await execFileAsync(bin, ["--version"], { timeout: PROBE_TIMEOUT_MS });
        const version = /\d+\.\d+\.\d+\S*/.exec(stdout)?.[0] ?? null;
        return { ...base, installed: true, version, problem: null };
      } catch (error) {
        const missing = (error as { code?: unknown }).code === "ENOENT";
        const problem = missing
          ? "Claude Code was not found on your PATH. Install it and make sure `claude` runs in a terminal."
          : "Claude Code is installed but `claude --version` did not finish; check that it starts in a terminal.";
        return { ...base, installed: false, version: null, problem };
      }
    },

    async *runTurn(input: TurnInput): AsyncGenerator<ProviderEvent> {
      const translator = createTranslator({ turnId: input.turnId, cwd: input.cwd });
      const abort = new AbortController();
      const onAbort = () => abort.abort();
      const aborted = new Promise<typeof ABORTED>((resolve) => {
        if (input.signal.aborted) resolve(ABORTED);
        else input.signal.addEventListener("abort", () => resolve(ABORTED), { once: true });
      });
      if (input.signal.aborted) abort.abort();
      else input.signal.addEventListener("abort", onAbort, { once: true });

      let stderrTail = "";
      const sdkOptions: Options = {
        cwd: input.cwd,
        abortController: abort,
        includePartialMessages: true,
        ...(input.model !== "default" ? { model: input.model } : {}),
        ...(input.resumeSessionId ? { resume: input.resumeSessionId } : {}),
        ...(options.claudeBin ? { pathToClaudeCodeExecutable: options.claudeBin } : {}),
        ...permissionOptions(input),
        stderr: (data) => {
          stderrTail = (stderrTail + data).slice(-STDERR_TAIL_CHARS);
        },
      };

      let running: ReturnType<typeof sdkQuery> | undefined;
      try {
        running = runQuery({ prompt: buildPrompt(input), options: sdkOptions });
        const iterator = running[Symbol.asyncIterator]();
        let finished = false;
        while (!finished) {
          const next = iterator.next();
          next.catch(() => undefined);
          const step = await Promise.race([next, aborted]);
          if (step === ABORTED || step.done) break;
          for (const event of translator.push(step.value)) {
            yield event;
            if (event.type === "done") finished = true;
          }
        }
        yield* translator.finish(input.signal.aborted ? { kind: "aborted" } : { kind: "ended" });
      } catch (error) {
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

function permissionOptions(input: TurnInput): Partial<Options> {
  if (input.runtimeMode === "full") {
    return { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true };
  }
  const permissionMode: PermissionMode =
    input.runtimeMode === "auto-edits" ? "acceptEdits" : "default";
  return { permissionMode, canUseTool: createPermissionHandler(input) };
}

function createPermissionHandler(input: TurnInput): CanUseTool {
  return async (toolName, toolInput, context): Promise<PermissionResult> => {
    const request = approvalRequest(input, toolName, toolInput, context.toolUseID);
    const aborted = new Promise<"abort">((resolve) => {
      if (context.signal.aborted) resolve("abort");
      else context.signal.addEventListener("abort", () => resolve("abort"), { once: true });
    });
    try {
      const decision = await Promise.race([input.requestApproval(request), aborted]);
      if (decision === "allow") return { behavior: "allow", updatedInput: toolInput };
      if (decision === "abort")
        return { behavior: "deny", message: "The turn was interrupted.", interrupt: true };
    } catch {
      // An approval that cannot be asked is treated as declined.
    }
    return { behavior: "deny", message: "The user declined this action." };
  };
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
