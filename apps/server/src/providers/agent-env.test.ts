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

  it("sets the thread, the server, and a PATH prefix for the age shim", () => {
    const env = agentEnv({
      threadId: "thread-1",
      serverUrl: "http://127.0.0.1:4317",
      ageBin: "/tmp/age-home/bin/age",
      env: { PATH: "/usr/bin" },
    });
    expect(env).toEqual({
      AGE_THREAD_ID: "thread-1",
      AGE_SERVER_URL: "http://127.0.0.1:4317",
      PATH: `/tmp/age-home/bin${delimiter}/usr/bin`,
    });
  });

  it("uses only the shim directory when PATH is empty", () => {
    const env = agentEnv({
      threadId: "thread-1",
      serverUrl: "http://127.0.0.1:9",
      ageBin: "/tmp/age-home/bin/age",
      env: {},
    });
    expect(env.PATH).toBe("/tmp/age-home/bin");
  });

  it("merges into the child environment only after the server publishes", () => {
    expect(fleetChildEnv("thread-1", { PATH: "/usr/bin" })).toEqual({ PATH: "/usr/bin" });
    setAgentRuntime({ serverUrl: "http://127.0.0.1:9", ageBin: "/opt/age/bin/age" });
    expect(fleetChildEnv("thread-1", { PATH: "/usr/bin", HOME: "/users/a" })).toEqual({
      PATH: `/opt/age/bin${delimiter}/usr/bin`,
      HOME: "/users/a",
      AGE_THREAD_ID: "thread-1",
      AGE_SERVER_URL: "http://127.0.0.1:9",
    });
    expect(currentAgentRuntime()?.ageBin).toBe("/opt/age/bin/age");
  });
});

describe("fleet instructions", () => {
  it("keeps the coordinator note short and points at age agents guide", () => {
    const text = coordinatorInstructions();
    expect(text.split("\n").length).toBeLessThanOrEqual(5);
    expect(text).toContain("age agents guide");
    expect(text).toContain("age CLI");
    expect(text).toContain("git worktrees");
    expect(text).toContain("cannot spawn");
    expect(text).not.toContain("age agents spawn");
    expect(text).not.toContain("age agents wait");
  });

  it("selects the worker note only for workers", () => {
    expect(instructionsForRole("worker")).toBe(workerNote());
    expect(workerNote().split("\n")).toHaveLength(1);
    expect(workerNote()).not.toContain("age agents spawn");
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
