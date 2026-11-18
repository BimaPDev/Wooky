import { describe, expect, it } from "vitest";
import { terminalLine } from "./TerminalPane.tsx";

describe("terminalLine", () => {
  it("ends a line written to the pipe with a line feed", () => {
    expect(terminalLine("agent login")).toBe("agent login\n");
    expect(terminalLine("claude auth login")).toBe("claude auth login\n");
    expect(terminalLine("echo hello")).toBe("echo hello\n");
    expect(terminalLine("")).toBe("\n");
  });

  it("uses the line ending the server chose", () => {
    expect(terminalLine("echo hello", "\n")).toBe("echo hello\n");
    expect(terminalLine("echo hello", "\r\n")).toBe("echo hello\r\n");
    expect(terminalLine("", "\r\n")).toBe("\r\n");
  });

  it("falls back to a line feed when no ending is passed", () => {
    expect(terminalLine("agent login")).toBe("agent login\n");
  });
});
