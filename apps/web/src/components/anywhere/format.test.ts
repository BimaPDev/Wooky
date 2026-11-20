import { describe, expect, it } from "vitest";
import { directPublicHttpWarning, groupPairingCode, pairRoute, pairingQrText } from "./format.ts";
import { browserDeviceName, browserPlatform } from "./pair/device.ts";

describe("pair route", () => {
  it("reads the code from the hash", () => {
    expect(pairRoute("#/pair?code=ABCD2345")).toEqual({ code: "ABCD2345" });
    expect(pairRoute("#/pair")).toEqual({ code: null });
    expect(pairRoute("#/pair?code=")).toEqual({ code: null });
  });

  it("leaves every other hash to the app", () => {
    expect(pairRoute("")).toBeNull();
    expect(pairRoute("#/settings")).toBeNull();
    expect(pairRoute("#/pairing")).toBeNull();
  });

  it("round-trips the QR text", () => {
    const text = pairingQrText("http://100.64.0.1:4317/", "ABCD2345");
    expect(text).toBe("http://100.64.0.1:4317/#/pair?code=ABCD2345");
    expect(pairRoute(new URL(text).hash)).toEqual({ code: "ABCD2345" });
  });

  it("groups a code 4-4", () => {
    expect(groupPairingCode("ABCD2345")).toBe("ABCD 2345");
  });
});

describe("public http warning", () => {
  it.each([
    "http://localhost:4317",
    "http://127.0.0.1:4317",
    "http://192.168.1.20:4317",
    "http://10.0.0.5",
    "http://172.20.0.1",
    "http://100.101.102.103:4317",
    "http://home.tailnet.ts.net:4317",
    "http://[fd12::1]:4317",
    "https://example.com",
  ])("allows %s without a warning", (url) => {
    expect(directPublicHttpWarning(url)).toBeNull();
  });

  it.each(["http://example.com", "http://8.8.8.8:4317", "http://172.32.0.1", "http://100.128.0.1"])(
    "warns about %s",
    (url) => {
      expect(directPublicHttpWarning(url)).toContain("public");
    },
  );

  it("is not fooled by userinfo", () => {
    expect(directPublicHttpWarning("http://localhost@example.com/")).toContain("public");
  });
});

describe("browser device", () => {
  it("names the browser and system", () => {
    expect(
      browserDeviceName(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile Safari/604.1",
      ),
    ).toBe("Safari on iOS");
    expect(
      browserDeviceName(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36 Edg/120.0",
      ),
    ).toBe("Edge on Windows");
  });

  it("maps phones to other", () => {
    expect(browserPlatform("Mozilla/5.0 (Linux; Android 14)")).toBe("other");
    expect(browserPlatform("Mozilla/5.0 (X11; Linux x86_64)")).toBe("linux");
  });
});
