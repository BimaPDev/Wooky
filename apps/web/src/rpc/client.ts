import {
  RpcMethods,
  ServerMessage,
  type AgeEvent,
  type ReadModel,
  type RpcError,
  type RpcMethod,
  type RpcParams,
  type RpcResult,
  type TerminalPush,
  type ThemesPush,
} from "@age/contracts";

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "offline";

/** The subset of the browser WebSocket the client uses, so tests can pass a fake. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
}

export interface SocketHandlers {
  open(): void;
  message(data: unknown): void;
  close(): void;
}

export type SocketFactory = (url: string, handlers: SocketHandlers) => SocketLike;

export type CallErrorCode = RpcError["code"] | "timeout" | "disconnected";

export class RpcCallError extends Error {
  constructor(
    readonly code: CallErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RpcCallError";
  }
}

export interface RpcClientOptions {
  url: string;
  socketFactory: SocketFactory;
  /** Seq of the last event the caller applied; used to resubscribe after a reconnect. */
  getSeq: () => number;
  onSnapshot: (model: ReadModel) => void;
  onEvent: (event: AgeEvent) => void;
  onTerminal?: (message: TerminalPush) => void;
  onThemes?: (message: ThemesPush) => void;
  onStatus?: (status: ConnectionStatus) => void;
  requestTimeoutMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Consecutive failed attempts before the status reads "offline" (it keeps retrying). */
  offlineAfter?: number;
  random?: () => number;
}

interface Pending {
  method: RpcMethod;
  resolve: (value: unknown) => void;
  reject: (error: RpcCallError) => void;
  timer: ReturnType<typeof setTimeout>;
  frame: string;
  sent: boolean;
}

const OPEN = 1;

export function backoffDelay(attempt: number, baseMs: number, maxMs: number, random: number) {
  const capped = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(capped / 2 + (capped / 2) * random);
}

export function createRpcClient(options: RpcClientOptions) {
  const timeoutMs = options.requestTimeoutMs ?? 15_000;
  const baseMs = options.backoffBaseMs ?? 250;
  const maxMs = options.backoffMaxMs ?? 10_000;
  const offlineAfter = options.offlineAfter ?? 4;
  const random = options.random ?? Math.random;

  let socket: SocketLike | null = null;
  let nextId = 1;
  let attempt = 0;
  let hasSnapshot = false;
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let status: ConnectionStatus = "connecting";
  const pending = new Map<number, Pending>();

  const setStatus = (next: ConnectionStatus) => {
    if (next === status) return;
    status = next;
    options.onStatus?.(next);
  };

  function connect() {
    retryTimer = null;
    if (stopped) return;
    const ws: SocketLike = options.socketFactory(options.url, {
      open: () => onOpen(ws),
      message: (data) => {
        if (socket === ws) receive(data);
      },
      close: () => onClose(ws),
    });
    socket = ws;
  }

  function onOpen(ws: SocketLike) {
    if (socket !== ws) return;
    attempt = 0;
    setStatus("open");
    for (const entry of pending.values()) {
      if (entry.sent) continue;
      entry.sent = true;
      ws.send(entry.frame);
    }
    void sync();
  }

  function onClose(ws: SocketLike) {
    if (socket !== ws) return;
    socket = null;
    for (const [id, entry] of pending) {
      // Calls not yet sent stay queued; the ones in flight are lost with the socket.
      if (!entry.sent) continue;
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.reject(new RpcCallError("disconnected", "The connection to Wooky closed."));
    }
    if (stopped) return;
    setStatus(attempt >= offlineAfter ? "offline" : "reconnecting");
    retryTimer = setTimeout(connect, backoffDelay(attempt, baseMs, maxMs, random()));
    attempt += 1;
  }

  async function sync() {
    try {
      if (!hasSnapshot) {
        const model = await call("snapshot", {});
        options.onSnapshot(model);
        hasSnapshot = true;
      }
      await call("subscribe", { fromSeq: options.getSeq() });
    } catch (error) {
      if (error instanceof RpcCallError && error.code === "disconnected") return;
      console.error("AGE sync failed", error);
    }
  }

  function receive(data: unknown) {
    let raw: unknown;
    try {
      raw = typeof data === "string" ? JSON.parse(data) : data;
    } catch {
      console.error("AGE: unreadable server message");
      return;
    }
    const parsed = ServerMessage.safeParse(raw);
    if (!parsed.success) {
      console.error("AGE: unexpected server message", parsed.error.message);
      return;
    }
    const message = parsed.data;
    if ("push" in message) {
      if (message.push === "terminal") options.onTerminal?.(message);
      else if (message.push === "event") options.onEvent(message.event);
      else if (message.push === "themes") options.onThemes?.(message);
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (!message.ok) {
      entry.reject(new RpcCallError(message.error.code, message.error.message));
      return;
    }
    const result = RpcMethods[entry.method].result.safeParse(message.result);
    if (result.success) entry.resolve(result.data);
    else entry.reject(new RpcCallError("internal", `Unexpected ${entry.method} result.`));
  }

  function call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
    const id = nextId++;
    const frame = JSON.stringify({ id, method, params });
    return new Promise<RpcResult<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new RpcCallError("timeout", `${method} timed out.`));
      }, timeoutMs);
      const sent = socket !== null && socket.readyState === OPEN;
      pending.set(id, {
        method,
        resolve: (value) => resolve(value as RpcResult<M>),
        reject,
        timer,
        frame,
        sent,
      });
      if (sent) socket?.send(frame);
    });
  }

  function close() {
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    const ws = socket;
    socket = null;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new RpcCallError("disconnected", "The client was closed."));
    }
    pending.clear();
    ws?.close();
  }

  connect();
  return { call, close, status: () => status };
}
