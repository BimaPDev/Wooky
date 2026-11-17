import { z } from "zod";

export const TerminalSessionId = z.string().min(1);
export type TerminalSessionId = z.infer<typeof TerminalSessionId>;

export const TerminalPush = z.object({
  push: z.literal("terminal"),
  sessionId: TerminalSessionId,
  kind: z.enum(["data", "exit", "error"]),
  data: z.string().optional(),
  code: z.number().int().optional(),
});
export type TerminalPush = z.infer<typeof TerminalPush>;
