import { WOOKY_WS_PATH, RpcMethods, type Command, type RpcResult } from "@wooky/contracts";
import { WebSocket } from "ws";

class RemoteRpcError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

function wsUrl(baseUrl: string, _token: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = WOOKY_WS_PATH;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function remoteDispatch(
  baseUrl: string,
  token: string,
  command: Command,
  timeoutMs = 60_000,
): Promise<RpcResult<"dispatch">> {
  const ws = new WebSocket(wsUrl(baseUrl, token), `wooky.token.${token}`);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(
      () => settle(new RemoteRpcError("dispatch timed out", "timeout")),
      timeoutMs,
    );

    function settle(error?: Error, value?: RpcResult<"dispatch">) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      if (error) reject(error);
      else if (value) resolve(value);
      else reject(new RemoteRpcError("Empty dispatch result"));
    }

    ws.on("error", (error) => settle(new RemoteRpcError(error.message)));
    ws.on("close", () => settle(new RemoteRpcError("Connection closed")));
    ws.on("open", () => {
      ws.send(JSON.stringify({ id: 1, method: "dispatch", params: command }));
    });
    ws.on("message", (data) => {
      let raw: unknown;
      try {
        raw = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!raw || typeof raw !== "object" || !("id" in raw) || (raw as { id: unknown }).id !== 1)
        return;
      const message = raw as {
        ok?: boolean;
        result?: unknown;
        error?: { message?: string; code?: string };
      };
      if (message.ok !== true) {
        const text =
          typeof message.error?.message === "string" ? message.error.message : "Request failed";
        settle(new RemoteRpcError(text, message.error?.code));
        return;
      }
      const parsed = RpcMethods.dispatch.result.safeParse(message.result);
      if (!parsed.success) settle(new RemoteRpcError("Unexpected dispatch result"));
      else settle(undefined, parsed.data);
    });
  });
}
