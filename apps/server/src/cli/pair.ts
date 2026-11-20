import type { RemoteConnection } from "@wooky/contracts";
import { discoverServerUrl, SERVER_DOWN } from "../presence.ts";
import { renderQr } from "./qr.ts";
import { rpcCall } from "./rpc-client.ts";

const USAGE = `Usage: wooky pair [--print]
       wooky pair --join <url> <code>

Creates a pairing code on the running server and prints its URL, the code, and a QR
code of <url>/#/pair?code=<code>. --join pairs this server to another one.`;

export interface CliIo {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

const defaultIo = (): CliIo => ({ stdout: process.stdout, stderr: process.stderr });

export async function runPairCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  io: CliIo = defaultIo(),
): Promise<number> {
  try {
    return await run(args, env, io);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(`${message || SERVER_DOWN}\n`);
    return 1;
  }
}

async function run(args: string[], env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const joinAt = args.indexOf("--join");
  if (joinAt >= 0) return join(args, joinAt, env, io);
  if (args.some((arg) => arg !== "--print")) {
    io.stderr.write(`${USAGE}\n`);
    return 1;
  }
  const serverUrl = discoverServerUrl(env);
  const created = await rpcCall(serverUrl, "remote.pairingCode.create", {});
  if (created.url === null) {
    io.stderr.write(`${created.reason ?? "This host is not reachable by other devices."}\n`);
    return 1;
  }
  const link = `${created.url.replace(/\/$/, "")}/#/pair?code=${created.code}`;
  io.stdout.write(`${created.url}\n${created.code}\n`);
  try {
    io.stdout.write(`${renderQr(link)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not draw a QR code.";
    io.stderr.write(`${message}\n${link}\n`);
  }
  return 0;
}

async function join(
  args: string[],
  joinAt: number,
  env: NodeJS.ProcessEnv,
  io: CliIo,
): Promise<number> {
  const url = args[joinAt + 1];
  const code = args[joinAt + 2];
  if (!url || !code || args.length !== joinAt + 3) {
    io.stderr.write(`${USAGE}\n`);
    return 1;
  }
  let connection: RemoteConnection;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("The join URL must be http or https.");
    }
    connection = { kind: "direct", url: parsed.toString().replace(/\/$/, "") };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid URL.";
    io.stderr.write(`${message}\n`);
    return 1;
  }
  const serverUrl = discoverServerUrl(env);
  const joined = await rpcCall(serverUrl, "remote.join", { connection, code });
  io.stdout.write(`Paired with ${joined.host.name}\n${joined.environment.id}\n`);
  return 0;
}
