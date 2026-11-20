import type { z } from "zod";

export const MAX_PEER_BODY_BYTES = 32 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

/** Reads a body but gives up once it passes `maxBytes`, whatever the peer declared. */
async function readCapped(response: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maxBytes) return null;
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * GETs JSON from a paired peer. A non-200, a timeout, an oversized body or a body that does
 * not match the schema all give null: nothing from a peer is trusted until it parses.
 */
export async function fetchPeerJson<S extends z.ZodType>(
  peer: { baseUrl: string; token: string },
  path: string,
  query: Record<string, string>,
  schema: S,
  maxBytes = MAX_PEER_BODY_BYTES,
): Promise<z.infer<S> | null> {
  const url = new URL(path, peer.baseUrl);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${peer.token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const text = await readCapped(response, maxBytes);
  if (text === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? parsed.data : null;
}
