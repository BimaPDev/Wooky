import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { HostingSettings } from "@wooky/contracts";
import { requireDeviceToken } from "./auth.ts";

export function desiredHosts(options: {
  hosting: HostingSettings;
  hostExplicit: boolean;
  explicitHost: string;
  tailnetIps: readonly string[];
}): string[] {
  if (options.hostExplicit) return [options.explicitHost];
  if (!options.hosting.enabled || options.hosting.bind === "loopback") return ["127.0.0.1"];
  // 0.0.0.0 already answers on loopback. On Linux a wildcard bind also fails with EADDRINUSE
  // while a 127.0.0.1 listener holds the port, so loopback is never listed beside it.
  if (options.hosting.bind === "all") return ["0.0.0.0", "::"];
  return [...new Set(["127.0.0.1", ...options.tailnetIps])];
}

export function desiredPort(options: {
  hosting: HostingSettings;
  portExplicit: boolean;
  explicitPort: number;
  assignedPort: number | null;
}): number {
  if (options.portExplicit) {
    if (options.explicitPort === 0) return options.assignedPort ?? 0;
    return options.explicitPort;
  }
  if (options.hosting.enabled) return options.hosting.port;
  return options.assignedPort ?? options.explicitPort;
}

function isLoopbackAddress(address: string | undefined): boolean {
  return (
    address === "::1" || (address?.startsWith("127.") ?? false) || address === "::ffff:127.0.0.1"
  );
}

function formatHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function trackConnections(server: Server, sockets: WeakMap<Server, Set<Socket>>): void {
  const open = new Set<Socket>();
  sockets.set(server, open);
  server.on("connection", (socket) => {
    open.add(socket);
    socket.once("close", () => open.delete(socket));
  });
}

