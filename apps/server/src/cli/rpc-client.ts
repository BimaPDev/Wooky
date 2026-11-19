import {
  AGE_WS_PATH,
  RpcMethods,
  type RpcMethod,
  type RpcParams,
  type RpcResult,
} from "@wooky/contracts";
import { WebSocket } from "ws";

class RpcClientError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "RpcClientError";
    this.code = code;
  }
}

/** `http://host:port` → `ws://host:port/ws`. No Origin header: Node is not a browser. */
function webSocketUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = AGE_WS_PATH;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function rpcCall<M extends RpcMethod>(
  serverUrl: string,
  method: M,
  params: RpcParams<M>,
  timeoutMs = 30_000,
): Promise<RpcResult<M>> {
  const ws = new WebSocket(webSocketUrl(serverUrl));
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settle(new RpcClientError(`${method} timed out.`, "timeout"));
    }, timeoutMs);

    function settle(error?: Error, value?: RpcResult<M>) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      if (error) reject(error);
      else if (value === undefined) reject(new RpcClientError("Empty result."));
      else resolve(value);
    }

    ws.on("error", (error) => {
      settle(new RpcClientError(error.message));
    });
    ws.on("close", () => {
      settle(new RpcClientError("The connection to AGE closed."));
    });
    ws.on("open", () => {
      ws.send(JSON.stringify({ id: 1, method, params }));
    });
    ws.on("message", (data) => {
      let raw: unknown;
      try {
        raw = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!raw || typeof raw !== "object" || !("id" in raw)) return;
      const message = raw as {
        id?: unknown;
        ok?: unknown;
        result?: unknown;
        error?: { message?: unknown; code?: unknown };
      };
      if (message.id !== 1) return;
      if (message.ok !== true) {
        const text =
          typeof message.error?.message === "string" ? message.error.message : "Request failed.";
        const code = typeof message.error?.code === "string" ? message.error.code : undefined;
        settle(new RpcClientError(text, code));
        return;
      }
      const parsed = RpcMethods[method].result.safeParse(message.result);
      if (!parsed.success) {
        settle(new RpcClientError(`Unexpected ${method} result.`));
        return;
      }
      settle(undefined, parsed.data as RpcResult<M>);
    });
  });
}
