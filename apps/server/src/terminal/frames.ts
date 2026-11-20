const FRAME_BYTES = 64 * 1024;
const RING_BYTES = 256 * 1024;

const HOLD_ESC_CHARS = 64;
const RESET_SGR = "\x1b[0m";

function isUtf8Continuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

/** Walk back so `end` is not mid-code-point. A character longer than the budget is taken whole. */
export function utf8FrameEnd(buf: Buffer, offset: number, maxBytes: number): number {
  const hard = Math.min(offset + maxBytes, buf.length);
  if (hard >= buf.length) return buf.length;
  let cut = hard;
  while (cut > offset) {
    const byte = buf[cut];
    if (byte === undefined || !isUtf8Continuation(byte)) break;
    cut -= 1;
  }
  if (cut === offset) {
    cut = offset + 1;
    while (cut < buf.length) {
      const byte = buf[cut];
      if (byte === undefined || !isUtf8Continuation(byte)) break;
      cut += 1;
    }
    return cut;
  }
  return cut;
}

function csiComplete(seq: string): boolean {
  for (let i = 2; i < seq.length; i += 1) {
    const code = seq.charCodeAt(i);
    if (code >= 0x40 && code <= 0x7e) return true;
  }
  return false;
}

function oscComplete(seq: string): boolean {
  if (seq.includes("\x07")) return true;
  return seq.includes("\x1b\\");
}

function escapeSequenceComplete(seq: string): boolean {
  if (!seq.startsWith("\x1b")) return true;
  if (seq.length < 2) return false;
  const second = seq.charCodeAt(1);
  if (second === 0x5b) return csiComplete(seq);
  if (second === 0x5d || second === 0x50 || second === 0x5e || second === 0x5f) {
    return oscComplete(seq);
  }
  if (second === 0x5c) return true;
  return true;
}

/**
 * Hold a trailing incomplete ESC sequence (last unterminated `\x1b` within 64 chars)
 * so a flush never splits ESC from the rest of its sequence.
 */
export function holdIncompleteEscape(text: string): { ready: string; held: string } {
  const idx = text.lastIndexOf("\x1b");
  if (idx < 0) return { ready: text, held: "" };
  const tail = text.slice(idx);
  if (tail.length > HOLD_ESC_CHARS) return { ready: text, held: "" };
  if (escapeSequenceComplete(tail)) return { ready: text, held: "" };
  return { ready: text.slice(0, idx), held: tail };
}

function ansiFrameEnd(buf: Buffer, offset: number, end: number): number {
  if (end >= buf.length) return end;
  const windowStart = Math.max(offset, end - HOLD_ESC_CHARS);
  const window = buf.subarray(windowStart, end).toString("utf8");
  const { held } = holdIncompleteEscape(window);
  if (!held) return end;
  const heldBytes = Buffer.byteLength(held, "utf8");
  const cut = end - heldBytes;
  return cut > offset ? cut : end;
}

/** Split `data` into frames of at most `maxBytes`, never mid-code-point or mid-ESC. */
export function splitOutputFrames(data: string, maxBytes = FRAME_BYTES): string[] {
  if (!data) return [];
  const buf = Buffer.from(data, "utf8");
  if (buf.length <= maxBytes) return [data];
  const frames: string[] = [];
  let offset = 0;
  while (offset < buf.length) {
    let end = utf8FrameEnd(buf, offset, maxBytes);
    end = ansiFrameEnd(buf, offset, end);
    if (end <= offset) end = utf8FrameEnd(buf, offset, maxBytes);
    frames.push(buf.subarray(offset, end).toString("utf8"));
    offset = end;
  }
  return frames;
}

/**
 * Keep the last `maxBytes` of the ring. After overflow, start just after the first
 * newline in that window and prefix SGR reset so replay does not inherit a half-style.
 */
export function trimReplayRing(ring: Buffer, chunk: Buffer, maxBytes = RING_BYTES): Buffer {
  const next = ring.length === 0 ? chunk : Buffer.concat([ring, chunk]);
  if (next.length <= maxBytes) return next;
  let window = next.subarray(next.length - maxBytes);
  const newline = window.indexOf(0x0a);
  if (newline >= 0) window = window.subarray(newline + 1);
  return Buffer.concat([Buffer.from(RESET_SGR), window]);
}

export function appendToRing(ring: Buffer, chunk: string, maxBytes = RING_BYTES): Buffer {
  return trimReplayRing(ring, Buffer.from(chunk, "utf8"), maxBytes);
}
