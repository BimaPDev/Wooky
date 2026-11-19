import type {
  Attachment,
  Command,
  EffortLevel,
  FileDiff,
  InteractionMode,
  MergePreview,
  MergeStrategy,
  ModelTarget,
  ProviderKind,
  QuestionAnswers,
  RuntimeMode,
  TurnFailure,
} from "@wooky/contracts";
import { threadsSharingWorkspace } from "@wooky/domain";
import { patchDeviceSettings } from "./appearance.ts";
import { backend } from "./backend.ts";
import { navBack, navForward, pushNavStack } from "../lib/nav-history.ts";
import { saveTerminalOpen } from "../lib/shell.ts";
import {
  createdThreadId,
  defaultDraftProject,
  draftCommands,
  resolveDraft,
  saveDraftPrefs,
  type NewThreadDraft,
} from "../lib/new-thread.ts";
import {
  fanoutTargetError,
  groupIdFromCreatedEvent,
  groupIdFromDispatchAck,
} from "../components/fleet/helpers.ts";
import { anchorKey } from "../components/review/notes.ts";
import { PENDING_SNIPPET_LIMIT, type PendingSnippet } from "../components/review/snippets.ts";
import {
  addPane,
  focusPane,
  mostRecentThreadId,
  removePane,
  singlePane,
  splitLayout,
  type PaneLayout,
} from "../components/panes/layout.ts";
import {
  currentNavFromState,
  draftProjectId,
  navTargetExists,
  subscribeToEvents,
  useStore,
  type AppState,
  type Dialog,
  type SettingsPage,
} from "./store.ts";

type CommandInput = Command extends infer C
  ? C extends Command
    ? Omit<C, "commandId">
    : never
  : never;

export async function dispatch(command: CommandInput, commandId = crypto.randomUUID()) {
  const full = { ...command, commandId } as Command;
  try {
    const ack = await backend().call("dispatch", full);
    return { ...ack, commandId };
  } catch (error) {
    console.error(`Wooky: ${command.type} failed`, error);
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
    console.error("Wooky: providers.list failed", error);
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
    newThread: target.threadId ? null : state.newThread,
    settingsOpen: false,
    fleetBoardOpen: false,
    compareGroupId: null,
    jumpOpen: false,
    changes: { ...state.changes, turnId: null, focusPath: null },
  }));
}

export const selectThread = (threadId: string | null) => {
  const next = { kind: "thread", threadId } as const;
  recordNav(next);
  useStore.setState((state) => ({
    selectedThreadId: threadId,
    newThread: threadId ? null : state.newThread,
    settingsOpen: false,
    fleetBoardOpen: false,
    compareGroupId: null,
    jumpOpen: false,
    changes: { ...state.changes, turnId: null, focusPath: null },
  }));
};

export function navHistoryBack() {
  const state = useStore.getState();
  const current = currentNavFromState(state);
  const step = navBack(state.nav, current, navTargetExists(state.model));
  if (!step) return;
  useStore.setState({ nav: step.stack });
  applyNavTarget(step.target);
  useStore.setState({ navSilent: false });
}

