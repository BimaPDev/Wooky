import { AGE_WS_PATH } from "@age/contracts";
import { createFixtureBackend } from "../dev/fixture.ts";
import { refreshProviders } from "../state/actions.ts";
import { setBackend } from "../state/backend.ts";
import { receiveEvent, receiveSnapshot, useStore } from "../state/store.ts";
import { createRpcClient, type SocketHandlers, type SocketLike } from "./client.ts";

export function startConnection() {
  if (new URLSearchParams(location.search).has("fixture")) {
    const fixture = createFixtureBackend();
    setBackend(fixture);
    useStore.setState({ fixture: true, status: "open" });
    void fixture.call("snapshot", {}).then(receiveSnapshot);
    void refreshProviders();
    return;
  }
  let firstOpen = true;
  const client = createRpcClient({
    url: `${location.origin.replace(/^http/, "ws")}${AGE_WS_PATH}`,
    socketFactory: browserSocket,
    getSeq: () => useStore.getState().model.seq,
    onSnapshot: receiveSnapshot,
    onEvent: receiveEvent,
    onStatus: (status) => {
      useStore.setState({ status });
      if (status === "open" && firstOpen) {
        firstOpen = false;
        void refreshProviders();
      }
    },
  });
  setBackend(client);
}

function browserSocket(url: string, handlers: SocketHandlers): SocketLike {
  const ws = new WebSocket(url);
  ws.addEventListener("open", () => handlers.open());
  ws.addEventListener("message", (event) => handlers.message(event.data));
  ws.addEventListener("close", () => handlers.close());
  return ws;
}
