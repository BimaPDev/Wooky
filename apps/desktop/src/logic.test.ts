import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitListening,
  buildServerLaunch,
  createSingleFlight,
  ListeningLineParser,
  decideNavigation,
  errorPage,
  isPermissionAllowed,
  parseListeningLine,
  usableWindow,
  type ChildEvents,
  type ChildExit,
} from "./logic.ts";

function unsetPath(path: string): void {
  throw new Error(`Folder dialog was not armed for ${path}.`);
}

type Listener<T> = (value: T) => void;

/** A child process stand-in that the test drives by hand. */
function fakeChild() {
  const stdout: Listener<string>[] = [];
  const stderr: Listener<string>[] = [];
  const exits: Listener<ChildExit>[] = [];
  const events: ChildEvents = {
    onStdout: (listener) => stdout.push(listener),
    onStderr: (listener) => stderr.push(listener),
    onExit: (listener) => exits.push(listener),
  };
  return {
    events,
    writeStdout: (text: string) => stdout.forEach((listener) => listener(text)),
    writeStderr: (text: string) => stderr.forEach((listener) => listener(text)),
    exit: (exit: ChildExit) => exits.forEach((listener) => listener(exit)),
  };
}

describe("listening-line parser", () => {
  it("finds the URL when the line arrives split across chunks", () => {
    const parser = new ListeningLineParser();
    expect(parser.feed("WOOKY_LIS")).toBeUndefined();
    expect(parser.feed("TENING http://127.0.0.1:43")).toBeUndefined();
    expect(parser.feed("17\n")).toBe("http://127.0.0.1:4317");
  });

  it("ignores other lines, including a partial line that looks like the marker", () => {
    const parser = new ListeningLineParser();
    expect(parser.feed("pnpm header\nserver starting WOOKY_LISTENING\n")).toBeUndefined();
    expect(parser.feed("WOOKY_LISTENING http://127.0.0.1:9000\n")).toBe("http://127.0.0.1:9000");
  });

  it("rejects lines whose URL is not http(s)", () => {
    expect(parseListeningLine("WOOKY_LISTENING file:///etc/passwd")).toBeUndefined();
    expect(parseListeningLine("WOOKY_LISTENING not a url")).toBeUndefined();
    expect(parseListeningLine("WOOKY_LISTENING")).toBeUndefined();
    expect(parseListeningLine("  WOOKY_LISTENING https://127.0.0.1:1  ")).toBe(
      "https://127.0.0.1:1",
    );
  });

  it("resolves with the URL from a single stdout chunk", async () => {
    const child = fakeChild();
    const ready = awaitListening(child.events, 20_000);
    child.writeStdout("WOOKY_LISTENING http://127.0.0.1:5555\n");
    await expect(ready).resolves.toBe("http://127.0.0.1:5555");
  });

  it("ignores stdout that arrives after the server is ready", async () => {
    const child = fakeChild();
    const ready = awaitListening(child.events, 20_000);
    child.writeStdout("WOOKY_LISTENING http://127.0.0.1:5555\n");
    child.writeStdout("WOOKY_LISTENING http://127.0.0.1:6666\n");
    await expect(ready).resolves.toBe("http://127.0.0.1:5555");
  });

  describe("deadline", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("rejects when no listening line arrives before the deadline, with the stderr tail", async () => {
      const child = fakeChild();
      const ready = awaitListening(child.events, 20_000);
      child.writeStderr("bind: address in use\n");
      vi.advanceTimersByTime(20_000);
      await expect(ready).rejects.toMatchObject({
        message: expect.stringContaining("did not report readiness within 20 s"),
        stderrTail: "bind: address in use",
      });
    });

    it("does not fire the deadline once the server is ready", async () => {
      const child = fakeChild();
      const ready = awaitListening(child.events, 20_000);
      child.writeStdout("WOOKY_LISTENING http://127.0.0.1:5555\n");
      vi.advanceTimersByTime(60_000);
      await expect(ready).resolves.toBe("http://127.0.0.1:5555");
    });
  });

  it("rejects when the process exits first, carrying the stderr tail", async () => {
    const child = fakeChild();
    const ready = awaitListening(child.events, 20_000);
    child.writeStderr("Error: Cannot find module 'bin.ts'\n");
    child.exit({ code: 1, signal: null });
    await expect(ready).rejects.toMatchObject({
      message: "The server exited before it was ready (code 1, signal null).",
      stderrTail: "Error: Cannot find module 'bin.ts'",
    });
  });

  it("keeps only the recent stderr tail", async () => {
    const child = fakeChild();
    const ready = awaitListening(child.events, 20_000);
    child.writeStderr(`${"x".repeat(5_000)}END`);
    child.exit({ code: 2, signal: "SIGKILL" });
    const error = await ready.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ stderrTail: expect.stringMatching(/END$/) });
    expect((error as { stderrTail: string }).stderrTail.length).toBeLessThanOrEqual(4_000);
  });

  it("rejects with the spawn error when the process could not start", async () => {
    const child = fakeChild();
    const ready = awaitListening(child.events, 20_000);
    child.exit({ code: null, signal: null, reason: "spawn /x/electron ENOENT" });
    await expect(ready).rejects.toMatchObject({
      message: "The server exited before it was ready (spawn /x/electron ENOENT).",
    });
  });
});

