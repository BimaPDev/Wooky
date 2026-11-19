import { delimiter } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentEnv,
  coordinatorInstructions,
  currentAgentRuntime,
  fleetChildEnv,
  instructionsForRole,
  prefixSessionPrompt,
  setAgentRuntime,
  workerNote,
} from "./agent-env.ts";

describe("agentEnv", () => {
  afterEach(() => {
    setAgentRuntime(null);
  });

  it("sets the thread, the server, and a PATH prefix for the wooky shim", () => {
    const env = agentEnv({
      threadId: "thread-1",
      serverUrl: "http://127.0.0.1:4317",
      wookyBin: "/tmp/wooky-home/bin/wooky",
      env: { PATH: "/usr/bin" },
    });
    expect(env).toEqual({
      WOOKY_THREAD_ID: "thread-1",
      WOOKY_SERVER_URL: "http://127.0.0.1:4317",
      PATH: `/tmp/wooky-home/bin${delimiter}/usr/bin`,
    });
  });

  it("uses only the shim directory when PATH is empty", () => {
    const env = agentEnv({
      threadId: "thread-1",
      serverUrl: "http://127.0.0.1:9",
      wookyBin: "/tmp/wooky-home/bin/wooky",
      env: {},
    });
    expect(env.PATH).toBe("/tmp/wooky-home/bin");
  });

  it("merges into the child environment only after the server publishes", () => {
    expect(fleetChildEnv("thread-1", { PATH: "/usr/bin" })).toEqual({ PATH: "/usr/bin" });
    setAgentRuntime({ serverUrl: "http://127.0.0.1:9", wookyBin: "/opt/wooky/bin/wooky" });
    expect(fleetChildEnv("thread-1", { PATH: "/usr/bin", HOME: "/users/a" })).toEqual({
      PATH: `/opt/wooky/bin${delimiter}/usr/bin`,
      HOME: "/users/a",
      WOOKY_THREAD_ID: "thread-1",
      WOOKY_SERVER_URL: "http://127.0.0.1:9",
    });
    expect(currentAgentRuntime()?.wookyBin).toBe("/opt/wooky/bin/wooky");
  });
});

describe("fleet instructions", () => {
  it("keeps the coordinator note short and points at wooky agents guide", () => {
    const text = coordinatorInstructions();
    expect(text.split("\n").length).toBeLessThanOrEqual(5);
    expect(text).toContain("wooky agents guide");
    expect(text).toContain("wooky CLI");
    expect(text).toContain("git worktrees");
    expect(text).toContain("cannot spawn");
    expect(text).not.toContain("wooky agents spawn");
    expect(text).not.toContain("wooky agents wait");
  });

  it("selects the worker note only for workers", () => {
    expect(instructionsForRole("worker")).toBe(workerNote());
    expect(workerNote().split("\n")).toHaveLength(1);
    expect(workerNote()).not.toContain("wooky agents spawn");
    expect(instructionsForRole("solo")).toBe(coordinatorInstructions());
    expect(instructionsForRole("coordinator")).toBe(coordinatorInstructions());
    expect(instructionsForRole(undefined)).toBe(coordinatorInstructions());
  });

  it("prefixes the first prompt of a session and leaves a resumed session alone", () => {
    expect(prefixSessionPrompt("do it", { resumeSessionId: null, role: "solo" })).toBe(
      `${coordinatorInstructions()}\n\ndo it`,
    );
    expect(prefixSessionPrompt("do it", { resumeSessionId: null, role: "worker" })).toBe(
      `${workerNote()}\n\ndo it`,
    );
    expect(prefixSessionPrompt("do it", { resumeSessionId: "sess-1", role: "coordinator" })).toBe(
      "do it",
    );
  });
});
