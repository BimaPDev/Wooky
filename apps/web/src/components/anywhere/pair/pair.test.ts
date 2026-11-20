import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pairWithHost } from "./pair.ts";
import { loadPairedToken } from "./token.ts";

function stubStorage() {
  const map = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  });
}

const host = { deviceId: "host-1", name: "Home server", platform: "linux", version: "1.0.0" };

function answer(status: number, body: unknown): typeof fetch {
  return vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;
}

describe("pairWithHost", () => {
  beforeEach(stubStorage);
  afterEach(() => vi.unstubAllGlobals());

  it("posts the code and device, then keeps the token", async () => {
    const fetcher = answer(200, { token: "tok-123", host });
    const outcome = await pairWithHost("abcd 2345", "Phone", fetcher);
    expect(outcome).toEqual({ ok: true, hostName: "Home server" });
    expect(loadPairedToken()).toBe("tok-123");
    const [url, init] = vi.mocked(fetcher).mock.calls[0] ?? [];
    expect(url).toBe("/pair");
    const sent = JSON.parse(String((init as RequestInit).body));
    expect(sent.code).toBe("ABCD2345");
    expect(sent.device.name).toBe("Phone");
  });

  it("rejects a malformed code without calling the host", async () => {
    const fetcher = answer(200, {});
    const outcome = await pairWithHost("nope", "Phone", fetcher);
    expect(outcome.ok).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("explains a wrong or expired code and stores nothing", async () => {
    const outcome = await pairWithHost("ABCD2345", "Phone", answer(401, { error: "bad" }));
    expect(outcome).toMatchObject({ ok: false });
    expect(outcome.ok === false && outcome.message).toContain("wrong, used, or expired");
    expect(loadPairedToken()).toBeNull();
  });

  it("explains a lockout", async () => {
    const outcome = await pairWithHost("ABCD2345", "Phone", answer(429, {}));
    expect(outcome.ok === false && outcome.message).toContain("Wait a minute");
  });

  it("reports an unreachable host", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new TypeError("network");
    }) as unknown as typeof fetch;
    const outcome = await pairWithHost("ABCD2345", "Phone", fetcher);
    expect(outcome.ok === false && outcome.message).toContain("Could not reach");
  });

  it("refuses an answer that is not a pairing response", async () => {
    const outcome = await pairWithHost("ABCD2345", "Phone", answer(200, { token: "" }));
    expect(outcome.ok).toBe(false);
    expect(loadPairedToken()).toBeNull();
  });
});
