import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ATTACHMENT_MAX_BYTES } from "@age/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAttachmentStore } from "./attachments.ts";

describe("attachment store", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "age-attach-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("writes the file under the home and returns its absolute path", async () => {
    const store = createAttachmentStore(home);
    const saved = await store.put({
      name: "notes.txt",
      dataBase64: Buffer.from("hello").toString("base64"),
    });
    expect(saved.path.startsWith(join(home, "attachments", saved.id))).toBe(true);
    expect(saved).toMatchObject({ name: "notes.txt", size: 5 });
    expect(await readFile(saved.path, "utf8")).toBe("hello");
  });

  it("keeps names inside its own folder", async () => {
    const store = createAttachmentStore(home);
    const data = Buffer.from("x").toString("base64");
    const sneaky = await store.put({ name: "../../etc/passwd", dataBase64: data });
    expect(sneaky.name).toBe("passwd");
    expect(sneaky.path).toBe(join(home, "attachments", sneaky.id, "passwd"));
    const windows = await store.put({ name: "C:\\Users\\me\\shot.png", dataBase64: data });
    expect(windows.name).toBe("shot.png");
    const empty = await store.put({ name: "..", dataBase64: data });
    expect(empty.name).toBe("attachment");
  });

  it("rejects files over the limit", async () => {
    const store = createAttachmentStore(home);
    const big = Buffer.alloc(ATTACHMENT_MAX_BYTES + 1).toString("base64");
    await expect(store.put({ name: "big.bin", dataBase64: big })).rejects.toThrow(/at most/);
  });

  it("removes a saved attachment and ignores ids it did not mint", async () => {
    const store = createAttachmentStore(home);
    const saved = await store.put({ name: "a.txt", dataBase64: "" });
    expect(await store.remove(saved.id)).toEqual({ removed: true });
    await expect(stat(saved.path)).rejects.toThrow(/ENOENT/);
    expect(await store.remove(saved.id)).toEqual({ removed: false });
    expect(await store.remove("../scratch")).toEqual({ removed: false });
  });
});
