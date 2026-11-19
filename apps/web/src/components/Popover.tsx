import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { chooseSide } from "./overlay-place.ts";

const PopoverCloseContext = createContext<() => void>(() => {});

/** Closes the popover a panel sits in. */
export const usePopoverClose = () => useContext(PopoverCloseContext);

type Placement = "below" | "above";

/**
 * A button that opens a popover. It closes on Escape (focus returns to the button) and on a click
 * outside. `minRoom` is the height the panel wants: when the preferred side has less and the other
 * has more, the popover opens on the other side. The panel gets the room left as `--popover-room`.
 */
export function PopoverChip({
  className,
  children,
  placement = "above",
  align = "start",
  label,
  ariaLabel,
  title,
  panel,
  size = "normal",
  minRoom = 0,
  open: controlledOpen,
  onOpenChange,
}: {
  className: string;
  children: ReactNode;
  placement?: Placement;
  align?: "start" | "end";
  label: string;
  /** Accessible name of the button, for a button that only shows an icon. */
  ariaLabel?: string;
  title: string;
  panel: ReactNode;
  size?: "small" | "normal" | "picker";
  minRoom?: number;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [side, setSide] = useState<Placement>(placement);
  const open = controlledOpen ?? uncontrolledOpen;
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const id = useId();

  const setOpenState = useCallback(
    (next: boolean) => {
      if (controlledOpen === undefined) setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [controlledOpen, onOpenChange],
  );

  // sync: document-level pointer and key listeners close the popover
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpenState(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpenState(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, setOpenState]);

  const close = useCallback(() => setOpenState(false), [setOpenState]);

  // sync: the room above and below the button, to pick a side and bound the panel's height
  useLayoutEffect(() => {
    const el = popover.current;
    const anchor = trigger.current;
    if (!open || !el || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const next = chooseSide(rect, window.innerHeight, placement, minRoom);
    const room = next === "above" ? rect.top : window.innerHeight - rect.bottom;
    el.style.setProperty("--popover-room", `${Math.max(240, Math.floor(room - 56))}px`);
    setSide(next);
  }, [open, placement, minRoom]);

  const popoverClass = [
    "popover",
    size === "picker" ? "popover-picker" : size === "small" ? "popover-small" : null,
    side,
    align === "end" ? "end" : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="popover-root" ref={root}>
      <button
        ref={trigger}
        type="button"
        className={className}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-haspopup="dialog"
        aria-label={ariaLabel}
        title={title}
        onClick={() => setOpenState(!open)}
      >
        {children}
      </button>
      {open ? (
        <div ref={popover} className={popoverClass} id={id} role="dialog" aria-label={label}>
          <PopoverCloseContext value={close}>{panel}</PopoverCloseContext>
        </div>
      ) : null}
    </div>
  );
}

/** ArrowUp and ArrowDown move focus between the enabled buttons of the element. */
export function moveFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const items = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
  ];
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  if (index < 0) return;
  event.preventDefault();
  const step = event.key === "ArrowDown" ? 1 : -1;
  items[(index + step + items.length) % items.length]?.focus();
}

/** A labelled on/off row. */
export function Switch({
  label,
  checked,
  disabled,
  title,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  title?: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className="picker-switch"
      disabled={disabled}
      title={title}
      onClick={() => onChange(!checked)}
    >
      <span className="picker-switch-copy">{label}</span>
      <span className="picker-switch-track" data-on={checked} aria-hidden="true">
        <span className="picker-switch-thumb" />
      </span>
    </button>
  );
}

/**
 * A row of mutually exclusive options. Arrow keys move the choice, so the group is one Tab stop.
 */
export function Segmented<T extends string>({
  label,
  options,
  value,
  disabled,
  className,
  onChange,
}: {
  label: string;
  options: readonly { id: T; label: string; icon?: ReactNode }[];
  value: T | undefined;
  disabled?: boolean;
  className?: string;
  onChange: (next: T) => void;
}) {
  const selected = options.some((option) => option.id === value) ? value : options[0]?.id;
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (step === 0 || disabled) return;
    event.preventDefault();
    const group = event.currentTarget;
    const index = options.findIndex((option) => option.id === selected);
    const next = options[(index + step + options.length) % options.length];
    if (!next) return;
    onChange(next.id);
    requestAnimationFrame(() =>
      group.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus(),
    );
  };
  return (
    <div
      className={className ? `pk-segmented ${className}` : "pk-segmented"}
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {options.map((option) => {
        const checked = option.id === selected;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            className={checked ? "pk-segment active" : "pk-segment"}
            disabled={disabled}
            onClick={() => !checked && onChange(option.id)}
          >
            {option.icon}
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
