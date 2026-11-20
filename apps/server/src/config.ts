import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { WOOKY_DEFAULT_PORT } from "@wooky/contracts";

export interface ServerConfig {
  home: string;
  port: number;
  host: string;
  webDist: string | null;
  /** Extra hostnames browsers may connect from (LAN/remote use). Local names are always allowed. */
  allowedHosts: string[];
  /** When set, a non-loopback client may open the folder chooser on this machine. */
  allowRemotePicker: boolean;
  /** `--host` was passed. Hosting settings do not add listeners. */
  hostExplicit: boolean;
  /** `--port` or WOOKY_PORT was set. Hosting settings do not move the listen port. */
  portExplicit: boolean;
}

export const USAGE = `Usage: wooky [options]

  --port <n>        Port to listen on (0 = random). Env WOOKY_PORT. Default ${WOOKY_DEFAULT_PORT}.
  --host <host>     Interface to bind. Default 127.0.0.1.
  --home <dir>      State directory. Env WOOKY_HOME. Default ~/.wooky.
  --web-dist <dir>  Built web UI to serve. Env WOOKY_WEB_DIST.
  --allow-host <h>  Also accept browsers from this hostname (repeatable). Env WOOKY_ALLOWED_HOSTS (comma-separated).
  --allow-remote-picker
                    Let a non-loopback client open the folder chooser. Env WOOKY_ALLOW_REMOTE_PICKER=1.
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
      "allow-host": { type: "string", multiple: true },
      "allow-remote-picker": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) return "help";
  const webDist = values["web-dist"] ?? env.WOOKY_WEB_DIST;
  return {
    home: resolve(values.home ?? env.WOOKY_HOME ?? join(homedir(), ".wooky")),
    port: parsePort(values.port ?? env.WOOKY_PORT),
    host: values.host ?? "127.0.0.1",
    webDist: webDist ? resolve(webDist) : null,
    allowedHosts: [...(values["allow-host"] ?? []), ...(env.WOOKY_ALLOWED_HOSTS ?? "").split(",")]
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
    allowRemotePicker:
      values["allow-remote-picker"] === true || env.WOOKY_ALLOW_REMOTE_PICKER === "1",
    hostExplicit: values.host !== undefined,
    portExplicit:
      values.port !== undefined || (env.WOOKY_PORT !== undefined && env.WOOKY_PORT !== ""),
  };
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === "") return WOOKY_DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new Error(`Invalid port "${raw}". Use a number from 0 to 65535.`);
  return port;
}
