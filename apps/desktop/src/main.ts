import {
  app,
  BrowserWindow,
  Menu,
  session,
  shell,
  type MenuItemConstructorOptions,
} from "electron";
// age-allow child-process: the shell owns exactly one child, the AGE server.
import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  awaitListening,
  buildServerLaunch,
  dataPageUrl,
  decideNavigation,
  errorPage,
  isPermissionAllowed,
  OutputTail,
  ServerStartError,
  startingPage,
  WINDOW_BACKGROUND,
  type ChildEvents,
} from "./logic.ts";

const SERVER_START_TIMEOUT_MS = 20_000;
const SERVER_STOP_TIMEOUT_MS = 5_000;
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const isDev = !app.isPackaged || process.env.AGE_DESKTOP_URL !== undefined;

type Page =
  | { kind: "starting" }
  | { kind: "server"; url: string }
  | { kind: "error"; title: string; detail: string; stderrTail: string };

let page: Page = { kind: "starting" };
let server: ChildProcess | undefined;
let quitting = false;

function currentOrigin(): string {
  return page.kind === "server" ? new URL(page.url).origin : "null";
}

function loadPage(win: BrowserWindow): void {
  const target =
    page.kind === "server"
      ? page.url
      : dataPageUrl(
          page.kind === "error"
            ? errorPage(page.title, page.detail, page.stderrTail)
            : startingPage(),
        );
  win.loadURL(target).catch((error: unknown) => {
    // ERR_ABORTED (-3): a newer loadURL superseded this one; not a failure.
    if ((error as { errno?: number }).errno === -3) return;
    console.error("Failed to load page", error);
  });
}

function setPage(next: Page): void {
  page = next;
  for (const win of BrowserWindow.getAllWindows()) loadPage(win);
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: WINDOW_BACKGROUND,
    show: false,
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 16, y: 16 } }
      : {}),
    webPreferences: {
      preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.once("ready-to-show", () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (decideNavigation(url, currentOrigin()) === "external") void shell.openExternal(url);
    return { action: "deny" };
  });
  // Police every way the page can change: links, server redirects and subframes.
  const police = (event: { preventDefault(): void }, url: string) => {
    const decision = decideNavigation(url, currentOrigin());
    if (decision === "allow") return;
    event.preventDefault();
    if (decision === "external") void shell.openExternal(url);
  };
  win.webContents.on("will-navigate", (event, url) => police(event, url));
  win.webContents.on("will-redirect", (event, url) => police(event, url));
  win.webContents.on("will-frame-navigate", (event) => police(event, event.url));

  loadPage(win);
}

function spawnServer(): ChildProcess {
  const home = process.env.AGE_HOME || join(homedir(), ".age");
  const launch = buildServerLaunch({
    execPath: process.execPath,
    loaderUrl: import.meta.resolve("tsx"),
    serverEntry: join(repoRoot, "apps/server/src/bin.ts"),
    webDist: join(repoRoot, "apps/web/dist"),
    home,
    repoRoot,
    env: process.env,
  });
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (text: string) => process.stdout.write(`[server] ${text}`));
  child.stderr.on("data", (text: string) => process.stderr.write(`[server] ${text}`));
  return child;
}

function childEvents(child: ChildProcess): ChildEvents {
  return {
    onStdout: (listener) => {
      child.stdout?.on("data", (text: string) => listener(text));
    },
    onStderr: (listener) => {
      child.stderr?.on("data", (text: string) => listener(text));
    },
    onExit: (listener) => {
      child.once("exit", (code, signal) => listener({ code, signal }));
      child.once("error", (error) => listener({ code: null, signal: null, reason: error.message }));
    },
  };
}

async function startup(): Promise<void> {
  const devUrl = process.env.AGE_DESKTOP_URL;
  if (devUrl) {
    setPage({ kind: "server", url: devUrl });
    return;
  }

  const child = spawnServer();
  server = child;
  const runtimeTail = new OutputTail();
  child.stderr?.on("data", (text: string) => runtimeTail.add(text));
  child.once("exit", (code, signal) => {
    if (server === child) server = undefined;
    if (quitting || page.kind !== "server") return;
    setPage({
      kind: "error",
      title: "The AGE server stopped",
      detail: `It exited with code ${code ?? "none"}${signal ? ` (signal ${signal})` : ""}.`,
      stderrTail: runtimeTail.text(),
    });
  });

  try {
    const url = await awaitListening(childEvents(child), SERVER_START_TIMEOUT_MS);
    setPage({ kind: "server", url });
  } catch (error) {
    console.error("AGE server failed to start", error);
    // Never leave a half-started server holding the port.
    if (server === child) server = undefined;
    void stopServer(child);
    setPage({
      kind: "error",
      title: "AGE could not start its server",
      detail: error instanceof Error ? error.message : String(error),
      stderrTail: error instanceof ServerStartError ? error.stderrTail : "",
    });
  }
}

function stopServer(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const forceKill = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, SERVER_STOP_TIMEOUT_MS);
    child.once("exit", () => {
      clearTimeout(forceKill);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

function buildMenu(): Menu {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        ...(isDev ? [{ role: "toggleDevTools" as const }] : []),
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  return Menu.buildFromTemplate(template);
}

function focusWindow(): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
}

function main(): void {
  app.on("second-instance", focusWindow);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", (event) => {
    const child = server;
    if (!child || quitting) return;
    quitting = true;
    event.preventDefault();
    void stopServer(child).then(() => app.quit());
  });
  process.on("exit", () => {
    if (server && server.exitCode === null && server.signalCode === null) server.kill("SIGKILL");
  });

  void app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
      callback(isPermissionAllowed(permission));
    });
    session.defaultSession.setPermissionCheckHandler((_webContents, permission) =>
      isPermissionAllowed(permission),
    );
    Menu.setApplicationMenu(buildMenu());
    createWindow();
    return startup();
  });
}

if (app.requestSingleInstanceLock()) {
  main();
} else {
  app.quit();
}
