import type { IncomingMessage } from "node:http";

/** A1 will replace this with apps/server/src/remote/auth.ts */
export type AuthenticateRequest = (req: IncomingMessage) => string | null;

/** A1 will replace this with apps/server/src/remote/peers.ts */
export interface PeerDirectory {
  list(): Array<{ deviceId: string; name: string; baseUrl: string; token: string }>;
  get(
    deviceId: string,
  ): { deviceId: string; name: string; baseUrl: string; token: string } | undefined;
}

/** A2 will replace this with syncNow(projectId) from the sync engine */
export type SyncNow = (projectId: string) => Promise<void>;

export function loopbackAuth(req: IncomingMessage): string | null {
  const address = req.socket.remoteAddress;
  if (address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1") {
    return "local";
  }
  return null;
}

export function emptyPeerDirectory(): PeerDirectory {
  return {
    list: () => [],
    get: () => undefined,
  };
}

export const noopSyncNow: SyncNow = async () => {};

/** Test helper: map bearer tokens to peer device ids. */
export function tokenAsDeviceAuth(tokens: ReadonlyMap<string, string>): AuthenticateRequest {
  return (req) => {
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) {
      const token = header.slice("Bearer ".length).trim();
      const deviceId = tokens.get(token);
      if (deviceId) return deviceId;
    }
    return loopbackAuth(req);
  };
}
