import { statSync } from "node:fs";
import { Command, type DeviceSettings } from "@wooky/contracts";
import type { EffectRunner } from "../effects/runner.ts";
import { ServiceError } from "../errors.ts";
import type { DispatchResult, EventStore } from "../store/event-store.ts";
import { decide, type DecideContext } from "./decide.ts";

export interface Dispatcher {
  /** Records a command. Resolving means the intent is saved, not that the work finished. */
  dispatch(input: unknown): DispatchResult;
  /** Shutdown: every later dispatch is rejected as unavailable. */
  close(): void;
}

export function createDispatcher(deps: {
  store: EventStore;
  runner: EffectRunner;
  ctx: DecideContext;
  deviceSettings?: () => DeviceSettings;
}): Dispatcher {
  const { store, runner, ctx } = deps;
  let closed = false;
  return {
    close() {
      closed = true;
    },
    dispatch(input) {
      if (closed) throw new ServiceError("unavailable", "The server is shutting down.");
      const parsed = Command.safeParse(input);
      if (!parsed.success) throw new ServiceError("bad_request", parsed.error.message);
      const command = parsed.data;

      const receipt = store.receipt(command.commandId);
      if (receipt) return { ...receipt, duplicate: true };

      if (command.type === "project.add" && !isDirectory(command.root))
        throw new ServiceError("bad_request", `${command.root} is not a directory.`);

      const settings = deps.deviceSettings?.();
      const decision = decide(store.model, command, {
        ...ctx,
        ...(settings ? { failoverSettings: settings.failover } : {}),
      });
      if (!decision.ok) throw new ServiceError(decision.code, decision.message);
      const committed = store.commit({
        commandId: command.commandId,
        events: decision.events,
        effects: decision.effects,
      });
      runner.enqueue(committed.effects);
      return committed.result;
    },
  };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
