import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
  WOOKY_WS_PATH,
  type AgeEvent,
  type RpcError,
  type RpcMethod,
  RpcMethods,
  type RpcParams,
  RpcRequest,
  type RpcResult,
  type ServerMessage,
  type ThemesPush,
} from "@wooky/contracts";
import { WebSocket, WebSocketServer } from "ws";
import { ServiceError } from "../errors.ts";
import { presentedToken, selectWebSocketProtocol } from "../remote/auth.ts";
import type { RemoteRuntime } from "../remote/runtime.ts";
import type { AttachmentStore } from "../attachments.ts";
import type { Dispatcher } from "../orchestrator/dispatcher.ts";
import { createFolderPicker, type FolderPicker } from "../process/folder-picker.ts";
import type { ProviderRegistry } from "../providers/registry.ts";
import type { Queries } from "../queries.ts";
import { watchThemeFiles } from "../settings/theme-watch.ts";
import type { ThemeStore } from "../settings/themes.ts";
import type { EventStore } from "../store/event-store.ts";
import { openSignInTerminal } from "../terminal/login.ts";
import type { TerminalManager, TerminalSubscriber } from "../terminal/session.ts";
import type { ScratchService } from "../scratch.ts";
import type { FleetService } from "../fleet/service.ts";
import type { ShipService } from "../git/ship.ts";
import type { HistoryService } from "../usage/history.ts";
import type { LimitsService } from "../usage/limits.ts";

const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

interface Services {
  store: EventStore;
  dispatcher: Dispatcher;
  providers: ProviderRegistry;
  queries: Queries;
  themes: ThemeStore;
  terminals: TerminalManager;
  limits: LimitsService;
  history: HistoryService;
  fleet: FleetService;
  ship: ShipService;
  scratch: ScratchService;
  attachments: AttachmentStore;
  remote: RemoteRuntime;
}

const MAX_AGENT_WAITS_PER_CONNECTION = 8;

interface Connection {
  readonly remoteAddress: string | undefined;
  /**
   * True only for an unpaired client on this machine: loopback, no proxy headers, not the
   * token-only Tailscale Serve listener, and no device token. Paired devices are never local.
   */
  readonly local: boolean;
  readonly abort: AbortController;
  send(message: ServerMessage): void;
  /** Replaces this connection's event subscription. */
  follow(fromSeq: number): number;
  trackTerminal(sessionId: string): void;
  terminalSink: TerminalSubscriber;
  agentWaits: number;
  reserveAgentWait(): void;
  releaseAgentWait(): void;
}

/** Operator-only methods: they change what the host runs, exposes or trusts. */
function requireLocal(conn: Connection, message: string): void {
  if (!conn.local) throw new ServiceError("forbidden", message);
}

/** Settings a paired device may not change: they decide what the host executes or exposes. */
const LOCAL_ONLY_SETTINGS = ["hosting", "providers", "acpAgents", "environments", "sync"] as const;

function agentCaller(conn: Connection) {
  return {
    remoteAddress: conn.local ? conn.remoteAddress : undefined,
    signal: conn.abort.signal,
    reserveWait: conn.reserveAgentWait,
    releaseWait: conn.releaseAgentWait,
  };
}

type Handlers = {
  [M in RpcMethod]: (
    params: RpcParams<M>,
    conn: Connection,
  ) => RpcResult<M> | Promise<RpcResult<M>>;
};