export function createBindManager(options: {
  host: string;
  port: number;
  hostExplicit: boolean;
  portExplicit: boolean;
  getHosting: () => HostingSettings;
  tailnetIps: () => Promise<string[]>;
}) {
  const listeners = new Map<string, Server>();
  // Loopback listeners that stopped accepting to make room for a wildcard bind. Their
  // established connections live on, so the client that asked for the change gets its reply.
  const retired = new Set<Server>();
  const sockets = new WeakMap<Server, Set<Socket>>();
  let assignedPort: number | null = null;
  let serveServer: Server | null = null;
  let serveBound: number | null = null;
  let handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => {
    res.writeHead(500);
    res.end();
  };
  let onUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void = (_req, socket) => {
    socket.destroy();
  };

  function primaryUrl(): string {
    const port = assignedPort ?? options.port;
    const host =
      listeners.has("127.0.0.1") || listeners.has("0.0.0.0")
        ? "127.0.0.1"
        : (listeners.keys().next().value ?? options.host);
    return `http://${formatHost(host)}:${port}`;
  }

  function listen(host: string, port: number, trackPort = true): Promise<Server> {
    const server = createServer((req, res) => handler(req, res));
    trackConnections(server, sockets);
    server.on("upgrade", (req, socket, head) => onUpgrade(req, socket, head));
    return new Promise((resolve, reject) => {
      const fail = (error: Error) => {
        server.close();
        reject(error);
      };
      server.once("error", fail);
      server.once("listening", () => {
        server.off("error", fail);
        server.on("error", (error) => console.error(`listen ${host} failed`, error));
        const address = server.address() as AddressInfo;
        if (trackPort) assignedPort = address.port;
        console.error(`listening on http://${formatHost(host)}:${address.port}`);
        resolve(server);
      });
      if (host.includes(":")) server.listen({ port, host, ipv6Only: true });
      else server.listen(port, host);
    });
  }

  /** With keepLoopback, local clients stay connected (they are still served) and only the rest are cut. */
  async function drop(host: string, keepLoopback: boolean): Promise<void> {
    const server = listeners.get(host);
    if (!server) return;
    listeners.delete(host);
    if (!keepLoopback) {
      await closeServer(server);
      return;
    }
    for (const socket of sockets.get(server) ?? []) {
      if (!isLoopbackAddress(socket.remoteAddress)) socket.destroy();
    }
    retired.add(server);
    server.close(() => retired.delete(server));
  }

  async function apply(): Promise<{ url: string; port: number }> {
    const hosting = options.getHosting();
    const ips =
      !options.hostExplicit && hosting.enabled && hosting.bind === "tailscale"
        ? await options.tailnetIps()
        : [];
    const hosts = desiredHosts({
      hosting,
      hostExplicit: options.hostExplicit,
      explicitHost: options.host,
      tailnetIps: ips,
    });
    const port = desiredPort({
      hosting,
      portExplicit: options.portExplicit,
      explicitPort: options.port,
      assignedPort,
    });
    const portChanges = assignedPort !== null && port !== 0 && port !== assignedPort;
    if (portChanges) {
      const previous = [...listeners.entries()];
      const previousPort = assignedPort;
      listeners.clear();
      const opened: Array<[string, Server]> = [];
      try {
        for (const host of hosts) opened.push([host, await listen(host, port)]);
      } catch (error) {
        for (const [, server] of opened) await closeServer(server);
        assignedPort = previousPort;
        listeners.clear();
        for (const [host, server] of previous) listeners.set(host, server);
        throw error;
      }
      for (const [, server] of previous) await closeServer(server);
      listeners.clear();
      for (const [host, server] of opened) listeners.set(host, server);
    } else {
      // Loopback stays served either by its own listener or by 0.0.0.0, so its clients keep their connections.
      const keepLoopback = hosts.includes("127.0.0.1") || hosts.includes("0.0.0.0");
      for (const host of [...listeners.keys()]) {
        if (!hosts.includes(host)) await drop(host, keepLoopback);
      }
      for (const host of hosts) {
        if (listeners.has(host)) continue;
        const bindPort = assignedPort ?? port;
        try {
          listeners.set(host, await listen(host, bindPort));
        } catch (error) {
          if (listeners.size === 0) throw error;
          console.error(
            `could not listen on ${host}`,
            error instanceof Error ? error.message : error,
          );
        }
      }
    }
    const bound = assignedPort ?? port;
    return { url: primaryUrl(), port: bound };
  }

  async function closeServer(server: Server): Promise<void> {
    const open = sockets.get(server);
    sockets.delete(server);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
      for (const socket of open ?? []) socket.destroy();
    });
  }

  async function openServe(): Promise<number> {
    if (serveServer && serveBound !== null) return serveBound;
    const server = createServer((req, res) => {
      requireDeviceToken(req);
      handler(req, res);
    });
    trackConnections(server, sockets);
    server.on("upgrade", (req, socket, head) => {
      requireDeviceToken(req);
      onUpgrade(req, socket, head);
    });
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => {
        server.close();
        reject(error);
      };
      server.once("error", fail);
      server.once("listening", () => {
        server.off("error", fail);
        const address = server.address() as AddressInfo;
        serveBound = address.port;
        console.error(`listening on http://127.0.0.1:${address.port} for tailscale serve`);
        resolve();
      });
      server.listen(0, "127.0.0.1");
    });
    serveServer = server;
    return serveBound ?? 0;
  }

  async function closeServe(): Promise<void> {
    const server = serveServer;
    serveServer = null;
    serveBound = null;
    if (server) await closeServer(server);
  }

  return {
    apply,
    openServe,
    closeServe,
    servePort: () => serveBound,
    servers: () => [...listeners.values(), ...(serveServer ? [serveServer] : [])],
    addresses: () => [...listeners.keys()],
    port: () => assignedPort ?? options.port,
    url: primaryUrl,
    setHandler(next: (req: IncomingMessage, res: ServerResponse) => void) {
      handler = next;
    },
    setUpgrade(next: (req: IncomingMessage, socket: Duplex, head: Buffer) => void) {
      onUpgrade = next;
    },
    async closeServers(): Promise<void> {
      const all = [...listeners.values(), ...retired, ...(serveServer ? [serveServer] : [])];
      listeners.clear();
      retired.clear();
      serveServer = null;
      serveBound = null;
      await Promise.all(all.map((server) => closeServer(server)));
    },
  };
}
