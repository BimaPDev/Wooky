export interface Saver<T> {
  push: (value: T) => void;
  /** Send any unsent value now, for example when the page closes. */
  flush: () => void;
}

/**
 * Coalesces rapid edits behind a trailing debounce and keeps at most one request in flight,
 * so responses cannot arrive out of order. `onIdle` runs only when the latest value has been
 * handled; a response for an older generation never reports idle.
 */
export function createSaver<T>(options: {
  delayMs: number;
  send: (value: T) => Promise<unknown>;
  onIdle: (outcome: "saved" | "failed") => void;
}): Saver<T> {
  let generation = 0;
  let sentGeneration = 0;
  let latest: T | undefined;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;

  const run = () => {
    timer = null;
    if (inFlight || generation === sentGeneration) return;
    const gen = generation;
    const value = latest as T;
    inFlight = true;
    sentGeneration = gen;
    const done = (outcome: "saved" | "failed") => {
      inFlight = false;
      if (gen === generation) options.onIdle(outcome);
      else run();
    };
    options.send(value).then(
      () => done("saved"),
      () => done("failed"),
    );
  };

  return {
    push(value) {
      latest = value;
      generation += 1;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(run, options.delayMs);
    },
    flush() {
      if (timer !== null) clearTimeout(timer);
      run();
    },
  };
}
