import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
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
  if (options.hosting.bind === "all") return ["127.0.0.1", "0.0.0.0", "::"];
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

function formatHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
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
    const host = listeners.has("127.0.0.1")
      ? "127.0.0.1"
      : (listeners.keys().next().value ?? options.host);
    return `http://${formatHost(host)}:${port}`;
  }

  function listen(host: string, port: number, trackPort = true): Promise<Server> {
    const server = createServer((req, res) => handler(req, res));
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

  async function drop(host: string): Promise<void> {
    const server = listeners.get(host);
    if (!server) return;
    listeners.delete(host);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
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
        for (const [, server] of opened) {
          server.close();
          server.closeAllConnections();
        }
        assignedPort = previousPort;
        listeners.clear();
        for (const [host, server] of previous) listeners.set(host, server);
        throw error;
      }
      for (const [, server] of previous) {
        server.close();
        server.closeAllConnections();
      }
      listeners.clear();
      for (const [host, server] of opened) listeners.set(host, server);
    } else {
      for (const host of [...listeners.keys()]) {
        if (!hosts.includes(host)) await drop(host);
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
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  async function openServe(): Promise<number> {
    if (serveServer && serveBound !== null) return serveBound;
    const server = createServer((req, res) => {
      requireDeviceToken(req);
      handler(req, res);
    });
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
      const all = [...listeners.values(), ...(serveServer ? [serveServer] : [])];
      listeners.clear();
      serveServer = null;
      serveBound = null;
      await Promise.all(all.map((server) => closeServer(server)));
    },
  };
}
