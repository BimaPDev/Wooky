import type { AgeEvent, ProviderStatus } from "@wooky/contracts";
import { describe, expect, it } from "vitest";
import {
  createdThreadId,
  DEFAULT_DRAFT_PREFS,
  defaultDraftProject,
  draftCommands,
  parsePrefs,
  resolveDraft,
  visibleProjects,
  type DraftContext,
  type NewThreadDraft,
} from "./new-thread.ts";

const at = "2026-01-01T00:00:00.000Z";
const project = (id: string, name: string, scratch?: true) => ({
  id,
  name,
  root: `/work/${id}`,
  createdAt: at,
  settings: { scripts: [] },
  ...(scratch ? { scratch } : {}),
});
const projects = {
  a: project("a", "api"),
  b: project("b", "app"),
  s: project("s", "No project", true),
};

describe("default project", () => {
  it("opens on the project asked for", () => {
    expect(defaultDraftProject(projects, "a", "b")).toBe("b");
  });

  it("opens on No project when that is what was asked for", () => {
    expect(defaultDraftProject(projects, "a", null)).toBeNull();
  });

  it("falls back to the last used project while it exists", () => {
    expect(defaultDraftProject(projects, "a")).toBe("a");
    expect(defaultDraftProject(projects, "gone")).toBeNull();
  });

  it("is No project with nothing to go on, and never the scratch project itself", () => {
    expect(defaultDraftProject(projects, null)).toBeNull();
    expect(defaultDraftProject(projects, "s", "s")).toBeNull();
  });

  it("leaves the scratch project out of the list", () => {
    expect(visibleProjects(projects).map((entry) => entry.id)).toEqual(["a", "b"]);
  });
});

const claude: ProviderStatus = {
  kind: "claude",
  label: "Claude Code",
  installed: true,
  authenticated: true,
  version: null,
  problem: null,
  models: [
    {
      id: "default",
      label: "Default",
      resolvedModel: "claude-opus-5-5",
      efforts: ["low", "medium"],
    },
    { id: "sonnet", label: "Sonnet", efforts: ["low", "medium"] },
  ],
};
const signedOutCodex: ProviderStatus = {
  ...claude,
  kind: "codex",
  authenticated: false,
  models: [{ id: "gpt", label: "GPT" }],
};
const settings = (defaultModel?: string): DraftContext["deviceSettings"] => ({
  providers: defaultModel
    ? { claude: { customModels: [], extraArgs: [], env: {}, defaultModel } }
    : {},
  acpAgents: [],
  disabledProviders: [],
});
const draft = (fields: Partial<NewThreadDraft> = {}): NewThreadDraft => ({
  projectId: null,
  interactionMode: "default",
  isolate: false,
  ...fields,
});

const context = (overrides: Partial<DraftContext> = {}): DraftContext => ({
  providers: [signedOutCodex, claude],
  deviceSettings: settings(),
  prefs: DEFAULT_DRAFT_PREFS,
  ...overrides,
});

describe("resolveDraft", () => {
  it("starts on the first usable provider with its default model, approval and no worktree", () => {
    expect(resolveDraft(draft(), context())).toEqual({
      projectId: null,
      provider: "claude",
      model: "default",
      runtimeMode: "approve",
      interactionMode: "default",
      effort: "medium",
      fastMode: false,
      ultracode: false,
      isolate: false,
    });
  });

  it("drops fast mode and ultracode the model does not support", () => {
    const fast = { ...claude, models: [{ id: "default", label: "Default", fastMode: true }] };
    const resolved = resolveDraft(draft({ fastMode: true, ultracode: true }), {
      ...context(),
      providers: [fast],
    });
    expect(resolved).toMatchObject({ fastMode: true, ultracode: false });
  });

  it("uses the model set in provider settings and the last-used runtime mode", () => {
    const resolved = resolveDraft(
      draft(),
      context({
        deviceSettings: settings("sonnet"),
        prefs: { projectId: null, provider: "claude", runtimeMode: "full" },
      }),
    );
    expect(resolved).toMatchObject({ model: "sonnet", runtimeMode: "full", effort: undefined });
  });

  it("keeps what the person picked on the draft", () => {
    const resolved = resolveDraft(
      draft({ provider: "claude", model: "sonnet", effort: "low", isolate: true }),
      context(),
    );
    expect(resolved).toMatchObject({ model: "sonnet", effort: "low", isolate: true });
  });

  it("has no provider when none is usable", () => {
    expect(resolveDraft(draft(), context({ providers: [signedOutCodex] })).provider).toBeNull();
  });
});

const resolved = (fields = {}) => ({
  ...resolveDraft(draft(fields), {
    providers: [claude],
    deviceSettings: settings(),
    prefs: DEFAULT_DRAFT_PREFS,
  }),
  provider: "claude" as const,
});

describe("draftCommands", () => {
  it("creates the thread, then starts the turn with the prompt", () => {
    const commands = draftCommands(resolved(), "p1", "fix the bug");
    expect(commands.create).toEqual({
      type: "thread.create",
      projectId: "p1",
      provider: "claude",
      model: "default",
      runtimeMode: "approve",
      isolate: false,
      effort: "medium",
    });
    expect(commands.after("t9")).toEqual([
      { type: "turn.start", threadId: "t9", prompt: "fix the bug" },
    ]);
  });

  it("switches to plan mode between the two when plan first is on", () => {
    const commands = draftCommands(resolved({ interactionMode: "plan" }), "p1", "plan it");
    expect(commands.after("t9").map((command) => command.type)).toEqual([
      "thread.configure",
      "turn.start",
    ]);
  });

  it("asks for a worktree only when the toggle is on", () => {
    expect(draftCommands(resolved({ isolate: true }), "p1", "x").create.isolate).toBe(true);
  });
});

const created = (commandId: string | null) =>
  ({
    type: "thread.created",
    seq: 1,
    at,
    commandId,
    thread: { id: "t1" },
  }) as unknown as AgeEvent;

describe("createdThreadId", () => {
  it("matches only the event for its own command", () => {
    expect(createdThreadId(created("c1"), "c1")).toBe("t1");
    expect(createdThreadId(created("c2"), "c1")).toBeNull();
  });
});

describe("parsePrefs", () => {
  it("reads what was saved and ignores anything else", () => {
    expect(parsePrefs('{"projectId":"a","provider":"codex","runtimeMode":"full"}')).toEqual({
      projectId: "a",
      provider: "codex",
      runtimeMode: "full",
    });
    expect(parsePrefs('{"runtimeMode":"yolo"}')).toEqual(DEFAULT_DRAFT_PREFS);
    expect(parsePrefs("not json")).toEqual(DEFAULT_DRAFT_PREFS);
    expect(parsePrefs(null)).toEqual(DEFAULT_DRAFT_PREFS);
  });
});
