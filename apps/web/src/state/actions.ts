import type { Command, FileDiff, RuntimeMode, ProviderKind } from "@age/contracts";
import { backend } from "./backend.ts";
import { useStore, type Dialog } from "./store.ts";

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

export const selectThread = (threadId: string | null) =>
  useStore.setState((state) => ({
    selectedThreadId: threadId,
    changes: { ...state.changes, turnId: null, focusPath: null },
  }));

export const openDialog = (dialog: Dialog) => useStore.setState({ dialog, paletteOpen: false });
export const closeDialog = () => useStore.setState({ dialog: null });
export const setPaletteOpen = (paletteOpen: boolean) => useStore.setState({ paletteOpen });

export const toggleChanges = () =>
  useStore.setState((state) => ({
    changes: { open: !state.changes.open, turnId: null, focusPath: null },
  }));

export const openChanges = (turnId: string | null, focusPath: string | null) =>
  useStore.setState({ changes: { open: true, turnId, focusPath } });

export const closeChanges = () =>
  useStore.setState((state) => ({ changes: { ...state.changes, open: false } }));

export function confirm(dialog: Omit<Extract<Dialog, { kind: "confirm" }>, "kind">) {
  openDialog({ kind: "confirm", ...dialog });
}

export const addProject = (root: string) => dispatch({ type: "project.add", root });

export function removeProject(projectId: string) {
  const project = useStore.getState().model.projects[projectId];
  confirm({
    title: `Remove ${project?.name ?? "project"}`,
    body: "Its threads leave AGE. Files on disk are not touched.",
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
    body: "The conversation is removed from AGE. Files on disk are not touched.",
    confirmLabel: "Remove thread",
    onConfirm: () => void dispatch({ type: "thread.remove", threadId }),
  });
}

export const configureThread = (
  threadId: string,
  patch: { provider?: ProviderKind; model?: string; runtimeMode?: RuntimeMode },
) => dispatch({ type: "thread.configure", threadId, ...patch });

export const startTurn = (threadId: string, prompt: string) =>
  dispatch({ type: "turn.start", threadId, prompt });

export const interruptTurn = (threadId: string) => dispatch({ type: "turn.interrupt", threadId });

export const respondApproval = (threadId: string, requestId: string, decision: "allow" | "deny") =>
  dispatch({ type: "approval.respond", threadId, requestId, decision });

export function revertTurn(threadId: string, turnId: string) {
  confirm({
    title: "Revert to before this turn",
    body: "Files go back to how they were before this turn, and this turn and later ones are removed.",
    confirmLabel: "Revert",
    onConfirm: () => void dispatch({ type: "turn.revert", threadId, turnId }),
  });
}