function createHandlers(
  {
    store,
    dispatcher,
    providers,
    queries,
    themes,
    terminals,
    limits,
    history,
    fleet,
    ship,
    scratch,
    attachments,
    remote,
  }: Services,
  notifyThemes: (changedIds: string[]) => void,
  folderPicker: FolderPicker,
): Handlers {
  return {
    dispatch: (command) => dispatcher.dispatch(command),
    snapshot: () => store.model,
    subscribe: ({ fromSeq }, conn) => ({ replayed: conn.follow(fromSeq) }),
    "providers.list": () => providers.list(),
    "providers.signIn": async ({ provider }, conn) => {
      requireLocal(conn, "Provider sign-in can only be started on this machine.");
      try {
        return await openSignInTerminal(provider);
      } catch (error) {
        if (error instanceof ServiceError) throw error;
        throw new ServiceError(
          "unavailable",
          error instanceof Error ? error.message : "Could not open a terminal.",
        );
      }
    },
    "git.diff": ({ threadId, turnId }) => queries.diff(threadId, turnId),
    "fs.pickable": ({ query }, conn) => {
      requireLocal(conn, "The folder list is only available on this machine.");
      return queries.pickable(query);
    },
    "fs.pickFolder": async ({ title }, conn) => {
      requireLocal(conn, "The folder chooser is only available on this machine.");
      try {
        return await folderPicker.pick(conn, { title });
      } catch (error) {
        if (error instanceof ServiceError) throw error;
        console.error("Folder chooser failed", error);
        throw new ServiceError("unavailable", "Could not open the folder chooser.");
      }
    },
    "fs.searchEntries": (params) => queries.searchEntries(params),
    "projects.scratch": () => scratch.ensure(),
    "attachments.put": (params) => attachments.put(params),
    "attachments.remove": ({ id }) => attachments.remove(id),
    "settings.get": () => themes.getSettings(),
    "settings.put": async ({ settings }, conn) => {
      for (const key of LOCAL_ONLY_SETTINGS) {
        if (settings[key] !== undefined) {
          requireLocal(conn, `The ${key} setting can only be changed on this machine.`);
        }
      }
      const before = themes.getSettings();
      const next = themes.putSettings(settings);
      if (settings.providers !== undefined || settings.acpAgents !== undefined) {
        providers.invalidate();
      }
      if (settings.activeThemeId !== undefined) notifyThemes([]);
      await remote.onSettings(before, next, settings);
      return next;
    },
    "themes.list": () => themes.list(),
    "themes.get": ({ id }) => themes.get(id),
    "themes.put": ({ theme }) => {
      const saved = themes.put(theme);
      notifyThemes([saved.id]);
      return saved;
    },
    "themes.delete": ({ id }) => {
      const result = themes.remove(id);
      notifyThemes([id]);
      return result;
    },
    "themes.import": ({ text, filename, activate }) => {
      const imported = themes.importFromText(text, filename, activate);
      notifyThemes([imported.theme.id]);
      return imported;
    },
    "themes.activate": ({ id }) => {
      const settings = themes.activate(id);
      notifyThemes([]);
      return settings;
    },
    "terminal.open": async ({ cwd, cols, rows, projectId, scriptId, size }, conn) => {
      const project = projectId ? store.model.projects[projectId] : undefined;
      const script =
        scriptId && project
          ? project.settings.scripts.find((entry) => entry.id === scriptId)
          : undefined;
      const opened = await terminals.open(
        {
          cwd: cwd ?? project?.root,
          cols: size?.cols ?? cols,
          rows: size?.rows ?? rows,
          projectId: projectId ?? null,
          scriptId: scriptId ?? null,
          title: script?.name,
        },
        conn.terminalSink,
      );
      conn.trackTerminal(opened.sessionId);
      return opened;
    },
    "terminal.write": ({ sessionId, data }) => {
      terminals.write(sessionId, data);
      return { ok: true as const };
    },
    "terminal.resize": ({ sessionId, cols, rows }) => {
      terminals.resize(sessionId, cols, rows);
      return { ok: true as const };
    },
    "terminal.close": ({ sessionId }) => {
      terminals.close(sessionId);
      return { ok: true as const };
    },
    "usage.limits": ({ refresh }) => limits.get({ refresh }),
    "usage.history": (params) => history.get(params),
    "fleet.overview": () => fleet.overview(),
    "git.mergePreview": (params) => fleet.mergePreview(params),
    "agents.spawn": (params, conn) => fleet.spawn(params, agentCaller(conn)),
    "agents.list": (params, conn) => fleet.list(params, agentCaller(conn)),
    "agents.wait": (params, conn) => fleet.wait(params, agentCaller(conn)),
    "agents.result": (params, conn) => fleet.result(params, agentCaller(conn)),
    "device.info": () => remote.device.info(),
    "device.rename": ({ name }) => remote.device.rename(name),
    "remote.tailscaleStatus": () => remote.tailscaleStatus(),
    "remote.pairingCode.create": (_params, conn) => {
      requireLocal(conn, "Pairing codes can only be created on this machine.");
      return remote.pairing.create();
    },
    "remote.devices.list": (_params, conn) => {
      requireLocal(conn, "Paired devices can only be listed on this machine.");
      return remote.pairing.list();
    },
    "remote.devices.revoke": ({ deviceId }, conn) => {
      requireLocal(conn, "Paired devices can only be revoked on this machine.");
      return remote.pairing.revoke(deviceId);
    },
    "remote.devices.rename": ({ deviceId, name }, conn) => {
      requireLocal(conn, "Paired devices can only be renamed on this machine.");
      return remote.pairing.rename(deviceId, name);
    },
    "remote.join": (params, conn) => {
      requireLocal(conn, "Joining a device can only be done on this machine.");
      return remote.peers.join(params);
    },
    "remote.connectInfo": ({ environmentId }, conn) => {
      requireLocal(conn, "Connection details are only available on this machine.");
      return remote.peers.connectInfo(environmentId);
    },
    "sync.status": notImplemented,
    "sync.now": notImplemented,
    "sync.snapshots.list": notImplemented,
    "sync.snapshots.diff": notImplemented,
    "sync.snapshots.restore": notImplemented,
    "sync.snapshots.create": notImplemented,
    "sync.conflicts.resolve": notImplemented,
    "terminal.list": () => terminals.list(),
    "terminal.attach": ({ sessionId }, conn) => {
      const attached = terminals.attach(sessionId, conn.terminalSink);
      conn.trackTerminal(sessionId);
      return attached;
    },
    "scripts.run": notImplemented,
    "git.status": (params) => ship.status(params),
    "git.commit": (params) => ship.commit(params),
    "git.push": (params) => ship.push(params),
    "git.pr.create": (params) => ship.prCreate(params),
    "git.pr.status": (params) => ship.prStatus(params),
  };
}

