import type { IncomingMessage } from "node:http";
import { WebSocket } from "ws";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const TOKEN_PREFIX = "wooky.token.";
const PROXY_HEADERS = [
  "tailscale-user-login",
  "tailscale-user-name",
  "x-forwarded-for",
  "x-forwarded-host",
  "forwarded",
];
const strictRequests = new WeakSet<IncomingMessage>();

/** The tailscale-serve listener calls this so loopback is not treated as local. */
export function requireDeviceToken(req: IncomingMessage): void {
  strictRequests.add(req);
}

export function deviceTokenRequired(req: IncomingMessage): boolean {
  return strictRequests.has(req);
}

function headerPresent(value: string | string[] | undefined): boolean {
  if (Array.isArray(value)) return value.some((item) => item.trim().length > 0);
  return typeof value === "string" && value.trim().length > 0;
}

/** A reverse proxy, including Tailscale Serve, added one of these. */
export function hasProxyHeaders(req: IncomingMessage): boolean {
  return PROXY_HEADERS.some((name) => headerPresent(req.headers[name]));
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return LOOPBACK.has(address.toLowerCase());
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

type Presented =
  | { source: "bearer" | "subprotocol"; token: string }
  | { source: "cookie"; token: string }
  | { source: "none" };

function subprotocolToken(req: IncomingMessage): string | null {
  const header = req.headers["sec-websocket-protocol"];
  const raw = Array.isArray(header) ? header.join(",") : header;
  if (!raw) return null;
  for (const part of raw.split(",")) {
    const protocol = part.trim();
    if (!protocol.startsWith(TOKEN_PREFIX)) continue;
    return protocol.slice(TOKEN_PREFIX.length);
  }
  return null;
}

/** Bearer and the websocket subprotocol are explicit. A cookie is not, on plain loopback. */
export function presentedToken(req: IncomingMessage): Presented {
  const authorization = req.headers.authorization;
  if (typeof authorization === "string" && /^Bearer\b/i.test(authorization)) {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
    return { source: "bearer", token: match?.[1] ?? "" };
  }
  const protocol = subprotocolToken(req);
  if (protocol !== null) return { source: "subprotocol", token: protocol };
  const cookie = req.headers.cookie;
  if (typeof cookie === "string") {
    const value = readCookie(cookie, "wooky_token");
    if (value) return { source: "cookie", token: value };
  }
  return { source: "none" };
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
    const forced = deviceTokenRequired(req) || hasProxyHeaders(req);
    const loopback = !forced && isLoopbackAddress(options.addressOf(req));
    const presented = presentedToken(req);
    if (presented.source === "bearer" || presented.source === "subprotocol") {
      if (!presented.token) return null;
      const deviceId = options.lookup(presented.token);
      return deviceId ? { deviceId } : null;
    }
    if (presented.source === "cookie") {
      const deviceId = options.lookup(presented.token);
      if (deviceId) return { deviceId };
      if (loopback) return { deviceId: "local" };
      return null;
    }
    if (loopback) return { deviceId: "local" };
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
