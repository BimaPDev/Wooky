import { resolveConfig, USAGE } from "./config.ts";
import { startServer } from "./server.ts";

async function main() {
  const config = resolveConfig(process.argv.slice(2), process.env);
  if (config === "help") {
    process.stdout.write(`${USAGE}\n`);
    return;
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
