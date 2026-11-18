import { resolveConfig, USAGE } from "./config.ts";
import { hydrateLoginShellPath } from "./process/shell-env.ts";
import { startServer } from "./server.ts";

async function main() {
  const config = resolveConfig(process.argv.slice(2), process.env);
  if (config === "help") {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const pathHydration = await hydrateLoginShellPath();
  if (pathHydration.source === "shell" && pathHydration.added.length > 0) {
    console.error(
      `login-shell PATH: added ${pathHydration.added.length} entr${pathHydration.added.length === 1 ? "y" : "ies"} (${pathHydration.added.slice(0, 3).join(", ")}${pathHydration.added.length > 3 ? ", …" : ""})`,
    );
  }
  const server = await startServer(config);
  process.stdout.write(`AGE_LISTENING ${server.url}\n`);

  const stop = () => {
    server.close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(error);
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
