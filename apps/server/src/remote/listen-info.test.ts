import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rpcCall } from "../cli/rpc-client.ts";
import { createDemoAdapter } from "../providers/demo/adapter.ts";
import { startServer, type RunningServer } from "../server.ts";
import { createFakeGit } from "../testing.ts";

const servers: RunningServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function boot(portExplicit: boolean): Promise<RunningServer> {
  const home = await mkdtemp(join(tmpdir(), "wooky-listen-"));
  dirs.push(home);
  const server = await startServer({
    home,
    host: "127.0.0.1",
    port: 0,
    portExplicit,
    adapters: [createDemoAdapter({ stepMs: 0 })],
    git: createFakeGit().git,
  });
  servers.push(server);
  return server;
}

describe("remote.listenInfo", () => {
  it("reports the port in use and whether a command-line port fixed it", async () => {
    const fixed = await boot(true);
    expect(await rpcCall(fixed.url, "remote.listenInfo", {})).toEqual({
      port: fixed.port,
      portExplicit: true,
    });
    const free = await boot(false);
    expect(await rpcCall(free.url, "remote.listenInfo", {})).toEqual({
      port: free.port,
      portExplicit: false,
    });
  });
});
