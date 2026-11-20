import { describe, expect, it } from "vitest";
import { sshTunnelArgs } from "./ssh-tunnel.ts";

describe("ssh tunnel argv", () => {
  it("puts -- before the target and sets the forward options", () => {
    expect(
      sshTunnelArgs({
        localPort: 2000,
        remotePort: 4317,
        target: "me@host",
        identityFile: "/keys/id",
      }),
    ).toEqual([
      "-N",
      "-L",
      "2000:127.0.0.1:4317",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=30",
      "-i",
      "/keys/id",
      "--",
      "me@host",
    ]);
  });

  it("rejects a target or identity file that starts with a dash", () => {
    expect(() =>
      sshTunnelArgs({ localPort: 1, remotePort: 2, target: "-oProxyCommand=x" }),
    ).toThrow(/must not start with -/);
    expect(() =>
      sshTunnelArgs({
        localPort: 1,
        remotePort: 2,
        target: "me@host",
        identityFile: "-oStrictHostKeyChecking=no",
      }),
    ).toThrow(/must not start with -/);
  });
});
