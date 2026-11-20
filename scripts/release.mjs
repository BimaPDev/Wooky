#!/usr/bin/env node
// Builds a self-contained Wooky release bundle and its installer assets into dist-release/.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pnpmCommand } from "./pnpm-spawn.mjs";

const NATIVE_PACKAGE_CANDIDATES = ["node-pty"];

function discoverNativeExternals(serverPkg) {
  return NATIVE_PACKAGE_CANDIDATES.filter(
    (name) => serverPkg.dependencies?.[name] ?? serverPkg.optionalDependencies?.[name],
  );
}
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]*$/;

const root = fileURLToPath(new URL("..", import.meta.url));

function parseArgs(argv) {
  let version = null;
  let outDir = join(root, "dist-release");
  let skipWebBuild = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    } else if (arg === "--version") {
      version = argv[i + 1] ?? null;
      if (!version) throw new Error("Missing value for --version");
      i += 1;
    } else if (arg.startsWith("--version=")) {
      version = arg.slice("--version=".length);
    } else if (arg === "--out") {
      const next = argv[i + 1];
      if (!next) throw new Error("Missing value for --out");
      outDir = resolve(next);
      i += 1;
    } else if (arg.startsWith("--out=")) {
      outDir = resolve(arg.slice("--out=".length));
    } else if (arg === "--skip-web-build") {
      skipWebBuild = true;
    } else if (arg === "--help" || arg === "-h") {
      console.info(
        "Usage: node scripts/release.mjs [--version <ver>] [--out <dir>] [--skip-web-build]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return { version, outDir, skipWebBuild };
}

function resolveVersion(explicit) {
  const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const serverPkg = JSON.parse(readFileSync(join(root, "apps", "server", "package.json"), "utf8"));
  const raw = explicit ?? rootPkg.version ?? serverPkg.version ?? "0.0.0-dev";
  const normalized = /^v\d/.test(raw) ? raw.slice(1) : raw;
  if (!VERSION_PATTERN.test(normalized)) {
    throw new Error(`Invalid release version "${raw}".`);
  }
  return normalized;
}

function loadEsbuild() {
  const desktopRequire = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
  return desktopRequire("esbuild");
}

function buildWeb() {
  const { file, args } = pnpmCommand(["--filter", "@wooky/web", "build"], process.env);
  const res = spawnSync(file, args, { cwd: root, stdio: "inherit", env: process.env });
  if (res.status !== 0) {
    throw new Error(`Web build failed with exit code ${res.status ?? 1}.`);
  }
}

function renderPosixLauncher() {
  return `#!/bin/sh
set -eu
SELF="$0"
while [ -L "$SELF" ]; do
  DIR="$(CDPATH= cd -- "$(dirname -- "$SELF")" && pwd)"
  LINK="$(readlink "$SELF")"
  case "$LINK" in
    /*) SELF="$LINK" ;;
    *) SELF="$DIR/$LINK" ;;
  esac
done
BUNDLE_DIR="$(CDPATH= cd -- "$(dirname -- "$SELF")/.." && pwd)"
if [ -z "\${WOOKY_WEB_DIST:-}" ] && [ -f "$BUNDLE_DIR/web/index.html" ]; then
  export WOOKY_WEB_DIST="$BUNDLE_DIR/web"
fi
NODE_BIN="\${WOOKY_NODE:-}"
if [ -z "$NODE_BIN" ]; then
  RUNTIME_NODE="\${WOOKY_HOME:-\${HOME:-}/.wooky}/runtime/node/bin/node"
  if [ -x "$RUNTIME_NODE" ]; then
    NODE_BIN="$RUNTIME_NODE"
  else
    NODE_BIN="node"
  fi
fi
exec "$NODE_BIN" "$BUNDLE_DIR/server/wooky.mjs" "$@"
`;
}

function renderWindowsLauncher() {
  return [
    "@echo off",
    "setlocal",
    'set "BUNDLE_DIR=%~dp0.."',
    "if not defined WOOKY_WEB_DIST (",
    '  if exist "%BUNDLE_DIR%\\web\\index.html" set "WOOKY_WEB_DIST=%BUNDLE_DIR%\\web"',
    ")",
    'set "NODE_BIN=%WOOKY_NODE%"',
    "if not defined NODE_BIN (",
    '  if exist "%LOCALAPPDATA%\\Wooky\\runtime\\node\\node.exe" (',
    '    set "NODE_BIN=%LOCALAPPDATA%\\Wooky\\runtime\\node\\node.exe"',
    "  ) else (",
    '    set "NODE_BIN=node"',
    "  )",
    ")",
    '"%NODE_BIN%" "%BUNDLE_DIR%\\server\\wooky.mjs" %*',
    "exit /b %ERRORLEVEL%",
    "",
  ].join("\r\n");
}

function sha256File(filePath) {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
}

async function main() {
  const { version: explicitVersion, outDir, skipWebBuild } = parseArgs(process.argv.slice(2));
  const version = resolveVersion(explicitVersion);
  const webDist = join(root, "apps", "web", "dist");

  if (!skipWebBuild || !existsSync(join(webDist, "index.html"))) {
    console.info("Building @wooky/web...");
    buildWeb();
  }
  if (!existsSync(join(webDist, "index.html"))) {
    throw new Error(`Missing built web UI at ${webDist}.`);
  }

  const esbuild = loadEsbuild();
  const stageDir = mkdtempSync(join(tmpdir(), "wooky-release-stage-"));

  try {
    const serverPkg = JSON.parse(
      readFileSync(join(root, "apps", "server", "package.json"), "utf8"),
    );
    const nativeExternals = discoverNativeExternals(serverPkg);

    const serverOutDir = join(stageDir, "server");
    const binOutDir = join(stageDir, "bin");
    const webOutDir = join(stageDir, "web");
    mkdirSync(serverOutDir, { recursive: true });
    mkdirSync(binOutDir, { recursive: true });

    const esbuildShared = {
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      external: ["node:*", ...nativeExternals],
      banner: {
        js: 'import { createRequire as __wookyCreateRequire } from "node:module"; const require = __wookyCreateRequire(import.meta.url);',
      },
      logLevel: "warning",
    };

    console.info("Bundling @wooky/server with esbuild...");
    await esbuild.build({
      ...esbuildShared,
      entryPoints: [join(root, "apps", "server", "src", "bin.ts")],
      outfile: join(serverOutDir, "wooky.mjs"),
    });

    // Keep the usage history worker runnable next to server/wooky.mjs with no repo checkout.
    await esbuild.build({
      ...esbuildShared,
      entryPoints: [join(root, "apps", "server", "src", "usage", "history-worker.ts")],
      outfile: join(serverOutDir, "history-worker.ts"),
    });

    cpSync(webDist, webOutDir, { recursive: true });

    const nativeDeps = {};
    for (const pkgName of nativeExternals) {
      const range = serverPkg.dependencies?.[pkgName] ?? serverPkg.optionalDependencies?.[pkgName];
      if (range) nativeDeps[pkgName] = range;
    }

    const bundlePkg = {
      name: "wooky",
      version,
      private: true,
      type: "module",
      engines: { node: ">=24" },
      bin: { wooky: "./bin/wooky" },
      dependencies: nativeDeps,
    };
    writeFileSync(
      join(stageDir, "package.json"),
      `${JSON.stringify(bundlePkg, null, 2)}\n`,
      "utf8",
    );

    const posixLauncher = join(binOutDir, "wooky");
    writeFileSync(posixLauncher, renderPosixLauncher(), "utf8");
    chmodSync(posixLauncher, 0o755);
    writeFileSync(join(binOutDir, "wooky.cmd"), renderWindowsLauncher(), "utf8");

    mkdirSync(outDir, { recursive: true });
    const tarballName = `wooky-${version}.tgz`;
    const tarballPath = join(outDir, tarballName);
    rmSync(tarballPath, { force: true });

    const tarRes = spawnSync("tar", ["-czf", tarballPath, "-C", stageDir, "."], {
      stdio: "inherit",
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    if (tarRes.status !== 0) {
      throw new Error(`tar failed with exit code ${tarRes.status ?? 1}.`);
    }

    const installerFiles = ["install.sh", "install.ps1", "proxmox.sh"];
    for (const file of installerFiles) {
      const src = join(root, "install", file);
      const dest = join(outDir, file);
      copyFileSync(src, dest);
      if (file.endsWith(".sh")) chmodSync(dest, 0o755);
    }

    const assetsToHash = [tarballName, ...installerFiles];
    const sumsLines = assetsToHash.map((name) => `${sha256File(join(outDir, name))}  ${name}`);
    writeFileSync(join(outDir, "SHA256SUMS"), `${sumsLines.join("\n")}\n`, "utf8");

    console.info(`\nRelease assets ready in ${outDir}:`);
    for (const name of [...assetsToHash, "SHA256SUMS"]) {
      console.info(`  ${name}`);
    }
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
