export type ComposerTrigger =
  | { kind: "mention"; query: string; replaceStart: number; replaceEnd: number }
  | { kind: "slash"; query: string; replaceStart: number; replaceEnd: number };

/** Whether an active @mention or leading / command applies at the caret. */
export function composerTrigger(text: string, caret: number): ComposerTrigger | null {
  const mention = mentionTrigger(text, caret);
  if (mention) return mention;
  return slashTrigger(text, caret);
}

function mentionTrigger(text: string, caret: number): ComposerTrigger | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  const query = before.slice(at + 1);
  if (/[\s\n]/.test(query)) return null;
  return { kind: "mention", query, replaceStart: at, replaceEnd: caret };
}

function slashTrigger(text: string, caret: number): ComposerTrigger | null {
  if (!text.startsWith("/")) return null;
  const query = text.slice(1, caret);
  if (/[\s\n]/.test(query)) return null;
  return { kind: "slash", query, replaceStart: 0, replaceEnd: caret };
}

export const SLASH_COMMANDS = [
  { id: "plan", label: "Plan mode", insert: "" },
  { id: "default", label: "Default mode", insert: "" },
  { id: "model", label: "Pick model", insert: "" },
  { id: "new", label: "New thread", insert: "" },
] as const;

export type SlashCommandId = (typeof SLASH_COMMANDS)[number]["id"];

export function filterSlashCommands(query: string) {
  const needle = query.toLowerCase();
  return SLASH_COMMANDS.filter((cmd) => cmd.id.startsWith(needle));
}

/** Insert `@path ` at the trigger span and return the next caret index. */
export function insertMentionPath(
  text: string,
  trigger: ComposerTrigger,
  path: string,
): { text: string; caret: number } {
  const mention = `@${path} `;
  const next = text.slice(0, trigger.replaceStart) + mention + text.slice(trigger.replaceEnd);
  return { text: next, caret: trigger.replaceStart + mention.length };
}

/** Stable key for the active trigger span; used to dismiss and restore the composer menu. */
export function composerMenuIdentity(trigger: ComposerTrigger): string {
  return `${trigger.kind}:${trigger.replaceStart}:${trigger.query}`;
}

/** Drop stored dismissal when the draft no longer carries it (e.g. after send). */
export function composerMenuDismissalForDraft(
  dismissedFor: string | null,
  draft: string,
): string | null {
  if (!draft || !dismissedFor) return null;
  return dismissedFor;
}

export function composerMenuVisible(
  trigger: ComposerTrigger,
  dismissedFor: string | null,
): boolean {
  return dismissedFor !== composerMenuIdentity(trigger);
}

export const PLAN_MODE_UNAVAILABLE = "This provider does not support plan mode";

export function slashPlanModeAllowed(planModeSupported: boolean) {
  return planModeSupported
    ? ({ allowed: true } as const)
    : ({ allowed: false, reason: PLAN_MODE_UNAVAILABLE } as const);
}
