import { useEffect, useEffectEvent, useRef, type ReactNode } from "react";

/** Native modal dialog: focus trap, Escape and top layer come from the browser. */
export function Modal({
  label,
  onClose,
  children,
  className = "modal",
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancel = useEffectEvent(() => onClose());

  // sync: browser top-layer dialog opened on mount, closed on unmount
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    dialog.focus({ preventScroll: true, focusVisible: false });
    const onCancel = (event: Event) => {
      event.preventDefault();
      cancel();
    };
    dialog.addEventListener("cancel", onCancel);
    return () => {
      dialog.removeEventListener("cancel", onCancel);
      if (dialog.open) dialog.close();
    };
  }, []);

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
