import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import {
  FailoverSettings,
  type Command,
  type ProviderCapabilities,
  type ProviderKind,
} from "@age/contracts";
import { createEffectRunner } from "./effects/runner.ts";
import { createFleetService } from "./fleet/service.ts";
import { createGitService } from "./git/service.ts";
import type { GitService } from "./git/types.ts";
import type { DecideContext } from "./orchestrator/decide.ts";
import { createDispatcher } from "./orchestrator/dispatcher.ts";
import { builtinAdapters } from "./providers/index.ts";
import { createProviderRegistry } from "./providers/registry.ts";
import type { ProviderAdapter } from "./providers/types.ts";
import type { FolderPicker } from "./process/folder-picker.ts";
import { createQueries } from "./queries.ts";
import { createThemeStore } from "./settings/themes.ts";
import { openEventStore } from "./store/event-store.ts";
import { createTerminalManager } from "./terminal/session.ts";
import { createHttpHandler } from "./transport/static.ts";
import { attachWebSocket } from "./transport/ws.ts";
import { createHistoryService } from "./usage/history.ts";
import { createLimitsService } from "./usage/limits.ts";

export interface ServerOptions {
  home: string;
  port: number;
  host: string;
  webDist?: string | null;
  allowedHosts?: readonly string[];
  adapters?: ProviderAdapter[];
  git?: GitService;
  /** Directory whose children `fs.pickable` suggests. Defaults to the OS home. */
  userHome?: string;
  /** When set, a non-loopback client may open the folder chooser. */
  allowRemotePicker?: boolean;
  /** Test seam. Production builds one from the operating system. */
  folderPicker?: FolderPicker;
}

export interface RunningServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const limits = createLimitsService();
  const adapters =
    options.adapters ??
    builtinAdapters({ onClaudeRateLimit: (info) => limits.ingestClaudeRateLimit(info) });
  const registry = createProviderRegistry(adapters);
  const capabilities = new Map<ProviderKind, ProviderCapabilities>();
  const demo = registry.get("demo");
  if (demo) {
    try {
      const status = await demo.probe();
      if (status.capabilities) capabilities.set(demo.kind, status.capabilities);
    } catch (error) {
      console.error("Could not read the demo provider's capabilities", error);
    }
  }
  const providers = {
    get: (kind: ProviderKind) => registry.get(kind),
    async list() {
      const statuses = await registry.list();
      for (const status of statuses) {
        if (status.capabilities) capabilities.set(status.kind, status.capabilities);
      }
      return statuses;
    },
  };
  const knownProviders = new Set(adapters.map((adapter) => adapter.kind));
  const ctx: DecideContext = {
    now: () => new Date().toISOString(),
    newId: (prefix) => `${prefix}_${randomUUID()}`,
    capabilities: (kind) => capabilities.get(kind),
    hasProvider: (kind) => knownProviders.has(kind),
    failoverSettings: FailoverSettings.parse({}),
  };
  const store = openEventStore(options.home, ctx.now);
  const git = options.git ?? createGitService();
  let dispatchCommand: (command: Command) => void = () => {};
  const themes = createThemeStore(options.home);
  const runner = createEffectRunner({
    store,
    providers,
    git,
    newId: ctx.newId,
    dispatch: (command) => dispatchCommand(command),
    deviceSettings: () => themes.getSettings(),
    limits,
    now: ctx.now,
  });
  const dispatcher = createDispatcher({
    store,
    runner,
    ctx,
    deviceSettings: () => themes.getSettings(),
  });
  dispatchCommand = (command) => {
    dispatcher.dispatch(command);
  };
  runner.recover();
  const queries = createQueries({ store, git, userHome: options.userHome ?? homedir() });
  const fleet = createFleetService({ store, dispatcher, git });
  const terminals = createTerminalManager();
  const history = createHistoryService({
    home: options.home,
    userHome: options.userHome ?? homedir(),
    enabled: () => themes.getSettings().importLocalHistory,
  });

  const http = createServer(createHttpHandler(options.webDist ?? null));
  const closeSockets = attachWebSocket(
    http,
    { store, dispatcher, providers, queries, themes, terminals, limits, history, fleet },
    new Set(options.allowedHosts ?? []),
    {
      allowRemotePicker: options.allowRemotePicker === true,
      ...(options.folderPicker ? { folderPicker: options.folderPicker } : {}),
    },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(options.port, options.host, () => {
        http.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    store.close();
    throw error;
  }
  const { port } = http.address() as AddressInfo;
  const host = options.host.includes(":") ? `[${options.host}]` : options.host;

  let closing: Promise<void> | null = null;
  return {
    url: `http://${host}:${port}`,
    port,
    close() {
      // Stop new work first, then drain running turns while open sockets still get their
      // final events, and close the store last.
      closing ??= (async () => {
        dispatcher.close();
        const stopped = new Promise<void>((resolve) => http.close(() => resolve()));
        http.closeIdleConnections();
        await runner.shutdown();
        closeSockets();
        http.closeAllConnections();
        await stopped;
        await history.close();
        store.close();
      })();
      return closing;
    },
  };
}
