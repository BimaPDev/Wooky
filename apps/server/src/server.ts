import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
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
import { createDispatcher, type Dispatcher } from "./orchestrator/dispatcher.ts";
import { builtinAdapters } from "./providers/index.ts";
import { createProviderRegistry } from "./providers/registry.ts";
import type { ProviderAdapter } from "./providers/types.ts";
import type { FolderPicker } from "./process/folder-picker.ts";
import { createQueries } from "./queries.ts";
import { createAttachmentStore } from "./attachments.ts";
import { createScratchService } from "./scratch.ts";
import { createThemeStore } from "./settings/themes.ts";
import { openEventStore } from "./store/event-store.ts";
import { setupWorktree, unwatchHeldNotices } from "./scripts/worktree-setup.ts";
import { createTerminalManager } from "./terminal/session.ts";
import { publishServerPresence } from "./presence.ts";
import { createRemoteRuntime, type RemoteRuntime } from "./remote/runtime.ts";
import type { Tailscale } from "./remote/tailscale.ts";
import { createHttpHandler } from "./transport/static.ts";
import { attachWebSocket } from "./transport/ws.ts";
import { createHistoryService } from "./usage/history.ts";
import { createLimitsService } from "./usage/limits.ts";
import { setAgentTokenIssuer } from "./providers/agent-env.ts";
import { createTransferHttpHandler } from "./transfer/http.ts";
import { createTransferService } from "./transfer/service.ts";
import { noopSyncNow } from "./transfer/types.ts";

const SERVE_OFF_TIMEOUT_MS = 3_000;

async function stopServe(remote: RemoteRuntime): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      remote.disableServe(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SERVE_OFF_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    console.error("tailscale serve off failed", error);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
  /** Test seam. Production builds one from the operating system. */
  folderPicker?: FolderPicker;
  /** `--host` was passed. Hosting settings do not add listeners. */
  hostExplicit?: boolean;
  /** `--port` or WOOKY_PORT was set. Hosting settings do not move the listen port. */
  portExplicit?: boolean;
  /** Test seam. Production shells out to the `tailscale` CLI. */
  tailscale?: Tailscale;
  /** Test seam for pairing expiry and the rate-limit window. Milliseconds. */
  now?: () => number;
  /** Test seam. Production uses the socket's remote address. */
  remoteAddress?: (req: IncomingMessage) => string | undefined;
  /** Test seams for Anywhere transfer (A2 syncNow seam until A2 lands on main). */
  transfer?: {
    peers?: import("./remote/peers.ts").PeerDirectory;
    authenticate?: import("./remote/auth.ts").AuthenticateRequest;
    syncNow?: import("./transfer/types.ts").SyncNow;
  };
}

