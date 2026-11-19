import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let now = Date.now();

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    now = Date.now();
    // sync: one shared wall-clock interval, ticking once a minute for all cooldown labels
    timer = setInterval(() => {
      now = Date.now();
      for (const notify of listeners) notify();
    }, 60_000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const snapshot = () => now;

/** Wall-clock time in ms that changes at most once a minute, shared by every subscriber. */
export function useMinuteClock(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
