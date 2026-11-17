/** Buffers partial stdout chunks into complete NDJSON lines. */
export function createNdjsonSplitter() {
  let buffer = "";

  return {
    /** Returns zero or more complete lines parsed from `chunk`. */
    push(chunk: string): string[] {
      buffer += chunk;
      const lines: string[] = [];
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl === -1) break;
        lines.push(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
      return lines;
    },

    /** Returns a trailing unterminated line, if any. */
    flush(): string | null {
      if (buffer.length === 0) return null;
      const line = buffer;
      buffer = "";
      return line;
    },
  };
}
