import { describe, expect, it } from "vitest";
import { formatBytes, promptWithAttachments, readyAttachments } from "./attachments.ts";

const file = (id: string, path: string) => ({
  id,
  name: path.split("/").at(-1) ?? "",
  path,
  size: 1,
});

describe("promptWithAttachments", () => {
  it("leaves the prompt alone without attachments", () => {
    expect(promptWithAttachments("  fix the bug ", [])).toBe("fix the bug");
  });

  it("lists every saved path after the text", () => {
    expect(
      promptWithAttachments("look at these", [
        file("a", "/h/attachments/a/shot.png"),
        file("b", "/h/attachments/b/log.txt"),
      ]),
    ).toBe(
      "look at these\n\nAttached files:\n- /h/attachments/a/shot.png\n- /h/attachments/b/log.txt",
    );
  });

  it("sends attachments alone when there is no text", () => {
    expect(promptWithAttachments("", [file("a", "/h/a/shot.png")])).toBe(
      "Attached file:\n- /h/a/shot.png",
    );
  });
});

describe("readyAttachments", () => {
  it("skips uploads that are still running or failed", () => {
    const ready = file("a", "/h/a/x");
    expect(
      readyAttachments([
        { key: "1", name: "x", status: "ready", attachment: ready },
        { key: "2", name: "y", status: "uploading" },
        { key: "3", name: "z", status: "failed", error: "too big" },
      ]),
    ).toEqual([ready]);
  });
});

describe("formatBytes", () => {
  it("picks a readable unit", () => {
    expect(formatBytes(900)).toBe("900 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