export function navHistoryForward() {
  const state = useStore.getState();
  const current = currentNavFromState(state);
  const step = navForward(state.nav, current, navTargetExists(state.model));
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

/** Sentence shown after the server opens a real terminal for this command. */
export function signInOpenedCopy(command: string): string {
  return `Opened Terminal to run \`${command}\`. Finish signing in there, then press Refresh.`;
}

/** Enable the provider and ask the server to open its sign-in command in a real terminal. */
export async function connectProvider(
  kind: ProviderKind,
): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  if (kind === "demo") return { ok: false, message: "Demo is always connected." };
  const settings = useStore.getState().deviceSettings;
  const disabled = new Set(settings?.disabledProviders ?? []);
  if (disabled.has(kind)) {
    disabled.delete(kind);
    void patchDeviceSettings({ disabledProviders: [...disabled] });
  }
  try {
    const result = await backend().call("providers.signIn", { provider: kind });
    return { ok: true, message: signInOpenedCopy(result.command) };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Could not open a terminal.",
    };
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
export const closeSettings = () => {
  // Record the hop back to the thread so Back reopens Settings and Forward returns here.
  recordNav({ kind: "thread", threadId: useStore.getState().selectedThreadId });
  useStore.setState({ settingsOpen: false });
};
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

function desktopFolderPicker(): (() => Promise<string | null>) | null {
  const pick = globalThis.window?.wooky?.pickFolder;
  return typeof pick === "function" ? pick : null;
}

export async function pickProjectFolder(): Promise<void> {
  const state = useStore.getState();
  if (state.pickingFolder || state.dialog) return;
  useStore.setState({ pickingFolder: true, paletteOpen: false });
  try {
    const bridge = desktopFolderPicker();
    if (bridge) {
      const path = await bridge();
      if (path) await addProject(path);
      return;
    }
    const picked = await backend().call("fs.pickFolder", { title: "Add project" });
    if (!picked.supported) {
      openDialog({ kind: "addProject" });
      return;
    }
    if (picked.path) await addProject(picked.path);
  } catch (error) {
    useStore.setState({
      notice: error instanceof Error ? error.message : "Could not open the folder chooser.",
    });
    openDialog({ kind: "addProject" });
  } finally {
    useStore.setState({ pickingFolder: false });
  }
}

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

// ── The draft "New thread" screen ───────────────────────

/** Star or unstar models. Only this key goes to the server; the screen updates at once. */
export async function setFavoriteModels(favoriteModels: ModelTarget[]) {
  const before = useStore.getState().deviceSettings;
  if (before) useStore.setState({ deviceSettings: { ...before, favoriteModels } });
  try {
    const settings = await backend().call("settings.put", { settings: { favoriteModels } });
    useStore.setState({ deviceSettings: settings });
  } catch (error) {
    if (before) useStore.setState({ deviceSettings: before });
    useStore.setState({
      notice: error instanceof Error ? error.message : "Could not save your favourites.",
    });
  }
}

const EMPTY_DRAFT: NewThreadDraft = { projectId: null, interactionMode: "default", isolate: false };

/**
 * Show the draft screen. It opens on `projectId` when given, else on the last-used project, else on
 * "No project". An open draft keeps what was already changed on it.
 */
export function openNewThread(projectId?: string | null) {
  recordNav({ kind: "thread", threadId: null });
  useStore.setState((state) => {
    const requested = projectId === undefined ? undefined : projectId;
    const base = state.newThread ?? { ...EMPTY_DRAFT };
    const project =
      requested !== undefined || state.newThread === null
        ? defaultDraftProject(state.model.projects, state.draftPrefs.projectId, requested)
        : base.projectId;
    return {
      newThread: { ...base, projectId: project },
      selectedThreadId: null,
      settingsOpen: false,
      fleetBoardOpen: false,
      compareGroupId: null,
      jumpOpen: false,
      paletteOpen: false,
      dialog: null,
    };
  });
}

/** Change what the draft will start with. Materialises the implicit draft first. */
export function patchNewThread(patch: Partial<NewThreadDraft>) {
  useStore.setState((state) => {
    const base = state.newThread ?? {
      ...EMPTY_DRAFT,
      projectId: defaultDraftProject(state.model.projects, state.draftPrefs.projectId),
    };
    return { newThread: { ...base, ...patch } };
  });
}

/** Saves a composer attachment on the server. Throws with a message the chip can show. */
export async function uploadAttachment(file: File): Promise<Attachment> {
  return backend().call("attachments.put", {
    name: file.name || "pasted",
    dataBase64: await fileBase64(file),
  });
}

export function discardAttachment(id: string) {
  void backend()
    .call("attachments.remove", { id })
    .catch(() => undefined);
}

function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    });
    reader.addEventListener("error", () => reject(new Error("Could not read the file.")));
    reader.readAsDataURL(file);
  });
}

/** The id of the hidden "No project" project. The server creates it on first use. */
export async function ensureScratchProject(): Promise<string | null> {
  try {
    return (await backend().call("projects.scratch", {})).projectId;
  } catch (error) {
    useStore.setState({
      notice: error instanceof Error ? error.message : "Could not prepare a scratch folder.",
    });
    return null;
  }
}

