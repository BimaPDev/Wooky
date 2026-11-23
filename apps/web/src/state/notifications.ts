import type { AgeEvent, ReadModel } from "@wooky/contracts";
import { useSyncExternalStore } from "react";
import { create } from "zustand";
import { splitLayout } from "../components/panes/layout.ts";
import { selectThread } from "./actions.ts";
import { subscribeToEvents, useStore, type AppState } from "./store.ts";

export type NotifyKind = "finished" | "needsInput" | "workerReport";

export interface NotifyPrefs {
  finished: boolean;
  needsInput: boolean;
  workerReports: boolean;
  sound: boolean;
}

export type NotifyPermission = NotificationPermission | "unsupported";

export interface NotifyContext {
  /** The window has focus and is on screen. */
  focused: boolean;
  /** Threads the user can see right now. */
  visibleThreadIds: readonly string[];
  permission: NotifyPermission;
  prefs: NotifyPrefs;
}

export interface Notice {
  kind: NotifyKind;
  threadId: string;
  title: string;
  body: string;
}

const prefKey = {
  finished: "finished",
  needsInput: "needsInput",
  workerReport: "workerReports",
} as const satisfies Record<NotifyKind, keyof NotifyPrefs>;

/**
 * The policy: the user switched that kind on, the browser allows it, and the user is not already
 * looking at the thread. A blurred window always counts as not looking.
 */
export function shouldNotify(kind: NotifyKind, threadId: string, context: NotifyContext): boolean {
  if (context.permission !== "granted") return false;
  if (!context.prefs[prefKey[kind]]) return false;
  return !(context.focused && context.visibleThreadIds.includes(threadId));
}

/** The notification an event deserves, or null. Reads titles from the model. */
export function noticeForEvent(
  event: AgeEvent,
  model: Pick<ReadModel, "threads" | "projects">,
): Notice | null {
  const label = (threadId: string) => {
    const thread = model.threads[threadId];
    if (!thread) return null;
    return {
      title: thread.title || "Untitled thread",
      project: model.projects[thread.projectId]?.name ?? "",
    };
  };
  switch (event.type) {
    case "turn.finished": {
      if (event.status === "interrupted") return null;
      const thread = label(event.threadId);
      if (!thread) return null;
      return {
        kind: "finished",
        threadId: event.threadId,
        title: event.status === "failed" ? "Turn failed" : "Turn finished",
        body: thread.project ? `${thread.title} · ${thread.project}` : thread.title,
      };
    }
    case "approval.requested": {
      const thread = label(event.threadId);
      if (!thread) return null;
      return {
        kind: "needsInput",
        threadId: event.threadId,
        title: "Approval needed",
        body: thread.title,
      };
    }
    case "question.requested": {
      const thread = label(event.threadId);
      if (!thread) return null;
      return {
        kind: "needsInput",
        threadId: event.threadId,
        title: "A question is waiting",
        body: event.questions[0]?.question ?? thread.title,
      };
    }
    case "worker.reported": {
      const worker = label(event.workerThreadId);
      return {
        kind: "workerReport",
        threadId: event.coordinatorThreadId,
        title: `${worker?.title ?? "A worker"} reported`,
        body: event.summary.slice(0, 140),
      };
    }
    default:
      return null;
  }
}

/** Threads on screen: the selected one, and every pane of a split. Nothing behind a full-page view. */
export function visibleThreadIds(
  state: Pick<
    AppState,
    "selectedThreadId" | "panes" | "model" | "fleetBoardOpen" | "compareGroupId" | "settingsOpen"
  > & { brainOpen?: boolean },
): string[] {
  if (state.fleetBoardOpen || state.brainOpen || state.compareGroupId) return [];
  const split = splitLayout(state.panes, (id) => Boolean(state.model.threads[id]));
  if (split) return [...split.threadIds];
  return state.selectedThreadId ? [state.selectedThreadId] : [];
}

const STORAGE_KEY = "wooky.notifications";

const DEFAULT_PREFS: NotifyPrefs = {
  finished: false,
  needsInput: false,
  workerReports: false,
  sound: false,
};

/**
 * DeviceSettings has no notification fields, so these live in localStorage on this device only.
 * Storage can be missing or throw (private windows), so every access is guarded.
 */
