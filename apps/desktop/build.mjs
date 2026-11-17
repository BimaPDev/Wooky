// Bundles the Electron main process as ESM and the sandboxed preload as CommonJS, which
// sandboxed preloads require. Electron itself stays external.
import { build } from "esbuild";

const shared = {
  bundle: true,
  platform: "node",
  target: "es2023",
  external: ["electron"],
  sourcemap: true,
  logLevel: "warning",
};

await build({ ...shared, entryPoints: ["src/main.ts"], outfile: "dist/main.js", format: "esm" });
await build({
  ...shared,
  entryPoints: ["src/preload.ts"],
  outfile: "dist/preload.cjs",
  format: "cjs",
});
