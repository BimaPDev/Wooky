import { WOOKY_WS_PATH } from "@wooky/contracts";
import { emptyReadModel } from "@wooky/domain";
import { createFixtureBackend } from "../dev/fixture.ts";
import { handleThemesPush, loadDeviceSettings } from "../state/appearance.ts";
import { refreshProviders } from "../state/actions.ts";
import { setBackend } from "../state/backend.ts";
import { receiveTerminal } from "../state/terminal.ts";
import { receiveEvent, receiveSnapshot, useStore } from "../state/store.ts";
import { createRpcClient, type SocketHandlers, type SocketLike } from "./client.ts";

export function startConnection() {
  const params = new URLSearchParams(location.search);
  if (params.has("fixture")) {
    const fixture = createFixtureBackend();
    setBackend(fixture);
    const openUsage = params.get("page") === "usage";
    useStore.setState({
      fixture: true,
      status: "open",
      ...(openUsage ? { settingsOpen: true, settingsPage: "usage" as const } : {}),
    });
    void fixture.call("snapshot", {}).then((model) => {
      receiveSnapshot(params.has("empty") ? emptyReadModel() : model);
      if (openUsage) {
        useStore.setState({ settingsOpen: true, settingsPage: "usage" });
      }
      if (params.get("sidebar") === "closed") {
        useStore.setState({ sidebarOpen: false });
      }
    });
    void refreshProviders();
    void loadDeviceSettings();
    return;
  }
  let firstOpen = true;
  const client = createRpcClient({
    url: `${location.origin.replace(/^http/, "ws")}${WOOKY_WS_PATH}`,
    socketFactory: browserSocket,
    getSeq: () => useStore.getState().model.seq,
    onSnapshot: receiveSnapshot,
    onEvent: receiveEvent,
    onTerminal: receiveTerminal,
    onThemes: (push) => {
      void handleThemesPush(push);
    },
    onStatus: (status) => {
      useStore.setState({ status });
      if (status === "open" && firstOpen) {
        firstOpen = false;
        void refreshProviders();
        void loadDeviceSettings();
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
