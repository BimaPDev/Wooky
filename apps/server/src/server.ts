import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import {
  FailoverSettings,
  type Command,
  type ProviderCapabilities,
  type ProviderKind,
} from "@wooky/contracts";
import { createEffectRunner } from "./effects/runner.ts";
import { createAgentTokenService } from "./fleet/agent-token.ts";
import { createFleetService } from "./fleet/service.ts";
import { createGhClient, type GhClient } from "./git/gh.ts";
import { createShipService } from "./git/ship.ts";
import { createGitService } from "./git/service.ts";
import type { GitService } from "./git/types.ts";
import type { DecideContext } from "./orchestrator/decide.ts";
import { createDispatcher } from "./orchestrator/dispatcher.ts";
import { builtinAdapters } from "./providers/index.ts";
import { createProviderRegistry } from "./providers/registry.ts";
import type { ProviderAdapter } from "./providers/types.ts";
import type { FolderPicker } from "./process/folder-picker.ts";
import { createQueries } from "./queries.ts";
import { createAttachmentStore } from "./attachments.ts";
import { createScratchService } from "./scratch.ts";
import { createThemeStore } from "./settings/themes.ts";
import { openEventStore } from "./store/event-store.ts";
import { createTerminalManager } from "./terminal/session.ts";
import { publishServerPresence } from "./presence.ts";
import { createSyncService } from "./sync/service.ts";
import { loopbackOnly, testHooksEnabled, testPeerDirectory } from "./sync/stubs.ts";
import { createHttpHandler } from "./transport/static.ts";
import { attachWebSocket } from "./transport/ws.ts";
import { createHistoryService } from "./usage/history.ts";
import { createLimitsService } from "./usage/limits.ts";
import { setAgentTokenIssuer } from "./providers/agent-env.ts";

export interface ServerOptions {
  home: string;
  port: number;
  host: string;
  webDist?: string | null;
  allowedHosts?: readonly string[];
  adapters?: ProviderAdapter[];
  git?: GitService;
  /** Test seam: replace the GitHub CLI integration used by git.pr.* */
  gh?: GhClient;
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
  const themes = createThemeStore(options.home);
  const providerSettings = (kind: ProviderKind) => themes.getSettings().providers[kind];
  const adapters =
    options.adapters ??
    builtinAdapters({
      onClaudeRateLimit: (info) => limits.ingestClaudeRateLimit(info),
      providerSettings,
      deviceSettings: () => themes.getSettings(),
    });
  const registry = createProviderRegistry(adapters, { settings: providerSettings });
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
    invalidate: () => registry.invalidate(),
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
  let syncWriting: (projectId: string) => boolean = () => false;
  const dispatcher = createDispatcher({
    store,
    runner,
    ctx,
    deviceSettings: () => themes.getSettings(),
    projectBusy: (projectId) => syncWriting(projectId),
  });
  /** A prompt whose start was refused during a sync write is started when the write ends. */
  const resumeQueuedPrompts = (projectId: string) => {
    for (const thread of Object.values(store.model.threads)) {
      const head =
        thread.projectId === projectId && thread.status === "idle" ? thread.queue[0] : undefined;
      if (!head) continue;
      try {
        dispatcher.dispatch({
          commandId: `queue:${head.id}`,
          type: "queue.promote",
          threadId: thread.id,
          queueId: head.id,
        });
      } catch (error) {
        console.error(`Could not start queued prompt ${head.id}`, error);
      }
    }
  };
  dispatchCommand = (command) => {
    dispatcher.dispatch(command);
  };
  runner.recover();
  const queries = createQueries({ store, git, userHome: options.userHome ?? homedir() });
  const agentTokens = createAgentTokenService();
  const fleet = createFleetService({ store, dispatcher, git, tokens: agentTokens });
  const ship = createShipService({ store, git, gh: options.gh ?? createGhClient() });
  const stopShipPolling = ship.startPolling();
  const scratch = createScratchService({ home: options.home, store, dispatcher });
  const terminals = createTerminalManager();
  const history = createHistoryService({
    home: options.home,
    userHome: options.userHome ?? homedir(),
    enabled: () => themes.getSettings().importLocalHistory,
  });

  const sync = createSyncService({
    home: options.home,
    store,
    settings: () => themes.getSettings(),
    authenticate: loopbackOnly,
    peers: testPeerDirectory(
      process.env.WOOKY_SYNC_TEST_PEERS,
      testHooksEnabled(process.env, process.argv),
    ),
    resumeQueued: (projectId) => resumeQueuedPrompts(projectId),
  });
  syncWriting = sync.engine.isWriting;
  const serveStatic = createHttpHandler(options.webDist ?? null);
  const http = createServer((req, res) => {
    if (!sync.routes(req, res)) serveStatic(req, res);
  });
  const closeSockets = attachWebSocket(
    http,
    {
      store,
      dispatcher,
      providers,
      queries,
      themes,
      terminals,
      limits,
      history,
      fleet,
      ship,
      scratch,
      sync,
      attachments: createAttachmentStore(options.home),
    },
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
    await sync.close();
    store.close();
    throw error;
  }
  const { port } = http.address() as AddressInfo;
  const host = options.host.includes(":") ? `[${options.host}]` : options.host;
  const url = `http://${host}:${port}`;
  let unpublish: () => void;
  try {
    unpublish = publishServerPresence(options.home, url);
    setAgentTokenIssuer((threadId) => agentTokens.issue(threadId));
  } catch (error) {
    closeSockets();
    http.close();
    void sync.close();
    store.close();
    throw error;
  }

  let closing: Promise<void> | null = null;
  return {
    url,
    port,
    close() {
      // Stop new work first, then drain running turns while open sockets still get their
      // final events, and close the store last.
      closing ??= (async () => {
        unpublish();
        stopShipPolling();
        dispatcher.close();
        const stopped = new Promise<void>((resolve) => http.close(() => resolve()));
        http.closeIdleConnections();
        await runner.shutdown();
        closeSockets();
        http.closeAllConnections();
        await stopped;
        await history.close();
        await sync.close();
        store.close();
      })();
      return closing;
    },
  };
}
