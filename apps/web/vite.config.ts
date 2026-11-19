import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const target = `http://127.0.0.1:${process.env.WOOKY_PORT ?? 4317}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/ws": { target, ws: true },
      "/healthz": { target },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
