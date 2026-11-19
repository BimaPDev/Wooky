const TYPING_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/** True when the key event came from somewhere the user types, so pane shortcuts must not fire. */
export function isTypingTarget(target: unknown): boolean {
  if (typeof target !== "object" || target === null) return false;
  const element = target as { tagName?: unknown; isContentEditable?: unknown };
  if (element.isContentEditable === true) return true;
  return typeof element.tagName === "string" && TYPING_TAGS.has(element.tagName.toUpperCase());
}

/** A divider drag follows only the pointer that started it, and only while a button is still down. */
export function shouldFollowDrag(
  session: { pointerId: number },
  event: { pointerId: number; buttons: number },
): boolean {
  return event.pointerId === session.pointerId && event.buttons !== 0;
}
