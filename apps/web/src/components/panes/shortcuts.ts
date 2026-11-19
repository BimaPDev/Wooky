import { useEffect } from "react";
import { focusPaneIndex, splitWithRecent } from "../../state/actions.ts";
import { isTypingTarget } from "./guards.ts";
import { paneShortcut } from "./layout.ts";

/** Window shortcuts for panes: ⌘\ splits, ⌘1–4 focus a pane. Typing in a field never triggers them. */
export function usePaneShortcuts() {
  // sync: window keydown listener for pane shortcuts
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      const shortcut = paneShortcut({
        key: event.key,
        mod: event.metaKey || event.ctrlKey,
        shift: event.shiftKey,
        alt: event.altKey,
      });
      if (!shortcut) return;
      if (shortcut.kind === "split") {
        event.preventDefault();
        splitWithRecent();
        return;
      }
      // ⌘1–9 also picks a model row while the model picker is open.
      if (document.querySelector(".popover")) return;
      if (focusPaneIndex(shortcut.index)) event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
