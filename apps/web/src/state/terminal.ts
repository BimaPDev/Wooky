import type { TerminalPush } from "@age/contracts";

type Listener = (message: TerminalPush) => void;

const listeners = new Set<Listener>();

export function subscribeTerminal(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function receiveTerminal(message: TerminalPush) {
  for (const listener of listeners) listener(message);
}