function loadPrefs(): NotifyPrefs {
  try {
    const raw = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? "null",
    ) as Partial<NotifyPrefs> | null;
    if (!raw || typeof raw !== "object") return DEFAULT_PREFS;
    return {
      finished: raw.finished === true,
      needsInput: raw.needsInput === true,
      workerReports: raw.workerReports === true,
      sound: raw.sound === true,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function savePrefs(prefs: NotifyPrefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* kept for this session only */
  }
}

export const useNotifyPrefs = create<NotifyPrefs>(() => loadPrefs());

function readPermission(): NotifyPermission {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

export const useNotifyPermission = create<{ permission: NotifyPermission }>(() => ({
  permission: readPermission(),
}));

/**
 * Switch one preference. Turning a notification kind on is the only place the browser is asked
 * for permission, and a refusal leaves the kind off.
 */
export async function setNotifyPref(key: keyof NotifyPrefs, value: boolean): Promise<void> {
  if (value && key !== "sound") {
    let permission = readPermission();
    if (permission === "default") {
      permission = await Notification.requestPermission();
      useNotifyPermission.setState({ permission });
    }
    if (permission !== "granted") return;
  }
  const next = { ...useNotifyPrefs.getState(), [key]: value };
  useNotifyPrefs.setState(next);
  savePrefs(next);
}

/** A short two-note chime from WebAudio, so there is no sound asset to ship. */
export function playChime(): void {
  try {
    const context = new AudioContext();
    const now = context.currentTime;
    const gain = context.createGain();
    gain.connect(context.destination);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.32);
    for (const [index, frequency] of [660, 880].entries()) {
      const tone = context.createOscillator();
      tone.type = "sine";
      tone.frequency.setValueAtTime(frequency, now + index * 0.11);
      tone.connect(gain);
      tone.start(now + index * 0.11);
      tone.stop(now + index * 0.11 + 0.2);
    }
    setTimeout(() => void context.close(), 600);
  } catch {
    /* audio may be blocked until the user has interacted with the page */
  }
}

export function windowFocused(): boolean {
  return document.hasFocus() && document.visibilityState === "visible";
}

function deliver(notice: Notice, sound: boolean) {
  try {
    const shown = new Notification(notice.title, { body: notice.body, tag: notice.threadId });
    shown.addEventListener("click", () => {
      window.focus();
      selectThread(notice.threadId);
      shown.close();
    });
  } catch {
    /* some embedded browsers refuse the constructor */
  }
  if (sound) playChime();
}

let started = false;

/** Listen to the event stream for the life of the page. Never asks for permission. */
export function startNotifications(): void {
  if (started) return;
  started = true;
  // sync: the server event stream raises desktop notifications for turns that need the user
  subscribeToEvents((event) => {
    const state = useStore.getState();
    const notice = noticeForEvent(event, state.model);
    if (!notice) return;
    const prefs = useNotifyPrefs.getState();
    const allowed = shouldNotify(notice.kind, notice.threadId, {
      focused: windowFocused(),
      visibleThreadIds: visibleThreadIds(state),
      permission: readPermission(),
      prefs,
    });
    if (allowed) deliver(notice, prefs.sound);
  });
}

function subscribeFocus(onChange: () => void) {
  window.addEventListener("focus", onChange);
  window.addEventListener("blur", onChange);
  document.addEventListener("visibilitychange", onChange);
  return () => {
    window.removeEventListener("focus", onChange);
    window.removeEventListener("blur", onChange);
    document.removeEventListener("visibilitychange", onChange);
  };
}

/**
 * Threads waiting on the user that they are not looking at: the count for the tab title and the
 * app badge. Derived from the model, so it needs no bookkeeping.
 */
export function useWaitingCount(): number {
  const focused = useSyncExternalStore(subscribeFocus, windowFocused, () => true);
  return useStore((state) => {
    const watching = focused ? new Set(visibleThreadIds(state)) : new Set<string>();
    let count = 0;
    for (const thread of Object.values(state.model.threads))
      if (thread.status === "waiting" && !watching.has(thread.id)) count += 1;
    return count;
  });
}

export const titleWithBadge = (title: string, waiting: number): string =>
  waiting > 0 ? `(${waiting}) ${title}` : title;
