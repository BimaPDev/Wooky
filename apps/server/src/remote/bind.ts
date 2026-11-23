import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { HostingSettings } from "@wooky/contracts";
import { isLoopbackAddress, requireDeviceToken } from "./auth.ts";

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

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1";
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
  // Addresses the last apply() wanted but could not open while others came up.
  let warnings: string[] = [];
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
    warnings = [];
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
        // A listener is put back only if the target would have served it too. A failed narrowing
        // must not leave the wildcard or tailnet listeners it was asked to remove.
        const widest = hosts.includes("0.0.0.0") || hosts.includes("::");
        for (const [host] of previous) {
          if (!widest && !isLoopbackHost(host) && !hosts.includes(host)) await drop(host, true);
        }
        const wantsLoopback = hosts.includes("127.0.0.1") || hosts.includes("0.0.0.0");
        if (wantsLoopback && !listeners.has("127.0.0.1") && !listeners.has("0.0.0.0")) {
          try {
            listeners.set("127.0.0.1", await listen("127.0.0.1", previousPort ?? port));
          } catch (restoreError) {
            console.error(
              "could not restore 127.0.0.1",
              restoreError instanceof Error ? restoreError.message : restoreError,
            );
          }
        }
        throw error;
      }
      for (const [, server] of previous) await closeServer(server);
      listeners.clear();
      for (const [host, server] of opened) listeners.set(host, server);
    } else {
      // Loopback stays served either by its own listener or by 0.0.0.0, so its clients keep their connections.
      const keepLoopback = hosts.includes("127.0.0.1") || hosts.includes("0.0.0.0");
      const dropped = [...listeners.keys()].filter((host) => !hosts.includes(host));
      // On Linux a wildcard bind fails while a loopback listener holds the port, so the old
      // listeners must go first. If nothing new comes up they are put back below.
      for (const host of dropped) await drop(host, keepLoopback);
      let firstError: unknown;
      const opened: string[] = [];
      const tryBind = async (host: string, bindPort: number): Promise<boolean> => {
        try {
          listeners.set(host, await listen(host, bindPort));
          opened.push(host);
          return true;
        } catch (error) {
          firstError ??= error;
          console.error(
            `could not listen on ${host}`,
            error instanceof Error ? error.message : error,
          );
          return false;
        }
      };
      for (const host of hosts) {
        if (!listeners.has(host)) await tryBind(host, assignedPort ?? port);
      }
      const servesLoopback = () => listeners.has("127.0.0.1") || listeners.has("0.0.0.0");
      const wantsLoopback = hosts.includes("127.0.0.1") || hosts.includes("0.0.0.0");
      // 0.0.0.0 failed but :: came up (ipv6Only): IPv4 loopback is not served. 127.0.0.1 coexists
      // with :: and keeps the desktop app and CLI connected.
      // Only when something did come up: if every bind failed this is a plain failure below.
      if (wantsLoopback && !servesLoopback() && hosts.includes("0.0.0.0") && listeners.size > 0) {
        await tryBind("127.0.0.1", assignedPort ?? port);
      }
      // A loopback-only target that lost its port (something grabbed it while hosting was on) comes
      // back on a fresh one rather than leaving no listener; the new port shows in url().
      if (
        wantsLoopback &&
        !servesLoopback() &&
        assignedPort !== null &&
        hosts.every(isLoopbackHost)
      ) {
        await tryBind("127.0.0.1", 0);
      }
      if (listeners.size === 0 || (wantsLoopback && !servesLoopback())) {
        // Not usable from this machine: drop what this round opened and put back only the loopback
        // listeners that were serving. Wildcard or tailnet listeners are never restored here,
        // because the caller asked for them to go and the settings may already say so.
        for (const host of opened) {
          const server = listeners.get(host);
          listeners.delete(host);
          if (server) await closeServer(server);
        }
        for (const host of dropped.filter(isLoopbackHost)) {
          try {
            listeners.set(host, await listen(host, assignedPort ?? port));
          } catch (error) {
            console.error(
              `could not restore ${host}`,
              error instanceof Error ? error.message : error,
            );
          }
        }
        throw firstError ?? new Error("no listener could be started");
      }
      // Something came up, but not everything asked for: say so, since apply() succeeds. With
      // 0.0.0.0 down and :: up, IPv4 LAN clients are not served although hosting looks on.
      warnings = hosts
        .filter((host) => !listeners.has(host))
        .map(
          (host) =>
            `Hosting is only partly on: could not listen on ${host}${
              host === "0.0.0.0" ? ", so IPv4 clients on your network cannot connect" : ""
            }.`,
        );
      for (const warning of warnings) console.error(warning);
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
    /** Why hosting is only partly on after the last apply(); empty when every address came up. */
    warnings: () => [...warnings],
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
