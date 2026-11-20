import { describe, expect, it } from "vitest";
import { emptyReadModel } from "@wooky/domain";
import type { Thread } from "@wooky/contracts";
import { ServiceError } from "../errors.ts";
import { createAgentTokenService } from "./agent-token.ts";
import { isLoopbackAddress } from "../remote/auth.ts";
import { resolveAgentCaller } from "./agent-auth.ts";

const at = "2026-01-01T00:00:00.000Z";

function thread(id: string, extra: Partial<Thread> = {}): Thread {
  return {
    id,
    projectId: "p1",
    title: id,
    provider: "demo",
    model: "demo",
    runtimeMode: "approve",
    worktree: null,
    providerSessionId: null,
    ownerDeviceId: null,
    movedTo: null,
    movedFrom: null,
    pullRequest: null,
    queue: [],
    status: "idle",
    createdAt: at,
    updatedAt: at,
    ...extra,
  };
}

describe("agent auth", () => {
  it("issues and verifies a token for an existing thread", () => {
    const tokens = createAgentTokenService(Buffer.from("test-secret"));
    const model = emptyReadModel();
    model.threads.coord = thread("coord", { role: "coordinator" });
    const token = tokens.issue("coord");
    expect(tokens.verify(token, model)).toBe("coord");
  });

  it("rejects a bad HMAC", () => {
    const tokens = createAgentTokenService(Buffer.from("test-secret"));
    const model = emptyReadModel();
    model.threads.coord = thread("coord");
    const token = tokens.issue("coord");
    const forged = `${token.slice(0, -1)}x`;
    expect(tokens.verify(forged, model)).toBeNull();
  });

  it("rejects a forged parent on spawn", () => {
    const tokens = createAgentTokenService(Buffer.from("test-secret"));
    const model = emptyReadModel();
    model.threads.coord = thread("coord", { role: "coordinator" });
    model.threads.other = thread("other", { role: "coordinator" });
    const token = tokens.issue("coord");
    expect(() =>
      resolveAgentCaller({
        model,
        remoteAddress: "127.0.0.1",
        agentToken: token,
        parentThreadId: "other",
        tokens,
      }),
    ).toThrow(ServiceError);
  });

  it("rejects spawn from a worker token", () => {
    const tokens = createAgentTokenService(Buffer.from("test-secret"));
    const model = emptyReadModel();
    model.threads.worker = thread("worker", { role: "worker", parentThreadId: "coord" });
    const token = tokens.issue("worker");
    expect(() =>
      resolveAgentCaller({
        model,
        remoteAddress: "127.0.0.1",
        agentToken: token,
        parentThreadId: "worker",
        tokens,
      }),
    ).toThrow(/Workers cannot spawn/);
  });

  it("allows the loopback human path without a token", () => {
    const tokens = createAgentTokenService();
    const model = emptyReadModel();
    model.threads.coord = thread("coord", { role: "coordinator" });
    expect(
      resolveAgentCaller({
        model,
        remoteAddress: "127.0.0.1",
        parentThreadId: "coord",
        tokens,
      }),
    ).toBe("coord");
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
  });
});
