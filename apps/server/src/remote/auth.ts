import type { IncomingMessage } from "node:http";
import { WebSocket } from "ws";
import { ServiceError } from "../errors.ts";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const TOKEN_PREFIX = "wooky.token.";

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return LOOPBACK.has(address.toLowerCase());
}

export function assertLoopback(address: string | undefined, message: string): void {
  if (!isLoopbackAddress(address)) throw new ServiceError("forbidden", message);
}

function readCookie(header: string, name: string): string | null {
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}

export function tokenFromRequest(req: IncomingMessage): string | null {
  const authorization = req.headers.authorization;
  if (typeof authorization === "string") {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
    if (match?.[1]) return match[1];
  }
  const cookie = req.headers.cookie;
  if (typeof cookie === "string") {
    const value = readCookie(cookie, "wooky_token");
    if (value) return value;
  }
  const header = req.headers["sec-websocket-protocol"];
  const raw = Array.isArray(header) ? header.join(",") : header;
  if (!raw) return null;
  for (const part of raw.split(",")) {
    const protocol = part.trim();
    if (!protocol.startsWith(TOKEN_PREFIX)) continue;
    const token = protocol.slice(TOKEN_PREFIX.length);
    if (token) return token;
  }
  return null;
}

/** Echoes `wooky.token.<token>` when the client offered it. Empty means no subprotocol. */
export function selectWebSocketProtocol(protocols: Set<string>): string | false {
  for (const protocol of protocols) {
    if (protocol.startsWith(TOKEN_PREFIX) && protocol.length > TOKEN_PREFIX.length) return protocol;
  }
  return protocols.values().next().value ?? "";
}

export type AuthenticateRequest = (req: IncomingMessage) => { deviceId: string } | null;

export function createRequestAuth(options: {
  addressOf: (req: IncomingMessage) => string | undefined;
  lookup: (token: string) => string | null;
}): {
  authenticateRequest: AuthenticateRequest;
  track(deviceId: string, socket: WebSocket): void;
  closeDevice(deviceId: string): void;
} {
  const sockets = new Map<string, Set<WebSocket>>();

  const authenticateRequest: AuthenticateRequest = (req) => {
    const address = options.addressOf(req);
    const token = tokenFromRequest(req);
    if (token) {
      const deviceId = options.lookup(token);
      if (deviceId) return { deviceId };
      if (isLoopbackAddress(address)) return { deviceId: "local" };
      return null;
    }
    if (isLoopbackAddress(address)) return { deviceId: "local" };
    return null;
  };

  function track(deviceId: string, socket: WebSocket): void {
    if (deviceId === "local") return;
    let group = sockets.get(deviceId);
    if (!group) {
      group = new Set();
      sockets.set(deviceId, group);
    }
    group.add(socket);
    socket.once("close", () => {
      group?.delete(socket);
      if (group && group.size === 0) sockets.delete(deviceId);
    });
  }

  function closeDevice(deviceId: string): void {
    const group = sockets.get(deviceId);
    sockets.delete(deviceId);
    if (!group) return;
    for (const socket of group) socket.terminate();
  }

  return { authenticateRequest, track, closeDevice };
}
