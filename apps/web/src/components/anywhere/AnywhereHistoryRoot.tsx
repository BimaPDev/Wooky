import { useEffect } from "react";
import { startNotifications, useWaitingCount } from "../../state/notifications.ts";
import { HistoryPanel } from "./history/HistoryPanel.tsx";
import { Toast } from "./history/Toast.tsx";

/** Everything A4b adds that lives outside the main view: history, toasts, notifications, badge. */
export function AnywhereHistoryRoot() {
  const waiting = useWaitingCount();

  // sync: the event stream raises notifications for the life of the page
  useEffect(() => {
    startNotifications();
  }, []);

  // sync: the installed app's badge (Badging API, where the browser has it) follows the waiting count
  useEffect(() => {
    const badge = navigator as Navigator & {
      setAppBadge?: (count: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    const run = waiting > 0 ? badge.setAppBadge?.(waiting) : badge.clearAppBadge?.();
    run?.catch(() => {});
  }, [waiting]);

  return (
    <>
      <HistoryPanel />
      <Toast />
    </>
  );
}
