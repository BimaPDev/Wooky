import { describe, expect, it } from "vitest";
import {
  byteModeDataCodewords,
  encodeQr,
  formatInformationBits,
  reedSolomonRemainder,
  versionInformationBits,
} from "./qr.ts";

describe("QR encoder", () => {
  it("packs Hello in byte mode with the terminator and pad bytes", () => {
    // 0100 | count 00000101 | "Hello" | 0000 terminator, then 0xEC/0x11 pads to 16 codewords.
    expect(byteModeDataCodewords("Hello", 1)).toEqual([
      0x40, 0x54, 0x86, 0x56, 0xc6, 0xc6, 0xf0, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11,
      0xec,
    ]);
  });

  it("matches the published version-1 medium Reed-Solomon remainder", () => {
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    expect(reedSolomonRemainder(data, 10)).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });

  it("uses the published format and version information bits", () => {
    expect(formatInformationBits(0)).toBe(0b101010000010010);
    expect(versionInformationBits(7)).toBe(0b000111110010010100);
  });

  it("draws the finder, the dark module, and format bit 0 for mask 0", () => {
    const qr = encodeQr("Hello", 0);
    expect(qr.size).toBe(21);
    expect(qr.modules[0]?.[0]).toBe(true);
    expect(qr.modules[1]?.[1]).toBe(false);
    expect(qr.modules[3]?.[3]).toBe(true);
    expect(qr.modules[13]?.[8]).toBe(true);
    expect(qr.modules[0]?.[8]).toBe(true);
  });

  it("fits a pairing URL inside versions 1–10", () => {
    const qr = encodeQr("http://100.101.102.103:4317/#/pair?code=K7MNPQRS");
    expect(qr.size).toBeGreaterThanOrEqual(21);
    expect(qr.size).toBeLessThanOrEqual(57);
    expect(qr.modules).toHaveLength(qr.size);
  });
});
