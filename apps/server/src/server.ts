import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { createEffectRunner } from "./effects/runner.ts";
import { createGitService } from "./git/service.ts";
import type { GitService } from "./git/types.ts";
import type { DecideContext } from "./orchestrator/decide.ts";
import { createDispatcher } from "./orchestrator/dispatcher.ts";
import { builtinAdapters } from "./providers/index.ts";
import { createProviderRegistry } from "./providers/registry.ts";
import type { ProviderAdapter } from "./providers/types.ts";
import { createQueries } from "./queries.ts";
import { openEventStore } from "./store/event-store.ts";
import { createHttpHandler } from "./transport/static.ts";
import { attachWebSocket } from "./transport/ws.ts";

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
}

export interface RunningServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const ctx: DecideContext = {
    now: () => new Date().toISOString(),
    newId: (prefix) => `${prefix}_${randomUUID()}`,
  };
  const store = openEventStore(options.home, ctx.now);
  const providers = createProviderRegistry(options.adapters ?? builtinAdapters());
  const git = options.git ?? createGitService();
  const runner = createEffectRunner({ store, providers, git, newId: ctx.newId });
  runner.recover();
  const dispatcher = createDispatcher({ store, runner, ctx });
  const queries = createQueries({ store, git, userHome: options.userHome ?? homedir() });

  const http = createServer(createHttpHandler(options.webDist ?? null));
  const closeSockets = attachWebSocket(
    http,
    { store, dispatcher, providers, queries },
    new Set(options.allowedHosts ?? []),
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
      closing ??= (async () => {
        await runner.shutdown();
        closeSockets();
        await new Promise<void>((resolve) => {
          http.close(() => resolve());
          http.closeAllConnections();
        });
        store.close();
      })();
      return closing;
    },
  };
}
