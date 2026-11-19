import { PICK_FOLDER_TIMEOUT_MS, type AgeEvent, type ReadModel } from "@wooky/contracts";
import { applyEvent, emptyReadModel } from "@wooky/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRpcClient, RpcCallError, type SocketHandlers, type SocketLike } from "./client.ts";

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: { id: number; method: string; params: unknown }[] = [];
  constructor(private readonly handlers: SocketHandlers) {}

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.handlers.close();
  }
  open() {
    this.readyState = 1;
    this.handlers.open();
  }
  drop() {
    this.readyState = 3;
    this.handlers.close();
  }
  reply(id: number, result: unknown) {
    this.handlers.message(JSON.stringify({ id, ok: true, result }));
  }
  fail(id: number, code: string, message: string) {
    this.handlers.message(JSON.stringify({ id, ok: false, error: { code, message } }));
  }
  push(event: AgeEvent) {
    this.handlers.message(JSON.stringify({ push: "event", event }));
  }
  last(method: string) {
    const found = this.sent.findLast((request) => request.method === method);
    if (!found) throw new Error(`no ${method} sent`);
    return found;
  }
}

const project = (seq: number, id: string): AgeEvent => ({
  seq,
  at: "2026-01-01T00:00:00.000Z",
  commandId: null,
  type: "project.added",
  project: { id, name: id, root: `/tmp/${id}`, createdAt: "2026-01-01T00:00:00.000Z" },
});

const flush = () => Promise.resolve().then(() => Promise.resolve());

function setup(options: { timeoutMs?: number } = {}) {
  const sockets: FakeSocket[] = [];
  let model: ReadModel = emptyReadModel();
  const applied: number[] = [];
  const statuses: string[] = [];
  const client = createRpcClient({
    url: "ws://test/ws",
    socketFactory: (_url, handlers) => {
      const socket = new FakeSocket(handlers);
      sockets.push(socket);
      return socket;
    },
    getSeq: () => model.seq,
    onSnapshot: (next) => {
      model = next;
    },
    onEvent: (event) => {
      const next = applyEvent(model, event);
      if (next !== model) applied.push(event.seq);
      model = next;
    },
    onStatus: (status) => statuses.push(status),
    requestTimeoutMs: options.timeoutMs ?? 1000,
    random: () => 0.5,
  });
  const socket = () => {
    const last = sockets.at(-1);
    if (!last) throw new Error("no socket");
    return last;
  };
  return { client, sockets, socket, applied, statuses, model: () => model };
}

describe("rpc client", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("correlates responses by id, including out of order", async () => {
    const { client, socket } = setup();
    socket().open();
    const a = client.call("providers.list", {});
    const b = client.call("fs.pickable", { query: "x" });
    const idA = socket().last("providers.list").id;
    const idB = socket().last("fs.pickable").id;
    socket().reply(idB, [{ path: "/x", isGitRepo: true }]);
    socket().reply(idA, []);
    await expect(b).resolves.toEqual([{ path: "/x", isGitRepo: true }]);
    await expect(a).resolves.toEqual([]);
    expect(idA).not.toBe(idB);
    client.close();
  });

  it("maps server errors to RpcCallError with the server code", async () => {
    const { client, socket } = setup();
    socket().open();
    const call = client.call("git.diff", { threadId: "t1" });
    socket().fail(socket().last("git.diff").id, "not_found", "No such thread.");
    const error = await call.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcCallError);
    expect(error).toMatchObject({ code: "not_found", message: "No such thread." });
    client.close();
  });

  it("rejects a call that gets no answer within the timeout", async () => {
    const { client, socket } = setup({ timeoutMs: 500 });
    socket().open();
    const call = client.call("providers.list", {});
    const settled = call.catch((e: unknown) => e);
    vi.advanceTimersByTime(500);
    expect(await settled).toMatchObject({ code: "timeout" });
    client.close();
  });

  it("keeps a folder dialog open past the short RPC timeout", async () => {
    const { client, socket } = setup({ timeoutMs: 500 });
    socket().open();
    const call = client.call("fs.pickFolder", {});
    const settled = call.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await vi.advanceTimersByTimeAsync(500);
    socket().reply(socket().last("fs.pickFolder").id, { path: "/tmp/app", supported: true });
    await expect(settled).resolves.toEqual({
      ok: true,
      value: { path: "/tmp/app", supported: true },
    });
    client.close();
  });

  it("times out a folder dialog five seconds after the server, with a chooser message", async () => {
    const { client, socket } = setup({ timeoutMs: 500 });
    socket().open();
    const call = client.call("fs.pickFolder", {});
    const settled = call.then(
      () => ({ timedOut: false }),
      (error: unknown) => ({ timedOut: true, error }),
    );
    await vi.advanceTimersByTimeAsync(PICK_FOLDER_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(4_999);
    let done = false;
    void settled.then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(settled).resolves.toMatchObject({
      timedOut: true,
      error: { code: "timeout", message: "The folder chooser timed out." },
    });
    client.close();
  });

  it("queues calls made before the socket opens", async () => {
    const { client, socket } = setup();
    const call = client.call("providers.list", {});
    expect(socket().sent).toHaveLength(0);
    socket().open();
    socket().reply(socket().last("providers.list").id, []);
    await expect(call).resolves.toEqual([]);
    client.close();
  });

  it("snapshots, subscribes, applies pushes in order and ignores duplicates", async () => {
    const { client, socket, applied, model } = setup();
    socket().open();
    socket().reply(socket().last("snapshot").id, { ...emptyReadModel(), seq: 2 });
    await flush();
    expect(socket().last("subscribe").params).toEqual({ fromSeq: 2 });
    socket().push(project(3, "p3"));
    socket().push(project(2, "old"));
    socket().push(project(4, "p4"));
    socket().push(project(4, "p4"));
    expect(applied).toEqual([3, 4]);
    expect(Object.keys(model().projects)).toEqual(["p3", "p4"]);
    client.close();
  });

  it("reconnects with backoff and resubscribes from the last applied seq", async () => {
    const { client, sockets, socket, statuses } = setup();
    socket().open();
    socket().reply(socket().last("snapshot").id, emptyReadModel());
    await flush();
    socket().reply(socket().last("subscribe").id, { replayed: 0 });
    socket().push(project(1, "a"));
    socket().push(project(2, "b"));
    const inflight = client.call("providers.list", {}).catch((e: unknown) => e);

    socket().drop();
    expect(await inflight).toMatchObject({ code: "disconnected" });
    expect(statuses.at(-1)).toBe("reconnecting");
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(250);
    expect(sockets).toHaveLength(2);

    socket().open();
    await flush();
    expect(socket().sent.map((r) => r.method)).toEqual(["subscribe"]);
    expect(socket().last("subscribe").params).toEqual({ fromSeq: 2 });
    expect(statuses.at(-1)).toBe("open");
    client.close();
  });
});
