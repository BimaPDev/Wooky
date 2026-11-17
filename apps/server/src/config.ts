import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { AGE_DEFAULT_PORT } from "@age/contracts";

export interface ServerConfig {
  home: string;
  port: number;
  host: string;
  webDist: string | null;
}

export const USAGE = `Usage: age [options]

  --port <n>        Port to listen on (0 = random). Env AGE_PORT. Default ${AGE_DEFAULT_PORT}.
  --host <host>     Interface to bind. Default 127.0.0.1.
  --home <dir>      State directory. Env AGE_HOME. Default ~/.age.
  --web-dist <dir>  Built web UI to serve. Env AGE_WEB_DIST.
  --help            Show this help.`;

/** Flags win over environment variables, which win over defaults. */
export function resolveConfig(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): ServerConfig | "help" {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: false,
    options: {
      port: { type: "string" },
      host: { type: "string" },
      home: { type: "string" },
      "web-dist": { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) return "help";
  const webDist = values["web-dist"] ?? env.AGE_WEB_DIST;
  return {
    home: resolve(values.home ?? env.AGE_HOME ?? join(homedir(), ".age")),
    port: parsePort(values.port ?? env.AGE_PORT),
    host: values.host ?? "127.0.0.1",
    webDist: webDist ? resolve(webDist) : null,
  };
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === "") return AGE_DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new Error(`Invalid port "${raw}". Use a number from 0 to 65535.`);
  return port;
}
