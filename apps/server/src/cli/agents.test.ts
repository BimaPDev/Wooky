import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import type { CliIo } from "./agents.ts";
import { runAgentsCli } from "./agents.ts";
import { tempDir } from "../testing.ts";

function capture(): { io: CliIo; stdout: () => string; stderr: () => string } {
  let out = "";
  let err = "";
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      out += String(chunk);
      callback();
    },
  });
  const stderr = new Writable({
    write(chunk, _encoding, callback) {
      err += String(chunk);
      callback();
    },
  });
  return {
    io: { stdin: Readable.from([]), stdout, stderr },
    stdout: () => out,
    stderr: () => err,
  };
}

interface Seen {
  method?: string;
  params?: unknown;
  path?: string;
  origin?: string;
}

async function withServer(
  handler: (method: string, params: unknown) => unknown,
  run: (url: string, seen: Seen) => Promise<void>,
) {
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  const seen: Seen = {};
  wss.on("connection", (socket, request) => {
    seen.path = request.url;
    seen.origin = request.headers.origin;
    socket.on("message", (data) => {
      const requestBody = JSON.parse(String(data)) as {
        id: number;
        method: string;
        params: unknown;
      };
      seen.method = requestBody.method;
      seen.params = requestBody.params;
      socket.send(JSON.stringify({ push: "themes", activeThemeId: "default", changedIds: [] }));
      try {
        const result = handler(requestBody.method, requestBody.params);
        socket.send(JSON.stringify({ id: requestBody.id, ok: true, result }));
      } catch (error) {
        socket.send(
          JSON.stringify({
            id: requestBody.id,
            ok: false,
            error: {
              code: "bad_request",
              message: error instanceof Error ? error.message : "failed",
            },
          }),
        );
      }
    });
  });
  await new Promise<void>((resolve) => {
    http.listen(0, "127.0.0.1", () => resolve());
  });
  const address = http.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`, seen);
  } finally {
    for (const client of wss.clients) client.close();
    wss.close();
    await new Promise<void>((resolve, reject) => {
      http.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

const row = {
  threadId: "worker-1",
  projectId: "project-1",
  title: "Fix the parser",
  provider: "demo",
  model: "demo",
  role: "worker",
  parentThreadId: "parent-1",
  status: "working",
  lastActivityAt: "2026-01-01T00:00:00.000Z",
};

describe("age agents", () => {
  it("requires AGE_THREAD_ID for spawn and list", async () => {
    const captured = capture();
    const code = await runAgentsCli(
      ["list"],
      { AGE_SERVER_URL: "http://127.0.0.1:1" },
      captured.io,
    );
    expect(code).toBe(1);
    expect(captured.stderr()).toContain("AGE_THREAD_ID is not set");
  });

  it("errors when no server is published and the pid in server.json is stale", async () => {
    const home = await tempDir("age-home");
    await writeFile(
      join(home, "server.json"),
      JSON.stringify({ url: "http://127.0.0.1:9", pid: 2_147_483_646, startedAt: "t" }),
    );
    const captured = capture();
    const code = await runAgentsCli(
      ["list"],
      { AGE_HOME: home, AGE_THREAD_ID: "parent-1" },
      captured.io,
    );
    expect(code).toBe(1);
    expect(captured.stderr().trim()).toBe("AGE server is not running");
  });

  it("spawns from argv, a file, or stdin and prints the thread id", async () => {
    await withServer(
      () => ({ threadId: "worker-9" }),
      async (url, seen) => {
        const captured = capture();
        const code = await runAgentsCli(
          [
            "spawn",
            "--provider",
            "demo",
            "--model",
            "demo",
            "--title",
            "Fix it",
            "--runtime-mode",
            "full",
            "--",
            "fix",
            "the",
            "bug",
          ],
          { AGE_THREAD_ID: "parent-1", AGE_SERVER_URL: url },
          captured.io,
        );
        expect(code).toBe(0);
        expect(captured.stdout()).toBe("worker-9\n");
        expect(seen.method).toBe("agents.spawn");
        expect(seen.path).toBe("/ws");
        expect(seen.origin).toBeUndefined();
        expect(seen.params).toEqual({
          parentThreadId: "parent-1",
          provider: "demo",
          model: "demo",
          title: "Fix it",
          runtimeMode: "full",
          prompt: "fix the bug",
        });
      },
    );

    const home = await tempDir("prompt");
    const file = join(home, "prompt.txt");
    await writeFile(file, "from a file\n");
    await withServer(
      (_method, params) => {
        expect(params).toMatchObject({ prompt: "from a file" });
        return { threadId: "worker-file" };
      },
      async (url) => {
        const captured = capture();
        const code = await runAgentsCli(
          ["spawn", "--provider", "claude", "--model", "haiku", "--prompt-file", file],
          { AGE_THREAD_ID: "parent-1", AGE_SERVER_URL: url },
          captured.io,
        );
        expect(code).toBe(0);
        expect(captured.stdout()).toBe("worker-file\n");
      },
    );

    await withServer(
      (_method, params) => {
        expect(params).toMatchObject({ prompt: "from stdin" });
        return { threadId: "worker-stdin" };
      },
      async (url) => {
        const captured = capture();
        captured.io.stdin = Readable.from(["from stdin\n"]);
        const code = await runAgentsCli(
          ["spawn", "--provider", "cursor", "--model", "auto", "--prompt-file", "-"],
          { AGE_THREAD_ID: "parent-1", AGE_SERVER_URL: url },
          captured.io,
        );
        expect(code).toBe(0);
        expect(captured.stdout()).toBe("worker-stdin\n");
      },
    );
  });

  it("prints list rows and a stable json shape", async () => {
    await withServer(
      () => [row],
      async (url) => {
        const plain = capture();
        expect(
          await runAgentsCli(
            ["list"],
            { AGE_THREAD_ID: "parent-1", AGE_SERVER_URL: url },
            plain.io,
          ),
        ).toBe(0);
        expect(plain.stdout()).toBe("worker-1 working demo demo Fix the parser\n");

        const json = capture();
        expect(
          await runAgentsCli(
            ["list", "--json"],
            { AGE_THREAD_ID: "parent-1", AGE_SERVER_URL: url },
            json.io,
          ),
        ).toBe(0);
        expect(JSON.parse(json.stdout())).toEqual([row]);
      },
    );
  });

  it("waits with a seconds timeout and exits 2 when any id is still pending", async () => {
    await withServer(
      (_method, params) => {
        expect(params).toEqual({ threadIds: ["a", "b"], timeoutMs: 1_000 });
        return { finished: ["a"], pending: ["b"] };
      },
      async (url, seen) => {
        const captured = capture();
        const code = await runAgentsCli(
          ["wait", "--timeout", "1", "a", "b"],
          { AGE_THREAD_ID: "parent-1", AGE_SERVER_URL: url },
          captured.io,
        );
        expect(seen.method).toBe("agents.wait");
        expect(code).toBe(2);
        expect(captured.stdout()).toBe("a finished\nb pending\n");
      },
    );

    await withServer(
      (_method, params) => {
        expect(params).toEqual({ threadIds: ["a"], timeoutMs: 600_000 });
        return { finished: ["a"], pending: [] };
      },
      async (url) => {
        const captured = capture();
        const code = await runAgentsCli(
          ["wait", "a"],
          { AGE_THREAD_ID: "parent-1", AGE_SERVER_URL: url },
          captured.io,
        );
        expect(code).toBe(0);
        expect(captured.stdout()).toBe("a finished\n");
      },
    );
  });

  it("prints a result as text and as json", async () => {
    const full = {
      status: "done",
      summary: "landed the change",
      diffStat: { files: 2, additions: 10, deletions: 1 },
      worktreePath: "/tmp/wt",
    };
    await withServer(
      () => full,
      async (url) => {
        const plain = capture();
        expect(
          await runAgentsCli(
            ["result", "worker-1"],
            { AGE_THREAD_ID: "parent-1", AGE_SERVER_URL: url },
            plain.io,
          ),
        ).toBe(0);
        expect(plain.stdout()).toBe("done\nlanded the change\n2 files, +10 -1\n/tmp/wt\n");

        const json = capture();
        expect(
          await runAgentsCli(
            ["result", "worker-1", "--json"],
            { AGE_THREAD_ID: "parent-1", AGE_SERVER_URL: url },
            json.io,
          ),
        ).toBe(0);
        expect(JSON.parse(json.stdout())).toEqual(full);
      },
    );

    await withServer(
      () => ({ status: "idle", summary: "" }),
      async (url) => {
        const json = capture();
        expect(
          await runAgentsCli(
            ["result", "--json", "worker-1"],
            { AGE_THREAD_ID: "parent-1", AGE_SERVER_URL: url },
            json.io,
          ),
        ).toBe(0);
        expect(JSON.parse(json.stdout())).toEqual({ status: "idle", summary: "" });
      },
    );
  });

  it("uses a live server.json when AGE_SERVER_URL is unset", async () => {
    const home = await tempDir("age-home");
    await withServer(
      () => [],
      async (url) => {
        await writeFile(
          join(home, "server.json"),
          JSON.stringify({ url, pid: process.pid, startedAt: "t" }),
        );
        const captured = capture();
        const code = await runAgentsCli(
          ["list", "--json"],
          { AGE_HOME: home, AGE_THREAD_ID: "parent-1" },
          captured.io,
        );
        expect(code).toBe(0);
        expect(captured.stdout().trim()).toBe("[]");
      },
    );
  });

  it("prints the server error and exits 1", async () => {
    await withServer(
      () => {
        throw new Error("not implemented");
      },
      async (url) => {
        const captured = capture();
        const code = await runAgentsCli(
          ["result", "worker-1"],
          { AGE_THREAD_ID: "parent-1", AGE_SERVER_URL: url },
          captured.io,
        );
        expect(code).toBe(1);
        expect(captured.stderr().trim()).toBe("not implemented");
      },
    );
  });
});
