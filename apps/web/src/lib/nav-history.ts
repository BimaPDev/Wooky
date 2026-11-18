import type { SettingsPage } from "../state/store.ts";

export type NavTarget =
  { kind: "thread"; threadId: string | null } | { kind: "settings"; page: SettingsPage };

export interface NavStack {
  past: NavTarget[];
  future: NavTarget[];
}

/** Each of past and future keeps at most this many entries. */
export const NAV_STACK_LIMIT = 50;

/** Whether a target can still be shown (its thread exists). Defaults to always. */
export type NavTargetValid = (target: NavTarget) => boolean;

const alwaysValid: NavTargetValid = () => true;

export function navTargetKey(target: NavTarget): string {
  return target.kind === "thread" ? `t:${target.threadId ?? ""}` : `s:${target.page}`;
}

export function pushNavStack(stack: NavStack, from: NavTarget, to: NavTarget): NavStack {
  if (navTargetKey(from) === navTargetKey(to)) return stack;
  return { past: [...stack.past, from].slice(-NAV_STACK_LIMIT), future: [] };
}

/** Step back to the newest valid past target, dropping invalid ones on the way. */
export function navBack(
  stack: NavStack,
  current: NavTarget,
  isValid: NavTargetValid = alwaysValid,
): { stack: NavStack; target: NavTarget } | null {
  const past = [...stack.past];
  while (past.length > 0) {
    const target = past.pop() as NavTarget;
    if (!isValid(target)) continue;
    return {
      stack: { past, future: [current, ...stack.future].slice(0, NAV_STACK_LIMIT) },
      target,
    };
  }
  return null;
}

/** Step forward to the next valid future target, dropping invalid ones on the way. */
export function navForward(
  stack: NavStack,
  current: NavTarget,
  isValid: NavTargetValid = alwaysValid,
): { stack: NavStack; target: NavTarget } | null {
  const future = [...stack.future];
  while (future.length > 0) {
    const target = future.shift() as NavTarget;
    if (!isValid(target)) continue;
    return {
      stack: { past: [...stack.past, current].slice(-NAV_STACK_LIMIT), future },
      target,
    };
  }
  return null;
}

/** Drop thread targets that are no longer valid (e.g. removed threads). */
export function pruneNavStack(stack: NavStack, isValid: NavTargetValid): NavStack {
  const past = stack.past.filter(isValid);
  const future = stack.future.filter(isValid);
  if (past.length === stack.past.length && future.length === stack.future.length) return stack;
  return { past, future };
}

export function currentNavTarget(input: {
  selectedThreadId: string | null;
  settingsOpen: boolean;
  settingsPage: SettingsPage;
}): NavTarget {
  if (input.settingsOpen) return { kind: "settings", page: input.settingsPage };
  return { kind: "thread", threadId: input.selectedThreadId };
}
