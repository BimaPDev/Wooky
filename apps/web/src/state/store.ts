import type {
  AgeEvent,
  AppearanceTheme,
  DeviceSettings,
  ProviderStatus,
  ReadModel,
} from "@age/contracts";
import { applyEvent, emptyReadModel } from "@age/domain";
import { create } from "zustand";
import type { ConnectionStatus } from "../rpc/client.ts";
import type { NavStack, NavTarget } from "../lib/nav-history.ts";

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

export type SettingsPage = "general" | "appearance" | "usage" | "providers" | "projects" | "about";

export interface AppState {
  model: ReadModel;
  status: ConnectionStatus;
  fixture: boolean;
  providers: ProviderStatus[];
  selectedThreadId: string | null;
  sidebarOpen: boolean;
  terminalOpen: boolean;
  /** Line to send once the terminal session is ready (T3-style Sign in). */
  pendingTerminalLine: string | null;
  changes: ChangesPanel;
  paletteOpen: boolean;
  settingsOpen: boolean;
  settingsPage: SettingsPage;
  deviceSettings: DeviceSettings | null;
  activeAppearance: AppearanceTheme | null;
  dialog: Dialog | null;
  /** null = follow the system preference. */
  theme: Theme | null;
  /** Bumped when a turn finishes, so the Changes panel knows to refetch. */
  diffVersion: number;
  /** Last rejected command or failed request, in one sentence. */
  notice: string | null;
  nav: NavStack;
  /** When true, navigation actions must not push onto nav.past. */
  navSilent: boolean;
}

export function currentNavFromState(
  state: Pick<AppState, "selectedThreadId" | "settingsOpen" | "settingsPage">,
): NavTarget {
  if (state.settingsOpen) return { kind: "settings", page: state.settingsPage };
  return { kind: "thread", threadId: state.selectedThreadId };
}

export const useStore = create<AppState>(() => ({
  model: emptyReadModel(),
  status: "connecting",
  fixture: false,
  providers: [],
  selectedThreadId: null,
  sidebarOpen: true,
  terminalOpen: false,
  pendingTerminalLine: null,
  changes: { open: false, turnId: null, focusPath: null },
  paletteOpen: false,
  settingsOpen: false,
  settingsPage: "general",
  deviceSettings: null,
  activeAppearance: null,
  dialog: null,
  theme: null,
  diffVersion: 0,
  notice: null,
  nav: { past: [], future: [] },
  navSilent: false,
}));

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
    return patch;
  });
}

function newestThreadId(model: ReadModel): string | null {
  let best: { id: string; at: string } | null = null;
  for (const thread of Object.values(model.threads))
    if (!best || thread.updatedAt > best.at) best = { id: thread.id, at: thread.updatedAt };
  return best?.id ?? null;
}
