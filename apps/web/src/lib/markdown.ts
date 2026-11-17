/**
 * A small markdown subset parsed into a tree. Rendering goes through React elements,
 * so text is always escaped; no HTML from the input is ever interpreted.
 */
export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "link"; href: string; children: Inline[] };

export type Block =
  | { type: "paragraph"; children: Inline[] }
  | { type: "heading"; level: 1 | 2 | 3 | 4; children: Inline[] }
  | { type: "code"; lang: string; text: string }
  | { type: "list"; ordered: boolean; items: Inline[][] }
  | { type: "quote"; children: Inline[] }
  | { type: "rule" };

const FENCE = /^\s{0,3}(```|~~~)\s*([\w+-]*)/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1] ?? "```";
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").trimStart().startsWith(marker)) {
        body.push(lines[i] ?? "");
        i++;
      }
      i++;
      blocks.push({ type: "code", lang: fence[2] ?? "", text: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ type: "rule" });
      i++;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const level = Math.min(4, heading[1]?.length ?? 1) as 1 | 2 | 3 | 4;
      blocks.push({ type: "heading", level, children: parseInline(heading[2] ?? "") });
      i++;
      continue;
    }
    const ordered = ORDERED.test(line);
    if (ordered || BULLET.test(line)) {
      const pattern = ordered ? ORDERED : BULLET;
      const items: string[] = [];
      while (i < lines.length) {
        const current = lines[i] ?? "";
        const match = pattern.exec(current);
        if (match) items.push(match[1] ?? "");
        else if (current.trim() && /^\s+/.test(current) && items.length)
          items[items.length - 1] += ` ${current.trim()}`;
        else break;
        i++;
      }
      blocks.push({ type: "list", ordered, items: items.map(parseInline) });
      continue;
    }
    if (line.startsWith(">")) {
      const body: string[] = [];
      while (i < lines.length && (lines[i] ?? "").startsWith(">")) {
        body.push((lines[i] ?? "").replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ type: "quote", children: parseInline(body.join(" ")) });
      continue;
    }
    const body: string[] = [];
    while (i < lines.length) {
      const current = lines[i] ?? "";
      if (
        !current.trim() ||
        FENCE.test(current) ||
        HEADING.test(current) ||
        BULLET.test(current) ||
        ORDERED.test(current) ||
        current.startsWith(">")
      )
        break;
      body.push(current.trim());
      i++;
    }
    blocks.push({ type: "paragraph", children: parseInline(body.join(" ")) });
  }
  return blocks;
}

export function safeHref(href: string): string | null {
  const trimmed = href.trim();
  return /^https?:\/\/[^\s]+$/i.test(trimmed) ? trimmed : null;
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer) out.push({ type: "text", text: buffer });
    buffer = "";
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length && /[\\`*_[\]()#>-]/.test(text[i + 1] ?? "")) {
      buffer += text[i + 1];
      i += 2;
      continue;
    }
    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i) {
        flush();
        out.push({ type: "code", text: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if ((ch === "*" || ch === "_") && text[i + 1] === ch) {
      const marker = ch + ch;
      const end = text.indexOf(marker, i + 2);
      if (end > i + 2) {
        flush();
        out.push({ type: "strong", children: parseInline(text.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if ((ch === "*" || ch === "_") && text[i + 1] !== " " && text[i + 1] !== undefined) {
      const end = text.indexOf(ch, i + 1);
      const wordBefore = ch === "_" && /\w/.test(text[i - 1] ?? "");
      if (end > i + 1 && !wordBefore && text[end - 1] !== " ") {
        flush();
        out.push({ type: "em", children: parseInline(text.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    if (ch === "[") {
      const close = text.indexOf("](", i + 1);
      const end = close > 0 ? text.indexOf(")", close + 2) : -1;
      if (close > 0 && end > 0) {
        const label = parseInline(text.slice(i + 1, close));
        const href = safeHref(text.slice(close + 2, end));
        flush();
        if (href) out.push({ type: "link", href, children: label });
        else out.push(...label);
        i = end + 1;
        continue;
      }
    }
    buffer += ch;
    i++;
  }
  flush();
  return out;
}
