import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ReadModel } from "@wooky/contracts";

const TOKEN_BYTES = 32;

export interface AgentTokenService {
  issue(threadId: string): string;
  verify(token: string, model: ReadModel): string | null;
}

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function parseToken(token: string): { threadId: string; mac: string } | null {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot >= token.length - 1) return null;
  const threadId = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!threadId || !mac) return null;
  return { threadId, mac };
}

export function createAgentTokenService(secret = randomBytes(TOKEN_BYTES)): AgentTokenService {
  const key = secret;

  return {
    issue(threadId: string): string {
      const mac = createHmac("sha256", key).update(threadId).digest();
      return `${threadId}.${base64Url(mac)}`;
    },
    verify(token: string, model: ReadModel): string | null {
      const parsed = parseToken(token);
      if (!parsed) return null;
      if (!model.threads[parsed.threadId]) return null;
      const expected = createHmac("sha256", key).update(parsed.threadId).digest();
      let actual: Buffer;
      try {
        actual = Buffer.from(parsed.mac, "base64url");
      } catch {
        return null;
      }
      if (actual.length !== expected.length) return null;
      if (!timingSafeEqual(actual, expected)) return null;
      return parsed.threadId;
    },
  };
}
