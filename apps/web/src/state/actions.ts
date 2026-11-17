import type {
  Command,
  FileDiff,
  InteractionMode,
  ProviderKind,
  QuestionAnswers,
  RuntimeMode,
} from "@age/contracts";
import { threadsSharingWorkspace } from "@age/domain";
import { patchDeviceSettings } from "./appearance.ts";
import { backend } from "./backend.ts";
import { navBack, navForward, pushNavStack } from "../lib/nav-history.ts";
import { saveTerminalOpen } from "../lib/shell.ts";
import { currentNavFromState, useStore, type Dialog, type SettingsPage } from "./store.ts";

type CommandInput = Command extends infer C
  ? C extends Command
    ? Omit<C, "commandId">
    : never
  : never;

export async function dispatch(command: CommandInput) {
  const full = { ...command, commandId: crypto.randomUUID() } as Command;
  try {
    return await backend().call("dispatch", full);
  } catch (error) {
    console.error(`AGE: ${command.type} failed`, error);
    useStore.setState({
      notice: error instanceof Error ? error.message : "The server could not record that.",
    });
    return null;
  }
}

export async function refreshProviders() {
  try {
    const providers = await backend().call("providers.list", {});
    useStore.setState({ providers });
  } catch (error) {
    console.error("AGE: providers.list failed", error);
  }
}

export function loadDiff(threadId: string, turnId: string | null): Promise<FileDiff[]> {
  return backend().call("git.diff", turnId ? { threadId, turnId } : { threadId });
}

export function suggestPaths(query: string) {
  return backend().call("fs.pickable", query ? { query } : {});
}

function recordNav(next: ReturnType<typeof currentNavFromState>) {
  useStore.setState((state) => {
    if (state.navSilent) return {};
    const from = currentNavFromState(state);
    return { nav: pushNavStack(state.nav, from, next) };
  });
}

function applyNavTarget(target: ReturnType<typeof currentNavFromState>) {
  if (target.kind === "settings") {
    useStore.setState({
      navSilent: true,
      settingsOpen: true,
      settingsPage: target.page,
      paletteOpen: false,
    });
    return;
  }
  useStore.setState((state) => ({
    navSilent: true,
    selectedThreadId: target.threadId,
    settingsOpen: false,
    changes: { ...state.changes, turnId: null, focusPath: null },
  }));
}

export const selectThread = (threadId: string | null) => {
  const next = { kind: "thread", threadId } as const;
  recordNav(next);
  useStore.setState((state) => ({
    selectedThreadId: threadId,
    settingsOpen: false,
    changes: { ...state.changes, turnId: null, focusPath: null },
  }));
};

export function navHistoryBack() {
  const state = useStore.getState();
  const current = currentNavFromState(state);
  const step = navBack(state.nav, current);
  if (!step) return;
  useStore.setState({ nav: step.stack });
  applyNavTarget(step.target);
  useStore.setState({ navSilent: false });
}

export function navHistoryForward() {
  const state = useStore.getState();
  const current = currentNavFromState(state);
  const step = navForward(state.nav, current);
  if (!step) return;
  useStore.setState({ nav: step.stack });
  applyNavTarget(step.target);
  useStore.setState({ navSilent: false });
}

export const toggleSidebar = () =>
  useStore.setState((state) => ({ sidebarOpen: !state.sidebarOpen }));
export const toggleTerminal = () =>
  useStore.setState((state) => {
    const terminalOpen = !state.terminalOpen;
    saveTerminalOpen(terminalOpen);
    return { terminalOpen };
  });

/** Queue a line for the docked terminal (used by Settings → Providers Sign in). */
export const runInTerminal = (line: string) => {
  saveTerminalOpen(true);
  useStore.setState({ terminalOpen: true, pendingTerminalLine: line, settingsOpen: false });
};

/** Take the queued line for a ready shell, once. With no ready shell it stays queued. */
export const takePendingTerminalLine = (sessionId: string | null) => {
  const line = sessionId ? useStore.getState().pendingTerminalLine : null;
  if (line) useStore.setState({ pendingTerminalLine: null });
  return line;
};

/** T3-style connect: enable the provider and open its CLI login in the terminal. */
export function connectProvider(kind: ProviderKind) {
  const command = signInCommand(kind);
  if (!command) {
    useStore.setState({ notice: "Demo is always connected." });
    return;
  }
  const settings = useStore.getState().deviceSettings;
  const disabled = new Set(settings?.disabledProviders ?? []);
  if (disabled.has(kind)) {
    disabled.delete(kind);
    void patchDeviceSettings({ disabledProviders: [...disabled] });
  }
  runInTerminal(command);
}