export interface RunningServer {
  url: string;
  port: number;
  addresses(): string[];
  /** Loopback port of the token-only listener behind Tailscale Serve, when open. */
  servePort(): number | null;
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
  const closeStore = () => {
    unwatchHeldNotices();
    store.close();
  };
  const git = options.git ?? createGitService();
  const remote = createRemoteRuntime({
    home: options.home,
    themes,
    host: options.host,
    port: options.port,
    hostExplicit: options.hostExplicit === true,
    portExplicit: options.portExplicit === true,
    ...(options.now ? { now: options.now } : {}),
    ...(options.remoteAddress ? { remoteAddress: options.remoteAddress } : {}),
    ...(options.tailscale ? { tailscale: options.tailscale } : {}),
  });
  const deviceId = remote.device.id();
  const authenticate = options.transfer?.authenticate ?? remote.authenticateRequest;
  const peers = options.transfer?.peers ?? remote.peers;
  const terminals = createTerminalManager();
  let dispatchCommand: (command: Command) => ReturnType<Dispatcher["dispatch"]> = () => {
    throw new Error("dispatcher not ready");
  };
  let broadcastSync = (_message: import("@wooky/contracts").SyncPush) => {};
  const transfer = createTransferService({
    home: options.home,
    store,
    themes,
    deviceId,
    peers,
    authenticate,
    syncNow: options.transfer?.syncNow ?? noopSyncNow,
    dispatch: (command) => dispatchCommand(command),
    newId: ctx.newId,
    now: ctx.now,
    hasProvider: (kind) => knownProviders.has(kind),
    broadcastSync: (message) => broadcastSync(message),
  });
  const runner = createEffectRunner({
    store,
    providers,
    git,
    newId: ctx.newId,
    dispatch: (command) => dispatchCommand(command),
    deviceSettings: () => themes.getSettings(),
    limits,
    now: ctx.now,
    runClaimThread: (effect) => transfer.runClaimThread(effect),
    recoverClaims: () => transfer.recoverClaims(),
    onWorktreeCreated: (input) =>
      setupWorktree({
        ...input,
        store,
        terminals,
        newId: ctx.newId,
      }),
  });
  const dispatcher = createDispatcher({
    store,
    runner,
    ctx,
    deviceSettings: () => themes.getSettings(),
  });
  dispatchCommand = (command) => dispatcher.dispatch(command);
  runner.recover();
  transfer.replicas.start();
  const queries = createQueries({ store, git, userHome: options.userHome ?? homedir() });
  const agentTokens = createAgentTokenService();
  const fleet = createFleetService({ store, dispatcher, git, tokens: agentTokens });
  const ship = createShipService({ store, git, gh: options.gh ?? createGhClient() });
  const stopShipPolling = ship.startPolling();
  const scratch = createScratchService({ home: options.home, store, dispatcher });
  const history = createHistoryService({
    home: options.home,
    userHome: options.userHome ?? homedir(),
    enabled: () => themes.getSettings().importLocalHistory,
  });

  const staticHandler = createHttpHandler(options.webDist ?? null);
  const transferHttp = createTransferHttpHandler({
    authenticate,
    replicas: transfer.replicas,
    themes,
    deviceId,
    settings: () => themes.getSettings(),
    now: ctx.now,
  });
  const sockets = attachWebSocket(
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
      attachments: createAttachmentStore(options.home),
      transfer,
      remote,
    },
    new Set(options.allowedHosts ?? []),
    {
      ...(options.folderPicker ? { folderPicker: options.folderPicker } : {}),
      onSyncBroadcast: (send) => {
        broadcastSync = send;
      },
    },
  );
  let unpublish: () => void = () => {};
  try {
    await remote.listen({
      handler: (req, res) => {
        if (transferHttp(req, res)) return;
        staticHandler(req, res);
      },
      onUpgrade: sockets.onUpgrade,
    });
    unpublish = publishServerPresence(options.home, remote.url());
    setAgentTokenIssuer((threadId) => agentTokens.issue(threadId));
  } catch (error) {
    stopShipPolling();
    transfer.replicas.stop();
    sockets.close();
    remote.closeTunnels();
    await remote.closeServers();
    closeStore();
    throw error;
  }

  let closing: Promise<void> | null = null;
  return {
    get url() {
      return remote.url();
    },
    get port() {
      return remote.port();
    },
    addresses: () => remote.addresses(),
    servePort: () => remote.servePort(),
    close() {
      // Stop new work first, then drain running turns while open sockets still get their
      // final events, and close the store last.
      closing ??= (async () => {
        if (remote.servePort() !== null) await stopServe(remote);
        unpublish();
        stopShipPolling();
        dispatcher.close();
        const httpServers = remote.servers();
        const stopped = Promise.all(
          httpServers.map((http) => new Promise<void>((resolve) => http.close(() => resolve()))),
        );
        for (const http of httpServers) http.closeIdleConnections();
        await runner.shutdown();
        sockets.close();
        remote.closeTunnels();
        for (const http of httpServers) http.closeAllConnections();
        await stopped;
        await history.close();
        transfer.replicas.stop();
        closeStore();
      })();
      return closing;
    },
  };
}
