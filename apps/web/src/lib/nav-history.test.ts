import { describe, expect, it } from "vitest";
import {
  currentNavTarget,
  navBack,
  navForward,
  NAV_STACK_LIMIT,
  navTargetKey,
  pruneNavStack,
  pushNavStack,
  type NavTarget,
} from "./nav-history.ts";

const thread = (id: string | null): NavTarget => ({ kind: "thread", threadId: id });
const settings: NavTarget = { kind: "settings", page: "appearance" };
const valid = (t: NavTarget) => !(t.kind === "thread" && t.threadId === "gone");

describe("nav history", () => {
  it("keys targets for deduping", () => {
    expect(navTargetKey(thread("a"))).toBe("t:a");
    expect(navTargetKey(settings)).toBe("s:appearance");
  });

  it("pushes the prior target and clears forward history", () => {
    const next = pushNavStack(
      { past: [thread(null)], future: [thread("x")] },
      thread(null),
      thread("a"),
    );
    expect(next.past).toEqual([thread(null), thread(null)]);
    expect(next.future).toEqual([]);
  });

  it("skips a push when the destination is unchanged", () => {
    const stack = pushNavStack({ past: [], future: [thread("a")] }, thread("a"), thread("a"));
    expect(stack).toEqual({ past: [], future: [thread("a")] });
  });

  it("steps back and forward through thread and settings pages", () => {
    let stack = { past: [] as NavTarget[], future: [] as NavTarget[] };
    let current = thread(null);
    stack = pushNavStack(stack, current, thread("a"));
    current = thread("a");
    stack = pushNavStack(stack, current, settings);
    current = settings;

    const back = navBack(stack, current);
    expect(back?.target).toEqual(thread("a"));
    if (!back) throw new Error("expected a back step");
    stack = back.stack;
    current = back.target;

    const again = navBack(stack, current);
    expect(again?.target).toEqual(thread(null));

    stack = { past: [thread(null)], future: [thread("a"), settings] };
    current = thread(null);
    const forward = navForward(stack, current);
    expect(forward?.target).toEqual(thread("a"));
  });

  it("derives the active target from store fields", () => {
    expect(
      currentNavTarget({ selectedThreadId: "t1", settingsOpen: false, settingsPage: "general" }),
    ).toEqual(thread("t1"));
    expect(
      currentNavTarget({ selectedThreadId: "t1", settingsOpen: true, settingsPage: "usage" }),
    ).toEqual({ kind: "settings", page: "usage" });
  });

  it("caps past and future at the stack limit", () => {
    let stack = { past: [] as NavTarget[], future: [] as NavTarget[] };
    for (let i = 0; i < NAV_STACK_LIMIT + 10; i++)
      stack = pushNavStack(stack, thread(String(i)), thread(String(i + 1)));
    expect(stack.past).toHaveLength(NAV_STACK_LIMIT);
    expect(stack.past[0]).toEqual(thread("10"));

    const full = {
      past: [thread("p")],
      future: Array.from({ length: NAV_STACK_LIMIT }, (_, i) => thread(`f${i}`)),
    };
    expect(navBack(full, thread("now"))?.stack.future).toHaveLength(NAV_STACK_LIMIT);
  });

  it("walks past invalid targets in both directions", () => {
    const stack = { past: [thread("a"), thread("gone")], future: [thread("gone"), thread("b")] };
    const back = navBack(stack, thread("x"), valid);
    expect(back?.target).toEqual(thread("a"));
    expect(back?.stack.past).toEqual([]);
    const forward = navForward(stack, thread("x"), valid);
    expect(forward?.target).toEqual(thread("b"));
    expect(forward?.stack.future).toEqual([]);
    expect(navBack({ past: [thread("gone")], future: [] }, thread("x"), valid)).toBeNull();
  });

  it("prunes invalid targets and keeps identity when nothing changes", () => {
    const stack = { past: [thread("gone"), settings], future: [thread("gone")] };
    expect(pruneNavStack(stack, valid)).toEqual({ past: [settings], future: [] });
    const clean = { past: [settings], future: [] };
    expect(pruneNavStack(clean, valid)).toBe(clean);
  });
});
