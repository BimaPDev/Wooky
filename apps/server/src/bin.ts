import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgentsCli } from "./cli/agents.ts";
import { runMcpCli } from "./cli/mcp.ts";
import { runPairCli } from "./cli/pair.ts";
import { runSelfCli } from "./cli/self.ts";
import { resolveConfig, USAGE } from "./config.ts";
import { hydrateLoginShellPath } from "./process/shell-env.ts";
import { runThemeCli } from "./settings/theme-cli.ts";
import { startServer } from "./server.ts";
import { findWebDist } from "./web-dist.ts";

function envWithBundledWebDist(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.WOOKY_WEB_DIST) return env;
  const found = findWebDist(dirname(fileURLToPath(import.meta.url)));
  return found ? { ...env, WOOKY_WEB_DIST: found } : env;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "theme") {
    try {
      runThemeCli(argv.slice(1), process.env);
    } catch (error: unknown) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
    return;
  }
  if (argv[0] === "agents") {
    try {
      const code = await runAgentsCli(argv.slice(1), process.env);
      process.exit(code);
    } catch (error: unknown) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  }
  if (argv[0] === "pair") {
    try {
      const code = await runPairCli(argv.slice(1), process.env);
      process.exit(code);
    } catch (error: unknown) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  }
  if (argv[0] === "mcp") {
    try {
      await runMcpCli(argv.slice(1), process.env);
    } catch (error: unknown) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
    return;
  }

  if (argv[0] === "service" || argv[0] === "update" || argv[0] === "uninstall") {
    try {
      const code = await runSelfCli(argv, process.env);
      process.exit(code);
    } catch (error: unknown) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  }

  const config = resolveConfig(argv, envWithBundledWebDist(process.env));
  if (config === "help") {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  let killActiveShell: (() => void) | undefined;
  const listening: { server?: Awaited<ReturnType<typeof startServer>> } = {};

  const stop = () => {
    killActiveShell?.();
    if (listening.server) {
      listening.server.close().then(
        () => process.exit(0),
        (error: unknown) => {
          console.error(error);
          process.exit(1);
        },
      );
    } else {
      process.exit(0);
    }
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const pathHydration = await hydrateLoginShellPath({
    onActiveShell: (kill) => {
      killActiveShell = kill;
    },
  });
  killActiveShell = undefined;

  if (pathHydration.source === "shell" && pathHydration.added.length > 0) {
    console.error(
      `login-shell PATH: added ${pathHydration.added.length} entr${pathHydration.added.length === 1 ? "y" : "ies"} (${pathHydration.added.slice(0, 3).join(", ")}${pathHydration.added.length > 3 ? ", …" : ""})`,
    );
  }
  const server = await startServer(config);
  listening.server = server;
  process.stdout.write(`WOOKY_LISTENING ${server.url}\n`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
