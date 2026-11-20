import type { IncomingMessage } from "node:http";
import type { AuthenticateRequest, PeerDirectory, PeerEntry } from "./types.ts";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** Stand-in for A1's token auth: loopback is `local`, everyone else is refused. Replace when A1 lands. */
export const loopbackOnly: AuthenticateRequest = (req: IncomingMessage) => {
  const address = req.socket.remoteAddress;
  return address !== undefined && LOOPBACK.has(address.toLowerCase())
    ? { deviceId: "local" }
    : null;
};

/**
 * Stand-in for A1's paired-device directory. TEST-ONLY HOOK: WOOKY_SYNC_TEST_PEERS is a JSON
 * array of {deviceId, name, baseUrl, token}. Delete this and the env read when A1 lands.
 */
export function testPeerDirectory(raw: string | undefined): PeerDirectory {
  let entries: PeerEntry[] = [];
  if (raw) {
    try {
      entries = JSON.parse(raw) as PeerEntry[];
    } catch {
      console.error("WOOKY_SYNC_TEST_PEERS is not valid JSON; ignoring it.");
    }
  }
  return {
    list: () => entries,
    get: (deviceId) => entries.find((entry) => entry.deviceId === deviceId),
  };
}