function notImplemented(): never {
  throw new ServiceError("unavailable", "not implemented");
}

/** Attaches the RPC WebSocket at WOOKY_WS_PATH. `onUpgrade` is shared by every listener. */
export function attachWebSocket(
  services: Services,
  allowedHosts: ReadonlySet<string> = new Set(),
  options: { folderPicker?: FolderPicker } = {},
): { close(): void; onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void } {
  const connections = new Set<Connection>();

  const broadcastThemes = (message: ThemesPush) => {
    for (const conn of connections) conn.send(message);
  };

  const notifyThemes = (changedIds: string[]) => {
    broadcastThemes({
      push: "themes",
      activeThemeId: services.themes.getSettings().activeThemeId,
      changedIds,
    });
  };

  const folderPicker = options.folderPicker ?? createFolderPicker();
  const handlers = createHandlers(services, notifyThemes, folderPicker);
  const closeThemeWatch = watchThemeFiles(services.themes, broadcastThemes);
  // Theme files may carry an inline background image (capped at 6 MB in the contract).
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 8 * 1024 * 1024,
    handleProtocols: (protocols) => selectWebSocketProtocol(protocols),
  });

  function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    if (pathname !== WOOKY_WS_PATH) return refuse(socket, "404 Not Found");
    const remoteAddress = services.remote.addressOf(req);
    const auth = services.remote.authenticateRequest(req);
    if (!auth) {
      refuse(socket, "401 Unauthorized");
      socket.destroy();
      return;
    }
    const cookieAuth = presentedToken(req).source === "cookie";
    const tokenProvesIntent = auth.deviceId !== "local" && !cookieAuth;
    if (!tokenProvesIntent && !originAllowed(req.headers.origin, req.headers.host, allowedHosts)) {
      return refuse(socket, "403 Forbidden");
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      services.remote.track(auth.deviceId, ws);
      serve(ws, remoteAddress, !tokenProvesIntent);
    });
  }

  function serve(ws: WebSocket, remoteAddress: string | undefined, local: boolean) {
    let unsubscribe: (() => void) | null = null;
    let lastSeq = 0;
    const abort = new AbortController();
    let agentWaits = 0;

    const conn: Connection = {
      remoteAddress,
      local,
      abort,
      agentWaits: 0,
      reserveAgentWait() {
        if (agentWaits >= MAX_AGENT_WAITS_PER_CONNECTION) {
          throw new ServiceError(
            "conflict",
            `At most ${MAX_AGENT_WAITS_PER_CONNECTION} agent waits per connection.`,
          );
        }
        agentWaits += 1;
        conn.agentWaits = agentWaits;
      },
      releaseAgentWait() {
        agentWaits = Math.max(0, agentWaits - 1);
        conn.agentWaits = agentWaits;
      },
      send(message) {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify(message));
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) ws.close(1013, "Client is too slow");
      },
      follow(fromSeq) {
        unsubscribe?.();
        lastSeq = fromSeq;
        const push = (events: readonly AgeEvent[]) => {
          for (const event of events) {
            if (event.seq <= lastSeq) continue;
            lastSeq = event.seq;
            conn.send({ push: "event", event });
          }
        };
        const history = services.store.eventsAfter(fromSeq);
        push(history);
        unsubscribe = services.store.subscribe(push);
        return history.length;
      },
      // Disconnect detaches this socket; sessions belong to the server and keep running.
      trackTerminal(_sessionId) {},
      terminalSink: {
        send(message) {
          conn.send(message);
        },
        bufferedAmount() {
          return ws.bufferedAmount;
        },
      },
    };

    connections.add(conn);

    ws.on("message", async (data) => {
      const request = RpcRequest.safeParse(parseJson(String(data)));
      if (!request.success) {
        return conn.send({ id: -1, ok: false, error: badRequest("Malformed request.") });
      }
      const { id, method, params } = request.data;
      try {
        const result = await call(handlers, method, params, conn);
        conn.send({ id, ok: true, result });
      } catch (error) {
        conn.send({ id, ok: false, error: toRpcError(error) });
      }
    });
    ws.on("close", () => {
      connections.delete(conn);
      folderPicker.cancel(conn);
      unsubscribe?.();
      abort.abort();
      services.terminals.detachSubscriber(conn.terminalSink);
    });
    ws.on("error", () => ws.terminate());
  }

  return {
    onUpgrade,
    close() {
      closeThemeWatch();
      folderPicker.close();
      for (const client of wss.clients) client.close(1001, "Server is shutting down");
      wss.close();
      services.terminals.closeAll();
    },
  };
}

