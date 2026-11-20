import type { ProjectScript, ReadModel, TerminalInfo } from "@wooky/contracts";
import { ServiceError } from "../errors.ts";
import type { TerminalManager, TerminalSubscriber } from "../terminal/session.ts";
import { resolveShellCommand, type ShellCommand } from "../terminal/shell.ts";

export interface ScriptRunInput {
  projectId: string;
  scriptId: string;
  threadId?: string;
  restart?: boolean;
}

export interface ScriptRunDeps {
  model: ReadModel;
  terminals: TerminalManager;
  subscriber: TerminalSubscriber;
  platform?: NodeJS.Platform;
  resolveShell?: typeof resolveShellCommand;
}

/** Argv for running `command` in the user's login shell. Always one argv element for the text. */
export function scriptArgv(
  shell: Pick<ShellCommand, "file" | "args" | "label">,
  command: string,
  platform: NodeJS.Platform,
): { file: string; args: string[] } {
  if (platform !== "win32") {
    return { file: shell.file, args: [...shell.args, "-c", command] };
  }
  const base = shell.file.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  if (
    base === "pwsh.exe" ||
    base === "powershell.exe" ||
    shell.label === "pwsh" ||
    shell.label === "powershell"
  ) {
    return { file: shell.file, args: ["-NoLogo", "-Command", command] };
  }
  return { file: shell.file, args: ["/d", "/s", "/c", command] };
}

export function cwdForScript(
  model: ReadModel,
  projectId: string,
  threadId: string | undefined,
): string {
  const project = model.projects[projectId];
  if (!project) throw new ServiceError("not_found", `No project with id ${projectId}.`);
  if (threadId) {
    const thread = model.threads[threadId];
    if (!thread) throw new ServiceError("not_found", `No thread with id ${threadId}.`);
    if (thread.projectId !== projectId) {
      throw new ServiceError("bad_request", "That thread does not belong to this project.");
    }
    if (thread.worktree?.path) return thread.worktree.path;
  }
  return project.root;
}

export function findLiveScriptSession(
  terminals: TerminalManager,
  projectId: string,
  scriptId: string,
): TerminalInfo | undefined {
  return terminals
    .list()
    .find(
      (session) =>
        !session.exited && session.projectId === projectId && session.scriptId === scriptId,
    );
}

export async function runProjectScript(
  deps: ScriptRunDeps,
  input: ScriptRunInput,
): Promise<TerminalInfo> {
  const project = deps.model.projects[input.projectId];
  if (!project) throw new ServiceError("not_found", `No project with id ${input.projectId}.`);
  const script = project.settings.scripts.find((entry) => entry.id === input.scriptId);
  if (!script) throw new ServiceError("not_found", `No script with id ${input.scriptId}.`);

  const live = findLiveScriptSession(deps.terminals, input.projectId, input.scriptId);
  if (live && !input.restart) {
    return deps.terminals.attach(live.sessionId, deps.subscriber);
  }
  if (live && input.restart) deps.terminals.close(live.sessionId);

  const platform = deps.platform ?? process.platform;
  const resolveShell = deps.resolveShell ?? resolveShellCommand;
  const shell = resolveShell(platform);
  const argv = scriptArgv(shell, script.command, platform);
  const cwd = cwdForScript(deps.model, input.projectId, input.threadId);
  return deps.terminals.open(
    {
      cwd,
      projectId: input.projectId,
      scriptId: input.scriptId,
      title: script.name,
      commandArgv: argv,
    },
    deps.subscriber,
  );
}

export function setupScriptTitle(script: ProjectScript | { name: string }): string {
  return `Setup: ${script.name}`;
}
