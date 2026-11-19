import type {
  AgeEvent,
  DeviceSettings,
  EffortLevel,
  InteractionMode,
  Project,
  ProviderKind,
  ProviderStatus,
  RuntimeMode,
} from "@age/contracts";
import { isAvailable } from "../components/labels.ts";
import { defaultModelFor } from "../components/providers/helpers.ts";
import { defaultEffortFor } from "./composer-model.ts";

/** What the person has changed on the draft screen. Anything left out follows the defaults. */
export interface NewThreadDraft {
  /** null is "No project". */
  projectId: string | null;
  provider?: ProviderKind;
  model?: string;
  runtimeMode?: RuntimeMode;
  interactionMode: InteractionMode;
  effort?: EffortLevel;
  isolate: boolean;
}

/** What the draft screen remembers between visits. */
export interface DraftPrefs {
  projectId: string | null;
  provider: ProviderKind | null;
  runtimeMode: RuntimeMode;
}

export const DEFAULT_DRAFT_PREFS: DraftPrefs = {
  projectId: null,
  provider: null,
  runtimeMode: "approve",
};

/** Projects the person can pick: the hidden scratch project is "No project", not a row. */
export const visibleProjects = (projects: Readonly<Record<string, Project>>): Project[] =>
  Object.values(projects)
    .filter((project) => project.scratch !== true)
    .toSorted((a, b) => a.name.localeCompare(b.name));

/**
 * A project the draft opens on: the one asked for (null asks for "No project"), else the last used,
 * else "No project" (null).
 */
export function defaultDraftProject(
  projects: Readonly<Record<string, Project>>,
  lastUsed: string | null,
  requested?: string | null,
): string | null {
  const known = (id: string | null | undefined): id is string =>
    id !== null && id !== undefined && projects[id] !== undefined && projects[id].scratch !== true;
  if (requested === null) return null;
  if (known(requested)) return requested;
  if (known(lastUsed)) return lastUsed;
  return null;
}

export interface DraftContext {
  providers: readonly ProviderStatus[];
  deviceSettings: Pick<DeviceSettings, "providers" | "acpAgents" | "disabledProviders"> | null;
  prefs: DraftPrefs;
}

export interface ResolvedDraft {
  projectId: string | null;
  provider: ProviderKind | null;
  model: string;
  runtimeMode: RuntimeMode;
  interactionMode: InteractionMode;
  effort: EffortLevel | undefined;
  isolate: boolean;
}

/**
 * The draft with every default filled in: the remembered provider when it is still usable, else the
 * first one that is; that provider's default model; the last-used runtime mode; isolation off.
 */
export function resolveDraft(draft: NewThreadDraft, context: DraftContext): ResolvedDraft {
  const disabled = new Set(context.deviceSettings?.disabledProviders ?? []);
  const usable = (kind: ProviderKind | null | undefined) =>
    context.providers.find((entry) => entry.kind === kind && isAvailable(entry, disabled));
  const chosen =
    usable(draft.provider) ??
    usable(context.prefs.provider) ??
    context.providers.find((entry) => isAvailable(entry, disabled));
  const model =
    draft.model && chosen?.kind === draft.provider
      ? draft.model
      : defaultModelFor(chosen, context.deviceSettings);
  return {
    projectId: draft.projectId,
    provider: chosen?.kind ?? null,
    model,
    runtimeMode: draft.runtimeMode ?? context.prefs.runtimeMode,
    interactionMode: draft.interactionMode,
    effort: draft.effort ?? defaultEffortFor(chosen, model),
    isolate: draft.isolate,
  };
}

type Create = {
  type: "thread.create";
  projectId: string;
  provider: ProviderKind;
  model: string;
  runtimeMode: RuntimeMode;
  isolate: boolean;
  effort?: EffortLevel;
};
type Configure = { type: "thread.configure"; threadId: string; interactionMode: "plan" };
type Start = { type: "turn.start"; threadId: string; prompt: string };

export interface DraftCommands {
  create: Create;
  /** The commands that follow once the thread exists, in order. */
  after(threadId: string): (Configure | Start)[];
}

/**
 * Nothing exists until the first send. Then: create the thread, switch it to plan mode when asked,
 * and start the first turn with the prompt.
 */
export function draftCommands(
  draft: ResolvedDraft & { provider: ProviderKind },
  projectId: string,
  prompt: string,
): DraftCommands {
  return {
    create: {
      type: "thread.create",
      projectId,
      provider: draft.provider,
      model: draft.model,
      runtimeMode: draft.runtimeMode,
      isolate: draft.isolate,
      ...(draft.effort ? { effort: draft.effort } : {}),
    },
    after: (threadId) => [
      ...(draft.interactionMode === "plan"
        ? [{ type: "thread.configure" as const, threadId, interactionMode: "plan" as const }]
        : []),
      { type: "turn.start", threadId, prompt },
    ],
  };
}

/** The id of the thread a command created, when `event` is its `thread.created`. */
export function createdThreadId(event: AgeEvent, commandId: string): string | null {
  return event.type === "thread.created" && event.commandId === commandId ? event.thread.id : null;
}

const PREFS_KEY = "age.newThread";

const RUNTIME_MODES: readonly RuntimeMode[] = ["approve", "auto-edits", "full"];

/** Parse what was stored. Anything unreadable falls back to the defaults. */
export function parsePrefs(raw: string | null): DraftPrefs {
  if (!raw) return DEFAULT_DRAFT_PREFS;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return DEFAULT_DRAFT_PREFS;
    const record = value as Record<string, unknown>;
    const runtimeMode = RUNTIME_MODES.find((mode) => mode === record.runtimeMode);
    return {
      projectId: typeof record.projectId === "string" ? record.projectId : null,
      provider: typeof record.provider === "string" ? (record.provider as ProviderKind) : null,
      runtimeMode: runtimeMode ?? DEFAULT_DRAFT_PREFS.runtimeMode,
    };
  } catch {
    return DEFAULT_DRAFT_PREFS;
  }
}

export function loadDraftPrefs(): DraftPrefs {
  try {
    return parsePrefs(localStorage.getItem(PREFS_KEY));
  } catch {
    return DEFAULT_DRAFT_PREFS;
  }
}

export function saveDraftPrefs(prefs: DraftPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}
