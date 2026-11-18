import { describe, expect, it } from "vitest";
import { terminalLine } from "./TerminalPane.tsx";

describe("terminalLine", () => {
  it("ends a line written to the pipe with a line feed", () => {
    expect(terminalLine("agent login")).toBe("agent login\n");
    expect(terminalLine("claude auth login")).toBe("claude auth login\n");
    expect(terminalLine("echo hello")).toBe("echo hello\n");
    expect(terminalLine("")).toBe("\n");
  });
});