function call(handlers: Handlers, method: string, params: unknown, conn: Connection) {
  if (!Object.hasOwn(RpcMethods, method))
    throw new ServiceError("bad_request", `Unknown method ${method}.`);
  const name = method as RpcMethod;
  const parsed = RpcMethods[name].params.safeParse(params ?? {});
  if (!parsed.success) throw new ServiceError("bad_request", parsed.error.message);
  const handler = handlers[name] as (params: unknown, conn: Connection) => unknown;
  return handler(parsed.data, conn);
}

/**
 * Local-first: a browser may connect only when both the page (Origin) and the
 * address it dialled (Host) are local names or explicitly allowed hosts. Checking
 * Host too defeats DNS rebinding (evil.example resolving to 127.0.0.1).
 * Non-browser clients send no Origin and are allowed.
 */
export function originAllowed(
  origin: string | undefined,
  host: string | undefined,
  allowedHosts: ReadonlySet<string> = new Set(),
): boolean {
  if (!origin) return true;
  try {
    const allowed = (hostname: string) =>
      LOCAL_HOSTNAMES.has(hostname) || allowedHosts.has(hostname.toLowerCase());
    if (!allowed(new URL(origin).hostname)) return false;
    return host !== undefined && allowed(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

function refuse(socket: Duplex, status: string) {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function toRpcError(error: unknown): RpcError {
  if (error instanceof ServiceError) return { code: error.code, message: error.message };
  console.error("RPC handler failed", error);
  return { code: "internal", message: "Something went wrong on the server." };
}

function badRequest(message: string): RpcError {
  return { code: "bad_request", message };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
