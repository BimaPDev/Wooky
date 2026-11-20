import { useEffect, useSyncExternalStore } from "react";
import { toggleSidebar } from "../../../state/actions.ts";
import { useAnywhereHistory } from "../../../state/anywhere-history.ts";
import { useStore } from "../../../state/store.ts";

/** Keep in step with the `max-width` in styles/phone.css. */
export const PHONE_QUERY = "(max-width: 640px)";

const mediaQuery = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(PHONE_QUERY)
    : null;

export const isPhone = (): boolean => mediaQuery()?.matches ?? false;

function subscribe(onChange: () => void) {
  const query = mediaQuery();
  query?.addEventListener("change", onChange);
  return () => query?.removeEventListener("change", onChange);
}

export function usePhone(): boolean {
  return useSyncExternalStore(subscribe, isPhone, () => false);
}

/** On a phone the sidebar starts closed and the terminal stays behind its button. */
export function applyPhoneDefaults(): void {
  if (isPhone()) useStore.setState({ sidebarOpen: false, terminalOpen: false });
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])';

const drawerEl = () => document.querySelector<HTMLElement>(".sidebar");

const focusables = () => {
  const drawer = drawerEl();
  return drawer ? [...drawer.querySelectorAll<HTMLElement>(FOCUSABLE)] : [];
};

/** Three bars: the phone's menu button, in place of the desktop sidebar icon. */
export function IconMenu() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
    </svg>
  );
}

/**
 * The sidebar is a drawer on a phone: a scrim behind it closes it, and so does choosing
 * anything in the main area.
 */
export function PhoneDrawer() {
  const phone = usePhone();
  const open = useStore((state) => state.sidebarOpen);

  // sync: picking a thread, draft, board, comparison or peer thread closes the drawer on a phone
  useEffect(() => {
    if (!phone) return;
    const close = () => {
      if (useStore.getState().sidebarOpen) toggleSidebar();
    };
    const offMain = useStore.subscribe((state, prev) => {
      if (
        state.selectedThreadId !== prev.selectedThreadId ||
        (state.newThread !== null && prev.newThread === null) ||
        (state.fleetBoardOpen && !prev.fleetBoardOpen) ||
        (state.compareGroupId !== null && prev.compareGroupId === null) ||
        (state.settingsOpen && !prev.settingsOpen)
      )
        close();
    });
    const offPeer = useAnywhereHistory.subscribe((state, prev) => {
      if (state.replicaView && state.replicaView !== prev.replicaView) close();
    });
    return () => {
      offMain();
      offPeer();
    };
  }, [phone]);

  // sync: document keyboard
  useEffect(() => {
    if (!phone || !open) return;
    const drawer = drawerEl();
    const first = drawer?.querySelector<HTMLElement>(FOCUSABLE) ?? drawer;
    first?.focus({ preventScroll: true });

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        toggleSidebar();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      if (!firstItem || !lastItem) {
        event.preventDefault();
        drawer?.focus();
        return;
      }
      const active = document.activeElement;
      if (!drawer?.contains(active)) {
        event.preventDefault();
        firstItem.focus();
      } else if (event.shiftKey && active === firstItem) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && active === lastItem) {
        event.preventDefault();
        firstItem.focus();
      }
    };

    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (useStore.getState().sidebarOpen) return;
      document
        .querySelector<HTMLButtonElement>('[aria-label="Show sidebar"]')
        ?.focus({ preventScroll: true });
    };
  }, [phone, open]);

  if (!phone || !open) return null;
  return (
    <button
      type="button"
      className="drawer-scrim"
      aria-label="Close sidebar"
      onClick={toggleSidebar}
    />
  );
}
