import type {
  AgeEvent,
  AppearanceTheme,
  DeviceSettings,
  ProviderStatus,
  ReadModel,
  RuntimeMode,
} from "@age/contracts";
import { applyEvent, emptyReadModel } from "@age/domain";
import { create } from "zustand";
import type { ConnectionStatus } from "../rpc/client.ts";
import { pruneNavStack, type NavStack, type NavTarget } from "../lib/nav-history.ts";
import { loadPanes, savePanes, syncPanes, type PaneLayout } from "../components/panes/layout.ts";
import { claimSnippets, type PendingSnippet } from "../components/review/snippets.ts";

export type Theme = "dark" | "light";

export type Dialog =
  | { kind: "newThread"; projectId: string | null }
  | { kind: "addProject" }
  | { kind: "confirm"; title: string; body: string; confirmLabel: string; onConfirm: () => void }
  | { kind: "revert"; threadId: string; turnId: string };

export interface ChangesPanel {
  open: boolean;
  /** Restrict the diff to one turn, or null for the whole thread. */
  turnId: string | null;
  /** File to scroll to when the panel opens. */
  focusPath: string | null;
}

export type SettingsPage =
  "general" | "appearance" | "usage" | "providers" | "failover" | "projects" | "about";

export interface AppState {
  model: ReadModel;
  status: ConnectionStatus;
  fixture: boolean;
  providers: ProviderStatus[];
  selectedThreadId: string | null;
  sidebarOpen: boolean;
  terminalOpen: boolean;
  changes: ChangesPanel;
  paletteOpen: boolean;
  settingsOpen: boolean;
  settingsPage: SettingsPage;
  deviceSettings: DeviceSettings | null;
  activeAppearance: AppearanceTheme | null;
  previewAppearance: AppearanceTheme | null;
  dialog: Dialog | null;
  fleetBoardOpen: boolean;
  jumpOpen: boolean;
  compareGroupId: string | null;
  fanoutDialog: { projectId: string; prompt: string; runtimeMode: RuntimeMode } | null;
  /** null = follow the system preference. */
  theme: Theme | null;
  /** Bumped when a turn finishes, so the Changes panel knows to refetch. */
  diffVersion: number;
  /** Last rejected command or failed request, in one sentence. */
  notice: string | null;
  /** True while the operating-system folder chooser is open. */
  pickingFolder: boolean;
  nav: NavStack;
  /** When true, navigation actions must not push onto nav.past. */
  navSilent: boolean;
  /** Split panes, remembered per window. Null when the main area shows one thread. */
  panes: PaneLayout | null;
  /** Line text each review note was written against, by note id. Client-side only; lost on reload. */
  reviewSnippets: Record<string, string>;
  /** Snippets waiting for the server to name their note. */
  pendingSnippets: PendingSnippet[];
}

export function currentNavFromState(
  state: Pick<AppState, "selectedThreadId" | "settingsOpen" | "settingsPage">,
): NavTarget {
  if (state.settingsOpen) return { kind: "settings", page: state.settingsPage };
  return { kind: "thread", threadId: state.selectedThreadId };
}

/** A nav target is valid while its thread (if any) still exists in the model. */
export function navTargetExists(model: ReadModel) {
  return (target: NavTarget) =>
    target.kind !== "thread" || target.threadId === null || Boolean(model.threads[target.threadId]);
}

export const useStore = create<AppState>(() => ({
  model: emptyReadModel(),
  status: "connecting",
  fixture: false,
  providers: [],
  selectedThreadId: null,
  sidebarOpen: true,
  terminalOpen: false,
  changes: { open: false, turnId: null, focusPath: null },
  paletteOpen: false,
  settingsOpen: false,
  settingsPage: "general",
  deviceSettings: null,
  activeAppearance: null,
  previewAppearance: null,
  dialog: null,
  fleetBoardOpen: false,
  jumpOpen: false,
  compareGroupId: null,
  fanoutDialog: null,
  theme: null,
  diffVersion: 0,
  notice: null,
  pickingFolder: false,
  nav: { past: [], future: [] },
  navSilent: false,
  panes: loadPanes(),
  reviewSnippets: {},
  pendingSnippets: [],
}));

// sync: store selection and model changes keep the split panes and their saved layout in step
useStore.subscribe((state, prev) => {
  if (state.panes !== prev.panes) savePanes(state.panes);
  if (
    state.panes === prev.panes &&
    state.model === prev.model &&
    state.selectedThreadId === prev.selectedThreadId
  )
    return;
  const next = syncPanes({
    panes: state.panes,
    selected: state.selectedThreadId,
    prevSelected: prev.selectedThreadId,
    threads: state.model.threads,
    pruneMissing: state.model.seq > 0,
  });
  if (next.panes !== state.panes || next.selected !== state.selectedThreadId)
    useStore.setState(next);
});

// sync: a newly appeared review note takes the snippet its composer captured for that line
useStore.subscribe((state, prev) => {
  if (state.model.reviewNotes === prev.model.reviewNotes) return;
  const { pending, claimed } = claimSnippets(
    state.pendingSnippets,
    prev.model.reviewNotes,
    state.model.reviewNotes,
  );
  if (pending.length === state.pendingSnippets.length && Object.keys(claimed).length === 0) return;
  useStore.setState({
    pendingSnippets: pending,
    reviewSnippets: { ...state.reviewSnippets, ...claimed },
  });
});

export function receiveSnapshot(model: ReadModel) {
  useStore.setState((state) => {
    const selected =
      state.selectedThreadId && model.threads[state.selectedThreadId]
        ? state.selectedThreadId
        : newestThreadId(model);
    return { model, selectedThreadId: selected };
  });
}

export function receiveEvent(event: AgeEvent) {
  useStore.setState((state) => {
    const model = applyEvent(state.model, event);
    if (model === state.model) return state;
    const patch: Partial<AppState> = { model };
    if (event.type === "turn.finished" || event.type === "turn.reverted")
      patch.diffVersion = state.diffVersion + 1;
    let selected = state.selectedThreadId;
    if (event.type === "thread.removed" && selected === event.threadId)
      selected = newestThreadId(model);
    if (event.type === "project.removed" && !model.threads[selected ?? ""])
      selected = newestThreadId(model);
    patch.selectedThreadId = selected;
    if (event.type === "thread.removed" || event.type === "project.removed")
      patch.nav = pruneNavStack(state.nav, navTargetExists(model));
    return patch;
  });
}

function newestThreadId(model: ReadModel): string | null {
  let best: { id: string; at: string } | null = null;
  for (const thread of Object.values(model.threads))
    if (!best || thread.updatedAt > best.at) best = { id: thread.id, at: thread.updatedAt };
  return best?.id ?? null;
}
