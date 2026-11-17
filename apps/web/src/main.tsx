import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./components/App.tsx";
import { startConnection } from "./rpc/connect.ts";
import { useStore } from "./state/store.ts";
import { loadTheme } from "./state/theme.ts";
import "./styles/tokens.css";
import "./styles/app.css";

useStore.setState({ theme: loadTheme() });
startConnection();

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
