import type { TerminalInfo, TerminalPush } from "@wooky/contracts";

type Listener = (message: TerminalPush) => void;
type SessionListener = (info: TerminalInfo) => void;

const listeners = new Set<Listener>();
const sessionListeners = new Set<SessionListener>();

export function subscribeTerminal(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function receiveTerminal(message: TerminalPush) {
  for (const listener of listeners) listener(message);
}

export function requestTerminalSession(info: TerminalInfo) {
  for (const listener of sessionListeners) listener(info);
}

export function subscribeTerminalSession(listener: SessionListener): () => void {
  sessionListeners.add(listener);
  return () => {
    sessionListeners.delete(listener);
  };
}