const THREAD_CREATED_WAIT_MS = 8_000;

function waitForThreadCreated(commandId: string): { promise: Promise<string>; cancel: () => void } {
  const handle: { done: boolean; unsub: () => void; timer?: ReturnType<typeof setTimeout> } = {
    done: false,
    unsub: () => {},
  };
  const finish = () => {
    handle.done = true;
    clearTimeout(handle.timer);
    handle.unsub();
  };
  const promise = new Promise<string>((resolve, reject) => {
    handle.timer = setTimeout(() => {
      if (handle.done) return;
      finish();
      reject(new Error("The new thread did not appear."));
    }, THREAD_CREATED_WAIT_MS);
    handle.unsub = subscribeToEvents((event) => {
      const threadId = createdThreadId(event, commandId);
      if (!threadId || handle.done) return;
      finish();
      resolve(threadId);
    });
  });
  return {
    promise,
    cancel: () => {
      if (!handle.done) finish();
    },
  };
}

/**
 * First send from the draft screen. Nothing exists until now: create the thread, open it, then
 * start its first turn. Returns false when nothing was created.
 */
export async function sendNewThread(prompt: string): Promise<boolean> {
  const state = useStore.getState();
  const draft = state.newThread ?? {
    ...EMPTY_DRAFT,
    projectId: defaultDraftProject(state.model.projects, state.draftPrefs.projectId),
  };
  const resolved = resolveDraft(draft, {
    providers: state.providers,
    deviceSettings: state.deviceSettings,
    prefs: state.draftPrefs,
  });
  if (!resolved.provider) {
    useStore.setState({ notice: "No agent is signed in. Connect one in Settings." });
    return false;
  }
  const projectId = resolved.projectId ?? (await ensureScratchProject());
  if (!projectId) return false;
  const plan = draftCommands({ ...resolved, provider: resolved.provider }, projectId, prompt);
  const commandId = crypto.randomUUID();
  const waiting = waitForThreadCreated(commandId);
  const ack = await dispatch(plan.create, commandId);
  if (!ack?.accepted) {
    waiting.cancel();
    return false;
  }
  let threadId: string;
  try {
    threadId = await waiting.promise;
  } catch (error) {
    useStore.setState({
      notice: error instanceof Error ? error.message : "The new thread did not appear.",
    });
    return false;
  }
  const prefs = {
    projectId: resolved.projectId,
    provider: resolved.provider,
    runtimeMode: resolved.runtimeMode,
  };
  saveDraftPrefs(prefs);
  useStore.setState({ draftPrefs: prefs });
  selectThread(threadId);
  for (const command of plan.after(threadId)) {
    if (!(await dispatch(command))) break;
  }
  return true;
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
    effort?: EffortLevel;
    fastMode?: boolean;
    ultracode?: boolean;
  },
) => dispatch({ type: "thread.configure", threadId, ...patch });

/** Hand the thread to another model and retry the prompt that failed. */
export const failoverThread = (
  threadId: string,
  to: ModelTarget,
  failure: TurnFailure,
  retryPrompt: string,
) => dispatch({ type: "thread.failover", threadId, to, failure, retryPrompt });

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

// ── Split panes ─────────────────────────────────────────

const PANE_FULL_NOTICE = "A split holds four panes at most.";

/** The split as it can be shown now: existing threads only, or null when the main area shows one thread. */
function currentSplit(state: AppState): PaneLayout | null {
  return splitLayout(state.panes, (id) => Boolean(state.model.threads[id]));
}

/** The focused pane's thread is the selection. Moving it resets the changes panel, as selectThread does. */
function selectionFor(state: AppState, threadId: string | null): Partial<AppState> {
  if (threadId === state.selectedThreadId) return { selectedThreadId: threadId };
  return {
    selectedThreadId: threadId,
    changes: { ...state.changes, turnId: null, focusPath: null },
  };
}

export function focusPaneThread(threadId: string): void {
  const state = useStore.getState();
  const split = currentSplit(state);
  const index = split ? split.threadIds.indexOf(threadId) : -1;
  if (!split || index < 0) return;
  const focused = focusPane(split, index);
  if (focused === state.panes && threadId === state.selectedThreadId) return;
  useStore.setState({ panes: focused, ...selectionFor(state, threadId) });
}

