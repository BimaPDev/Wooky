import type { SettingsPage } from "../state/store.ts";

export type NavTarget =
  { kind: "thread"; threadId: string | null } | { kind: "settings"; page: SettingsPage };

export interface NavStack {
  past: NavTarget[];
  future: NavTarget[];
}

export function navTargetKey(target: NavTarget): string {
  return target.kind === "thread" ? `t:${target.threadId ?? ""}` : `s:${target.page}`;
}

export function pushNavStack(stack: NavStack, from: NavTarget, to: NavTarget): NavStack {
  if (navTargetKey(from) === navTargetKey(to)) return stack;
  return { past: [...stack.past, from], future: [] };
}

export function navBack(
  stack: NavStack,
  current: NavTarget,
): { stack: NavStack; target: NavTarget } | null {
  const past = stack.past;
  const target = past.at(-1);
  if (!target) return null;
  return {
    stack: { past: past.slice(0, -1), future: [current, ...stack.future] },
    target,
  };
}

export function navForward(
  stack: NavStack,
  current: NavTarget,
): { stack: NavStack; target: NavTarget } | null {
  const future = stack.future;
  const target = future[0];
  if (!target) return null;
  return {
    stack: { past: [...stack.past, current], future: future.slice(1) },
    target,
  };
}

export function currentNavTarget(input: {
  selectedThreadId: string | null;
  settingsOpen: boolean;
  settingsPage: SettingsPage;
}): NavTarget {
  if (input.settingsOpen) return { kind: "settings", page: input.settingsPage };
  return { kind: "thread", threadId: input.selectedThreadId };
}