describe("server launch argv and env", () => {
  const base = {
    execPath: "/Applications/AGE.app/Contents/MacOS/AGE",
    loaderUrl: "file:///repo/node_modules/tsx/dist/loader.mjs",
    serverEntry: "/repo/apps/server/src/bin.ts",
    webDist: "/repo/apps/web/dist",
    home: "/Users/someone/.wooky",
    repoRoot: "/repo",
  };

  it("runs the Electron binary as Node, loading the tsx loader before the server entry", () => {
    const launch = buildServerLaunch({ ...base, env: { PATH: "/usr/bin" } });
    expect(launch.command).toBe(base.execPath);
    expect(launch.args).toEqual([
      "--import",
      base.loaderUrl,
      base.serverEntry,
      "--port",
      "0",
      "--web-dist",
      base.webDist,
      "--home",
      base.home,
    ]);
    expect(launch.cwd).toBe("/repo");
  });

  it("sets ELECTRON_RUN_AS_NODE and WOOKY_HOME, keeps the caller's env, drops undefined values", () => {
    const parent = { PATH: "/usr/bin", HOME: "/Users/someone", GONE: undefined };
    const launch = buildServerLaunch({ ...base, env: parent });
    expect(launch.env).toEqual({
      PATH: "/usr/bin",
      HOME: "/Users/someone",
      ELECTRON_RUN_AS_NODE: "1",
      WOOKY_HOME: base.home,
    });
    expect(parent).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
  });

  it("overrides an inherited WOOKY_HOME with the home the shell chose", () => {
    const launch = buildServerLaunch({ ...base, env: { WOOKY_HOME: "/elsewhere" } });
    expect(launch.env.WOOKY_HOME).toBe(base.home);
  });
});

describe("navigation policy", () => {
  const appOrigin = "http://127.0.0.1:4317";

  it("allows same-origin navigation inside the app", () => {
    expect(decideNavigation("http://127.0.0.1:4317/threads/abc", appOrigin)).toBe("allow");
  });

  it("opens other http(s) origins in the system browser", () => {
    expect(decideNavigation("https://example.com/docs", appOrigin)).toBe("external");
    expect(decideNavigation("http://127.0.0.1:9999/", appOrigin)).toBe("external");
  });

  it.each([
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "mailto:someone@example.com",
    "not a url",
  ])("blocks %s", (target) => {
    expect(decideNavigation(target, appOrigin)).toBe("block");
  });

  it("does not treat an opaque origin as matching a data page", () => {
    expect(decideNavigation("data:text/html,hi", "null")).toBe("block");
  });
});

describe("permissions", () => {
  it("allows only sanitized clipboard writes", () => {
    expect(isPermissionAllowed("clipboard-sanitized-write")).toBe(true);
    expect(isPermissionAllowed("media")).toBe(false);
    expect(isPermissionAllowed("notifications")).toBe(false);
    expect(isPermissionAllowed("geolocation")).toBe(false);
  });
});

describe("folder dialog", () => {
  it("shares one in-flight promise", async () => {
    const run = createSingleFlight();
    const gateHolder = { resolve: unsetPath };
    const gate = new Promise<string>((resolve) => {
      gateHolder.resolve = resolve;
    });
    let starts = 0;
    const first = run(() => {
      starts += 1;
      return gate;
    });
    const second = run(() => {
      starts += 1;
      return Promise.resolve("other");
    });
    expect(second).toBe(first);
    expect(starts).toBe(1);
    gateHolder.resolve("/tmp/app");
    await expect(first).resolves.toBe("/tmp/app");
    await expect(
      run(() => {
        starts += 1;
        return Promise.resolve("/tmp/next");
      }),
    ).resolves.toBe("/tmp/next");
    expect(starts).toBe(2);
  });

  it("refuses a window that is missing or destroyed", () => {
    expect(usableWindow(null)).toBeNull();
    expect(usableWindow(undefined)).toBeNull();
    const gone = { isDestroyed: () => true };
    expect(usableWindow(gone)).toBeNull();
    const live = { isDestroyed: () => false };
    expect(usableWindow(live)).toBe(live);
  });
});

describe("error page", () => {
  it("escapes server output so it cannot inject markup", () => {
    const html = errorPage("Failed", "bad", "<img src=x onerror=alert(1)>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});
