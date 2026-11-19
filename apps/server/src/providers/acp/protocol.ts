import { z } from "zod";

export const ACP_PROTOCOL_VERSION = 1;
export const AUTH_REQUIRED_CODE = -32000;
export const METHOD_NOT_FOUND_CODE = -32601;

const RpcId = z.union([z.string().min(1), z.number().int()]);

const RpcErrorBody = z.object({
  code: z.number(),
  message: z.string(),
  data: z.unknown().optional(),
});

const LooseMessage = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: RpcId.optional(),
    method: z.string().min(1).optional(),
    params: z.unknown().optional(),
    result: z.unknown().optional(),
    error: RpcErrorBody.optional(),
  })
  .passthrough();

export type RpcIdValue = z.infer<typeof RpcId>;

export type IncomingMessage =
  | { kind: "notification"; method: string; params: unknown }
  | { kind: "request"; id: RpcIdValue; method: string; params: unknown }
  | { kind: "response"; id: RpcIdValue; result: unknown }
  | { kind: "error"; id: RpcIdValue; error: { code: number; message: string } }
  | { kind: "invalid" };

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** Every inbound line is a JSON-RPC 2.0 object. Anything else is invalid. */
export function parseIncoming(value: unknown): IncomingMessage {
  const parsed = LooseMessage.safeParse(value);
  if (!parsed.success || !value || typeof value !== "object") return { kind: "invalid" };
  const msg = parsed.data;
  const hasResult = hasOwn(value, "result");
  const hasError = msg.error !== undefined;
  if (hasResult && hasError) return { kind: "invalid" };

  if (msg.method && msg.id === undefined && !hasResult && !hasError) {
    return { kind: "notification", method: msg.method, params: msg.params };
  }
  if (msg.method && msg.id !== undefined && !hasResult && !hasError) {
    return { kind: "request", id: msg.id, method: msg.method, params: msg.params };
  }
  if (msg.id !== undefined && hasError && msg.error && msg.method === undefined) {
    return {
      kind: "error",
      id: msg.id,
      error: { code: msg.error.code, message: msg.error.message },
    };
  }
  if (msg.id !== undefined && hasResult && msg.method === undefined && !hasError) {
    return { kind: "response", id: msg.id, result: msg.result };
  }
  return { kind: "invalid" };
}

export const InitializeResult = z
  .object({
    protocolVersion: z.number().int(),
    agentCapabilities: z
      .object({
        loadSession: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
    agentInfo: z
      .object({
        name: z.string().optional(),
        title: z.string().optional(),
        version: z.string().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    authMethods: z
      .array(
        z
          .object({
            id: z.string(),
            name: z.string().optional(),
            description: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();
export type InitializeResult = z.infer<typeof InitializeResult>;

export const ConfigOption = z
  .object({
    id: z.string(),
    currentValue: z.unknown().optional(),
  })
  .passthrough();
export type ConfigOption = z.infer<typeof ConfigOption>;

export const SessionResult = z
  .object({
    sessionId: z.string().min(1),
    configOptions: z.array(ConfigOption).nullable().optional(),
  })
  .passthrough();
export type SessionResult = z.infer<typeof SessionResult>;

export const PromptResult = z
  .object({
    stopReason: z.string(),
  })
  .passthrough();
export type PromptResult = z.infer<typeof PromptResult>;

export const SessionUpdateParams = z
  .object({
    sessionId: z.string().optional(),
    update: z
      .object({
        sessionUpdate: z.string(),
      })
      .passthrough(),
  })
  .passthrough();

export function initializeParams(): {
  protocolVersion: number;
  clientCapabilities: {
    fs: { readTextFile: false; writeTextFile: false };
    terminal: false;
  };
  clientInfo: { name: string; title: string; version: string };
} {
  return {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
    clientInfo: { name: "age", title: "AGE", version: "0.0.0" },
  };
}
