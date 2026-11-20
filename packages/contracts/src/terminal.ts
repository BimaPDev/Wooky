import { z } from "zod";
import { Id, IsoTime } from "./model.ts";

export const TerminalSessionId = z.string().min(1);
export type TerminalSessionId = z.infer<typeof TerminalSessionId>;

export const TerminalSize = z.object({
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});
export type TerminalSize = z.infer<typeof TerminalSize>;

export const TerminalInfo = z.object({
  sessionId: TerminalSessionId,
  title: z.string(),
  cwd: z.string(),
  shell: z.string(),
  /** False when node-pty is unavailable and the session is a pipe. */
  pty: z.boolean(),
  createdAt: IsoTime,
  exited: z.boolean(),
  projectId: Id.nullable(),
  scriptId: Id.nullable(),
});
export type TerminalInfo = z.infer<typeof TerminalInfo>;

export const TerminalPush = z.object({
  push: z.literal("terminal"),
  sessionId: TerminalSessionId,
  kind: z.enum(["data", "exit", "error", "replay"]),
  /** `replay` carries the buffered scrollback sent when a client reattaches. */
  data: z.string().optional(),
  code: z.number().int().optional(),
});
export type TerminalPush = z.infer<typeof TerminalPush>;
