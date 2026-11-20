import type { Command, DeviceSettings } from "@wooky/contracts";
import { ServiceError } from "../errors.ts";

export interface TransferCaller {
  /** The device the token belongs to; "local" for an unpaired client on this machine. */
  deviceId: string;
}

/**
 * Who the caller is comes from the authenticated device id alone, never from how a token was
 * presented. The operator is "local"; every other id is a paired device.
 *
 * A paired device acts only as itself. It can ask this device to give a thread to that same
 * device, and only while it is a sync peer. Claiming and importing run on the device that
 * wants the thread, so they are never accepted from a peer.
 */
export function guardTransferCommand(
  command: Command,
  caller: TransferCaller,
  settings: DeviceSettings,
): void {
  if (command.type === "thread.claim" || command.type === "thread.import") {
    if (caller.deviceId !== "local")
      throw new ServiceError("forbidden", "A thread can only be claimed on this machine.");
    return;
  }
  if (command.type !== "thread.release" || caller.deviceId === "local") return;
  if (command.toDeviceId !== caller.deviceId)
    throw new ServiceError("forbidden", "A device can only release a thread to itself.");
  const sync = settings.sync;
  if (!sync.enabled || !sync.categories.threads || !sync.peers.includes(caller.deviceId))
    throw new ServiceError("forbidden", "This device is not a thread sync peer.");
}