/** ⌘1–4. Returns false when there is no pane at that position. */
export function focusPaneIndex(index: number): boolean {
  const threadId = currentSplit(useStore.getState())?.threadIds[index];
  if (!threadId) return false;
  focusPaneThread(threadId);
  return true;
}

export function closePaneThread(threadId: string): void {
  const state = useStore.getState();
  const split = currentSplit(state);
  if (!split || !split.threadIds.includes(threadId)) return;
  const next = removePane(split, threadId);
  const survivor = next.threadIds[next.focused] ?? state.selectedThreadId;
  useStore.setState({
    panes: next.threadIds.length >= 2 ? next : null,
    ...selectionFor(state, survivor),
  });
}

/** Store the widths a drag or a keyboard nudge settled on. Ignored when the split changed underneath. */
export function setPaneWeights(weights: readonly number[]): void {
  const state = useStore.getState();
  const split = currentSplit(state);
  if (!split || split.weights.length !== weights.length) return;
  useStore.setState({ panes: { ...split, weights: [...weights] } });
}

/** Open a thread beside the others. With no split yet, it splits with the selected thread. */
export function openInSplit(threadId: string): void {
  const state = useStore.getState();
  if (!state.model.threads[threadId]) return;
  const selected = state.selectedThreadId;
  const base =
    currentSplit(state) ??
    (selected && state.model.threads[selected] ? singlePane(selected) : null);
  if (!base) {
    selectThread(threadId);
    return;
  }
  const added = addPane(base, threadId);
  if (!added.ok) {
    useStore.setState({ notice: PANE_FULL_NOTICE });
    return;
  }
  if (added.layout.threadIds.length < 2) return;
  useStore.setState({ panes: added.layout, ...selectionFor(state, threadId) });
}

/** Cmd+backslash splits with the most recently updated thread that is not already on screen. */
export function splitWithRecent(): void {
  const state = useStore.getState();
  const shown = new Set(currentSplit(state)?.threadIds ?? []);
  const selected = state.selectedThreadId;
  const candidate = mostRecentThreadId(
    state.model.threads,
    (id) => id !== selected && !shown.has(id),
  );
  if (!candidate) {
    useStore.setState({ notice: "No other thread to split with." });
    return;
  }
  openInSplit(candidate);
}

// ── Review notes and merge ──────────────────────────────

/** Adds a note. The line's snippet waits in the store until the server names the note. */
export async function addReviewNote(
  threadId: string,
  anchor: { path: string; line: number; side: "old" | "new" },
  body: string,
  snippet: string,
) {
  const pending: PendingSnippet = { threadId, key: anchorKey(anchor), snippet };
  useStore.setState((state) => ({
    pendingSnippets: [...state.pendingSnippets, pending].slice(-PENDING_SNIPPET_LIMIT),
  }));
  const ack = await dispatch({ type: "review.addNote", threadId, ...anchor, body });
  if (!ack)
    useStore.setState((state) => ({
      pendingSnippets: state.pendingSnippets.filter((entry) => entry !== pending),
    }));
  return ack;
}

export const removeReviewNote = (threadId: string, noteId: string) =>
  dispatch({ type: "review.removeNote", threadId, noteId });

export const sendReviewNotes = (threadId: string, extra: string) =>
  dispatch({ type: "review.send", threadId, ...(extra ? { extra } : {}) });

export const mergeThread = (threadId: string, strategy: MergeStrategy, message: string) =>
  dispatch({ type: "thread.merge", threadId, strategy, ...(message ? { message } : {}) });

export const setJumpOpen = (jumpOpen: boolean) => useStore.setState({ jumpOpen });

export function openFleetBoard() {
  useStore.setState((state) => ({
    fleetBoardOpen: true,
    compareGroupId: null,
    jumpOpen: false,
    paletteOpen: false,
    settingsOpen: false,
    fanoutDialog: null,
    changes: { ...state.changes, open: false },
  }));
}

