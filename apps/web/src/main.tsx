import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./components/App.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { startConnection } from "./rpc/connect.ts";
import { useStore } from "./state/store.ts";
import { loadTerminalOpen } from "./lib/shell.ts";
import { loadTheme } from "./state/theme.ts";
import "./styles/tokens.css";
import "./styles/app.css";

useStore.setState({ theme: loadTheme(), terminalOpen: loadTerminalOpen() });
startConnection();

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
