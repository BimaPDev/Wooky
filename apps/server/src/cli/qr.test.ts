import { describe, expect, it } from "vitest";
import { encodeQr, renderQr } from "./qr.ts";

describe("pairing QR", () => {
  it("draws a version-1 code with finder patterns and half-blocks", () => {
    const matrix = encodeQr("hi");
    expect(matrix).toHaveLength(21);
    expect(matrix[0]?.[0]).toBe(true);
    expect(matrix[1]?.[1]).toBe(false);
    expect(matrix[3]?.[3]).toBe(true);
    expect(matrix[0]?.[20]).toBe(true);
    expect(matrix[20]?.[0]).toBe(true);
    const drawn = renderQr("http://127.0.0.1:4317/#/pair?code=23456789");
    expect(drawn).toContain("█");
    expect(drawn).toContain("\x1b[0m");
  });
});