export function closeCompare() {
  useStore.setState({ compareGroupId: null });
}

export function openCompare(groupId: string) {
  useStore.setState((state) => ({
    compareGroupId: groupId,
    fleetBoardOpen: false,
    jumpOpen: false,
    paletteOpen: false,
    settingsOpen: false,
    fanoutDialog: null,
    changes: { ...state.changes, open: false },
  }));
}

export function openFleetThread(threadId: string) {
  selectThread(threadId);
}

export function openFanoutDialog(input: {
  projectId: string;
  runtimeMode: RuntimeMode;
  getPrompt: () => string;
}) {
  useStore.setState({ fanoutDialog: input, paletteOpen: false, jumpOpen: false });
}

const composerText = () =>
  (
    document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.value ?? ""
  ).trim();

/** "Run on several agents" from the palette: sends what is typed in the composer, in this project. */
export async function openFanoutFromComposer() {
  const state = useStore.getState();
  if (composerText() === "") {
    useStore.setState({ notice: "Type a message first.", paletteOpen: false });
    return;
  }
  const thread = state.selectedThreadId ? state.model.threads[state.selectedThreadId] : undefined;
  if (thread) {
    openFanoutDialog({
      projectId: thread.projectId,
      runtimeMode: thread.runtimeMode,
      getPrompt: composerText,
    });
    return;
  }
  const projectId = draftProjectId(state) ?? (await ensureScratchProject());
  if (projectId) {
    openFanoutDialog({
      projectId,
      runtimeMode: state.newThread?.runtimeMode ?? state.draftPrefs.runtimeMode,
      getPrompt: composerText,
    });
  }
}

export const closeFanoutDialog = () => useStore.setState({ fanoutDialog: null });

export function loadMergePreview(threadId: string): Promise<MergePreview> {
  return backend().call("git.mergePreview", { threadId });
}

const FANOUT_GROUP_WAIT_MS = 8_000;

function waitForGroupCreated(commandId: string): { promise: Promise<string>; cancel: () => void } {
  const handle: { done: boolean; unsub: () => void; timer?: ReturnType<typeof setTimeout> } = {
    done: false,
    unsub: () => {},
  };
  const finish = () => {
    handle.done = true;
    clearTimeout(handle.timer);
    handle.unsub();
  };
  const promise = new Promise<string>((resolve, reject) => {
    handle.timer = setTimeout(() => {
      if (handle.done) return;
      finish();
      reject(new Error("Timed out waiting for the fan-out group."));
    }, FANOUT_GROUP_WAIT_MS);
    handle.unsub = subscribeToEvents((event) => {
      const groupId = groupIdFromCreatedEvent(event, commandId);
      if (!groupId || handle.done) return;
      finish();
      resolve(groupId);
    });
  });
  return {
    promise,
    cancel: () => {
      if (handle.done) return;
      finish();
    },
  };
}

export async function startFanout(input: {
  projectId: string;
  prompt: string;
  targets: { provider: ProviderKind; model: string }[];
  runtimeMode: RuntimeMode;
}) {
  const error = fanoutTargetError(input.targets);
  if (error) {
    useStore.setState({ notice: error });
    return null;
  }
  const commandId = crypto.randomUUID();
  const waiting = waitForGroupCreated(commandId);
  const ack = await dispatch({ type: "fanout.start", ...input }, commandId);
  if (!ack?.accepted) {
    waiting.cancel();
    return null;
  }
  const fromAck = groupIdFromDispatchAck(ack);
  if (fromAck) {
    waiting.cancel();
    closeFanoutDialog();
    openCompare(fromAck);
    return fromAck;
  }
  try {
    const groupId = await waiting.promise;
    closeFanoutDialog();
    openCompare(groupId);
    return groupId;
  } catch (waitError) {
    useStore.setState({
      notice: waitError instanceof Error ? waitError.message : "The fan-out group did not appear.",
    });
    return null;
  }
}

export async function pickFanoutWinner(groupId: string, threadId: string) {
  return dispatch({ type: "fanout.pick", groupId, threadId });
}

export async function mergeFanoutThread(threadId: string) {
  return mergeThread(threadId, "squash", "");
}
