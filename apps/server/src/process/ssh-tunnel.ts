import { spawn, type ChildProcess } from "node:child_process";
import { connect, createServer } from "node:net";
import { ServiceError } from "../errors.ts";

export interface SshTunnelSpec {
  target: string;
  remotePort: number;
  localPort?: number;
  identityFile?: string;
}

export function sshTunnelArgs(spec: {
  localPort: number;
  remotePort: number;
  target: string;
  identityFile?: string;
}): string[] {
  if (spec.target.startsWith("-")) {
    throw new ServiceError("bad_request", "SSH target must not start with -.");
  }
  if (spec.identityFile?.startsWith("-")) {
    throw new ServiceError("bad_request", "SSH identity file must not start with -.");
  }
  const args = [
    "-N",
    "-L",
    `${spec.localPort}:127.0.0.1:${spec.remotePort}`,
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=30",
  ];
  if (spec.identityFile) args.push("-i", spec.identityFile);
  args.push("--", spec.target);
  return args;
}

export function freeTcpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

interface Managed {
  localPort: number;
  stopped: boolean;
  stop(): void;
}

function startTunnel(args: readonly string[], localPort: number, spawnProcess = spawn): Managed {
  let stopped = false;
  let child: ChildProcess | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delay = 500;
  const managed: Managed = {
    localPort,
    get stopped() {
      return stopped;
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    },
  };

  const launch = () => {
    if (stopped) return;
    child = spawnProcess("ssh", [...args], { stdio: "ignore", windowsHide: true });
    let gone = false;
    const restart = () => {
      if (gone || stopped) return;
      gone = true;
      timer = setTimeout(() => {
        delay = Math.min(delay * 2, 30_000);
        launch();
      }, delay);
    };
    child.once("exit", restart);
    child.once("error", restart);
  };
  launch();
  return managed;
}

function waitForPort(port: number, managed: Managed, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (managed.stopped) {
        reject(new ServiceError("unavailable", "SSH tunnel stopped."));
        return;
      }
      const socket = connect({ port, host: "127.0.0.1" });
      const fail = () => {
        socket.destroy();
        if (Date.now() >= deadline) {
          reject(new ServiceError("unavailable", "SSH tunnel did not open."));
          return;
        }
        setTimeout(attempt, 50);
      };
      socket.once("connect", () => {
        socket.end();
        resolve();
      });
      socket.once("error", fail);
    };
    attempt();
  });
}

export function createSshTunnels(spawnProcess: typeof spawn = spawn) {
  const tunnels = new Map<string, Managed>();

  async function ensure(id: string, spec: SshTunnelSpec): Promise<number> {
    const existing = tunnels.get(id);
    if (existing && !existing.stopped) {
      await waitForPort(existing.localPort, existing);
      return existing.localPort;
    }
    const localPort = spec.localPort ?? (await freeTcpPort());
    const args = sshTunnelArgs({
      localPort,
      remotePort: spec.remotePort,
      target: spec.target,
      ...(spec.identityFile ? { identityFile: spec.identityFile } : {}),
    });
    const managed = startTunnel(args, localPort, spawnProcess);
    tunnels.set(id, managed);
    try {
      await waitForPort(localPort, managed);
    } catch (error) {
      managed.stop();
      tunnels.delete(id);
      throw error;
    }
    return localPort;
  }

  function stop(id: string): void {
    const tunnel = tunnels.get(id);
    tunnels.delete(id);
    tunnel?.stop();
  }

  function stopAll(): void {
    for (const id of [...tunnels.keys()]) stop(id);
  }

  return { ensure, stop, stopAll };
}
