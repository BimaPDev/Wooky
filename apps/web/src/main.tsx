import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./components/App.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { PairPage } from "./components/anywhere/pair/PairPage.tsx";
import { pairRoute } from "./components/anywhere/format.ts";
import { startConnection } from "./rpc/connect.ts";
import { useStore } from "./state/store.ts";
import { loadTerminalOpen } from "./lib/shell.ts";
import { loadTheme } from "./state/theme.ts";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/anywhere.css";

// A browser that is about to pair has no token yet, so it opens no socket.
const pairing = pairRoute(location.hash) !== null;
useStore.setState({ theme: loadTheme(), terminalOpen: loadTerminalOpen() });
if (!pairing) startConnection();

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary>
        {pairing ? <PairPage /> : <App />}
      </ErrorBoundary>
    </StrictMode>,
  );
