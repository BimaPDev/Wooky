import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import {
  AGE_WS_PATH,
  type AgeEvent,
  type RpcError,
  type RpcMethod,
  RpcMethods,
  type RpcParams,
  RpcRequest,
  type RpcResult,
  type ServerMessage,
} from "@age/contracts";
import { WebSocket, WebSocketServer } from "ws";
import { ServiceError } from "../errors.ts";
import type { Dispatcher } from "../orchestrator/dispatcher.ts";
import type { ProviderRegistry } from "../providers/registry.ts";
import type { Queries } from "../queries.ts";
import type { EventStore } from "../store/event-store.ts";

const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

interface Services {
  store: EventStore;
  dispatcher: Dispatcher;
  providers: ProviderRegistry;
  queries: Queries;
}

interface Connection {
  send(message: ServerMessage): void;
  /** Replaces this connection's event subscription. */
  follow(fromSeq: number): number;
}

type Handlers = {
  [M in RpcMethod]: (
    params: RpcParams<M>,
    conn: Connection,
  ) => RpcResult<M> | Promise<RpcResult<M>>;
};

function createHandlers({ store, dispatcher, providers, queries }: Services): Handlers {
  return {
    dispatch: (command) => dispatcher.dispatch(command),
    snapshot: () => store.model,
    subscribe: ({ fromSeq }, conn) => ({ replayed: conn.follow(fromSeq) }),
    "providers.list": () => providers.list(),
    "git.diff": ({ threadId, turnId }) => queries.diff(threadId, turnId),
    "fs.pickable": ({ query }) => queries.pickable(query),
  };
}

/** Attaches the RPC WebSocket at AGE_WS_PATH. Returns a function that closes every socket. */
export function attachWebSocket(
  server: Server,
  services: Services,
  allowedHosts: ReadonlySet<string> = new Set(),
): () => void {
  const handlers = createHandlers(services);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    if (pathname !== AGE_WS_PATH) return refuse(socket, "404 Not Found");
    if (!originAllowed(req.headers.origin, req.headers.host, allowedHosts))
      return refuse(socket, "403 Forbidden");
    wss.handleUpgrade(req, socket, head, (ws) => serve(ws));
  });

  function serve(ws: WebSocket) {
    let unsubscribe: (() => void) | null = null;
    let lastSeq = 0;

    const conn: Connection = {
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
    };

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
    ws.on("close", () => unsubscribe?.());
    ws.on("error", () => ws.terminate());
  }

  return () => {
    for (const client of wss.clients) client.close(1001, "Server is shutting down");
    wss.close();
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