export function signInCommand(kind: ProviderKind): string | null {
  switch (kind) {
    case "claude":
      return "claude auth login";
    case "codex":
      return "codex login";
    case "cursor":
      return "agent login";
    case "demo":
      return null;
  }
}

export const dismissNotice = () => useStore.setState({ notice: null });

export const openDialog = (dialog: Dialog) => useStore.setState({ dialog, paletteOpen: false });
export const closeDialog = () => useStore.setState({ dialog: null });
export const setPaletteOpen = (paletteOpen: boolean) => useStore.setState({ paletteOpen });

export const openSettings = (page: SettingsPage = "general") => {
  recordNav({ kind: "settings", page });
  useStore.setState({ settingsOpen: true, settingsPage: page, paletteOpen: false });
};
export const closeSettings = () => useStore.setState({ settingsOpen: false });
export const setSettingsPage = (settingsPage: SettingsPage) => useStore.setState({ settingsPage });

export const toggleChanges = () =>
  useStore.setState((state) => {
    const open = !state.changes.open;
    return { changes: { open, turnId: null, focusPath: null } };
  });

export const openChanges = (turnId: string | null, focusPath: string | null) =>
  useStore.setState({ changes: { open: true, turnId, focusPath } });

export const closeChanges = () =>
  useStore.setState((state) => ({
    changes: { ...state.changes, open: false },
  }));

export function confirm(dialog: Omit<Extract<Dialog, { kind: "confirm" }>, "kind">) {
  openDialog({ kind: "confirm", ...dialog });
}

export const addProject = (root: string) => dispatch({ type: "project.add", root });

export function removeProject(projectId: string) {
  const project = useStore.getState().model.projects[projectId];
  confirm({
    title: `Remove ${project?.name ?? "project"}`,
    body: "Its threads leave Wooky. Files on disk are not touched.",
    confirmLabel: "Remove project",
    onConfirm: () => void dispatch({ type: "project.remove", projectId }),
  });
}

export async function createThread(input: {
  projectId: string;
  provider: ProviderKind;
  model: string;
  runtimeMode: RuntimeMode;
  isolate: boolean;
}) {
  const before = new Set(Object.keys(useStore.getState().model.threads));
  const ack = await dispatch({ type: "thread.create", ...input });
  if (!ack) return;
  const created = Object.values(useStore.getState().model.threads).find(
    (thread) => !before.has(thread.id) && thread.projectId === input.projectId,
  );
  if (created) selectThread(created.id);
}

export const renameThread = (threadId: string, title: string) =>
  dispatch({ type: "thread.rename", threadId, title });

export function removeThread(threadId: string) {
  const thread = useStore.getState().model.threads[threadId];
  confirm({
    title: `Remove ${thread?.title || "thread"}`,
    body: "The conversation is removed from Wooky. Files on disk are not touched.",
    confirmLabel: "Remove thread",
    onConfirm: () => void dispatch({ type: "thread.remove", threadId }),
  });
}

export const configureThread = (
  threadId: string,
  patch: {
    provider?: ProviderKind;
    model?: string;
    runtimeMode?: RuntimeMode;
    interactionMode?: InteractionMode;
  },
) => dispatch({ type: "thread.configure", threadId, ...patch });

export const startTurn = (threadId: string, prompt: string, whenBusy?: "reject" | "queue") =>
  dispatch({
    type: "turn.start",
    threadId,
    prompt,
    ...(whenBusy ? { whenBusy } : {}),
  });

export const interruptTurn = (threadId: string) => dispatch({ type: "turn.interrupt", threadId });

export const respondApproval = (threadId: string, requestId: string, decision: "allow" | "deny") =>
  dispatch({ type: "approval.respond", threadId, requestId, decision });

export function revertTurn(threadId: string, turnId: string) {
  openDialog({ kind: "revert", threadId, turnId });
}

export const respondQuestion = (threadId: string, requestId: string, answers: QuestionAnswers) =>
  dispatch({ type: "question.respond", threadId, requestId, answers });

export const dismissQuestion = (threadId: string, requestId: string) =>
  dispatch({ type: "question.respond", threadId, requestId, answers: null });

export const removeQueuedPrompt = (threadId: string, queueId: string) =>
  dispatch({ type: "queue.remove", threadId, queueId });

export const promoteQueuedPrompt = (threadId: string, queueId: string) =>
  dispatch({ type: "queue.promote", threadId, queueId });

export function sharingThreadsForRevert(threadId: string) {
  return threadsSharingWorkspace(useStore.getState().model, threadId);
}
