import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./components/App.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { PairPage } from "./components/anywhere/pair/PairPage.tsx";
import { pairRoute } from "./components/anywhere/format.ts";
import { applyPhoneDefaults } from "./components/anywhere/phone/phone.tsx";
import { startConnection } from "./rpc/connect.ts";
import { useStore } from "./state/store.ts";
import { loadTerminalOpen } from "./lib/shell.ts";
import { loadTheme } from "./state/theme.ts";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/anywhere.css";
import "./styles/anywhere-history.css";
import "./styles/phone.css";

const pairing = pairRoute(location.hash) !== null;
useStore.setState({ theme: loadTheme(), terminalOpen: loadTerminalOpen() });
applyPhoneDefaults();
if (!pairing) startConnection();

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary>{pairing ? <PairPage /> : <App />}</ErrorBoundary>
    </StrictMode>,
  );
