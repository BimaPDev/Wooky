import { useEffect, useEffectEvent, useRef, type ReactNode, type RefObject } from "react";

/**
 * Native modal dialog: focus trap, Escape and top layer come from the browser. Focus starts on the
 * dialog itself, or on `initialFocusRef` when a caller names a control to start on.
 */
export function Modal({
  label,
  onClose,
  children,
  className = "modal",
  initialFocusRef,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancel = useEffectEvent(() => onClose());

  // sync: browser top-layer dialog opened on mount, closed on unmount
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    const first = initialFocusRef?.current;
    if (first) first.focus({ preventScroll: true });
    else dialog.focus({ preventScroll: true, focusVisible: false });
    const onCancel = (event: Event) => {
      event.preventDefault();
      cancel();
    };
    dialog.addEventListener("cancel", onCancel);
    return () => {
      dialog.removeEventListener("cancel", onCancel);
      if (dialog.open) dialog.close();
    };
  }, [initialFocusRef]);

  return (
    <dialog
      ref={ref}
      tabIndex={-1}
      className={className}
      aria-label={label}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {children}
    </dialog>
  );
}
