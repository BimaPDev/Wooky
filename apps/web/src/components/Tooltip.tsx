import {
  cloneElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { createPortal } from "react-dom";
import { placeTooltip } from "./overlay-place.ts";

const SHOW_DELAY_MS = 400;
const WARM_MS = 500;

let warmUntil = 0;
let activeClose: (() => void) | null = null;

type TriggerProps = {
  "aria-label"?: string;
  "aria-describedby"?: string;
};

/**
 * A hover and keyboard label for an icon-only control.
 * Portaled to `document.body` so a scrolling, clipping pane cannot cut it off.
 * `aria-describedby` is set only when the tooltip says something the trigger's name does not.
 */
export function Tooltip({
  label,
  shortcut,
  className,
  children,
}: {
  label: string;
  /** An existing shortcut for this action, such as "Esc". */
  shortcut?: string;
  /** Layout class for the anchor, when the trigger was a flex item with its own margin. */
  className?: string;
  children: ReactElement<TriggerProps>;
}) {
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeRef = useRef<() => void>(() => {});
  const [open, setOpen] = useState(false);
  const hint = shortcut ? `${label} ${shortcut}` : label;

  // sync: pointer hover and keyboard focus on the tooltip trigger
  useEffect(() => {
    const el = anchor.current;
    if (!el) return;

    const clear = () => {
      if (timer.current === null) return;
      clearTimeout(timer.current);
      timer.current = null;
    };
    const close = () => {
      clear();
      if (openRef.current) warmUntil = Date.now() + WARM_MS;
      openRef.current = false;
      setOpen(false);
      if (activeClose === close) activeClose = null;
    };
    const show = () => {
      clear();
      if (activeClose && activeClose !== close) activeClose();
      activeClose = close;
      openRef.current = true;
      setOpen(true);
    };
    const schedule = () => {
      if (openRef.current || timer.current !== null) return;
      if (Date.now() < warmUntil) {
        show();
        return;
      }
      timer.current = setTimeout(() => {
        timer.current = null;
        show();
      }, SHOW_DELAY_MS);
    };
    closeRef.current = close;

    const onEnter = () => schedule();
    const onLeave = () => close();
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof Element && target.matches(":focus-visible")) show();
    };
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget;
      if (next instanceof Node && el.contains(next)) return;
      close();
    };
    el.addEventListener("pointerenter", onEnter);
    el.addEventListener("pointerleave", onLeave);
    el.addEventListener("focusin", onFocusIn);
    el.addEventListener("focusout", onFocusOut);
    return () => {
      el.removeEventListener("pointerenter", onEnter);
      el.removeEventListener("pointerleave", onLeave);
      el.removeEventListener("focusin", onFocusIn);
      el.removeEventListener("focusout", onFocusOut);
      clear();
      if (activeClose === close) activeClose = null;
    };
  }, []);

  // sync: document keyboard and scroll dismiss the tooltip
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
    };
    const onScroll = () => closeRef.current();
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  // sync: viewport and the top layer, so the tooltip stays on screen above clipping panes and dialogs
  useLayoutEffect(() => {
    const tip = tipRef.current;
    const anchorEl = anchor.current;
    if (!open || !tip || !anchorEl || hint.length === 0) return;
    showInTopLayer(tip);
    const next = placeTooltip(anchorEl.getBoundingClientRect(), tip.getBoundingClientRect(), {
      width: window.innerWidth,
      height: window.innerHeight,
    });
    tip.style.top = `${next.top}px`;
    tip.style.left = `${next.left}px`;
  }, [open, hint]);

  const name = children.props["aria-label"];
  const differs = shortcut !== undefined || name !== label;
  const describedBy = open && differs ? id : children.props["aria-describedby"];
  const anchorClass = className ? `tooltip-anchor ${className}` : "tooltip-anchor";

  return (
    <span className={anchorClass} ref={anchor}>
      {cloneElement(children, { "aria-describedby": describedBy })}
      {open
        ? createPortal(
            <div
              ref={tipRef}
              className="tooltip"
              popover="manual"
              role="tooltip"
              id={differs ? id : undefined}
              aria-hidden={differs ? undefined : true}
              aria-label={differs ? hint : undefined}
            >
              <span>{label}</span>
              {shortcut ? <kbd>{shortcut}</kbd> : null}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}

/** Popover top layer paints above dialogs and is not clipped by overflow. Manual, so we dismiss it. */
function showInTopLayer(tip: HTMLDivElement) {
  if (typeof tip.showPopover !== "function") return;
  try {
    tip.showPopover();
  } catch {
    // Already showing, or this document has no popover stack.
  }
}
