import type { AgeEvent, ProviderStatus, ReadModel } from "@age/contracts";
import { applyEvent, emptyReadModel } from "@age/domain";
import { create } from "zustand";
import type { ConnectionStatus } from "../rpc/client.ts";

export type Theme = "dark" | "light";

export type Dialog =
  | { kind: "newThread"; projectId: string | null }
  | { kind: "addProject" }
  | { kind: "confirm"; title: string; body: string; confirmLabel: string; onConfirm: () => void };

export interface ChangesPanel {
  open: boolean;
  /** Restrict the diff to one turn, or null for the whole thread. */
  turnId: string | null;
  /** File to scroll to when the panel opens. */
  focusPath: string | null;
}

export interface AppState {
  model: ReadModel;
  status: ConnectionStatus;
  fixture: boolean;
  providers: ProviderStatus[];
  selectedThreadId: string | null;
  changes: ChangesPanel;
  paletteOpen: boolean;
  dialog: Dialog | null;
  /** null = follow the system preference. */
  theme: Theme | null;
  /** Bumped when a turn finishes, so the Changes panel knows to refetch. */
  diffVersion: number;
  /** Last rejected command or failed request, in one sentence. */
  notice: string | null;
}

export const useStore = create<AppState>(() => ({
  model: emptyReadModel(),
  status: "connecting",
  fixture: false,
  providers: [],
  selectedThreadId: null,
  changes: { open: false, turnId: null, focusPath: null },
  paletteOpen: false,
  dialog: null,
  theme: null,
  diffVersion: 0,
  notice: null,
}));

export function receiveSnapshot(model: ReadModel) {
  useStore.setState((state) => ({
    model,
    selectedThreadId:
      state.selectedThreadId && model.threads[state.selectedThreadId]
        ? state.selectedThreadId
        : newestThreadId(model),
  }));
}

export function receiveEvent(event: AgeEvent) {
  useStore.setState((state) => {
    const model = applyEvent(state.model, event);
    if (model === state.model) return state;
    const patch: Partial<AppState> = { model };
    if (event.type === "turn.finished" || event.type === "turn.reverted")
      patch.diffVersion = state.diffVersion + 1;
    if (event.type === "thread.removed" && state.selectedThreadId === event.threadId)
      patch.selectedThreadId = newestThreadId(model);
    if (event.type === "project.removed" && !model.threads[state.selectedThreadId ?? ""])
      patch.selectedThreadId = newestThreadId(model);
    return patch;
  });
}

function newestThreadId(model: ReadModel): string | null {
  let best: { id: string; at: string } | null = null;
  for (const thread of Object.values(model.threads))
    if (!best || thread.updatedAt > best.at) best = { id: thread.id, at: thread.updatedAt };
  return best?.id ?? null;
}
