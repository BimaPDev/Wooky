const HTTP_URL = /https?:\/\/[^\s<>"'`]+/gi;

export interface HttpLinkMatch {
  text: string;
  start: number;
  end: number;
}

/** http(s) URLs in one terminal line, for xterm's registerLinkProvider. */
export function findHttpLinks(text: string): HttpLinkMatch[] {
  const links: HttpLinkMatch[] = [];
  const pattern = new RegExp(HTTP_URL.source, HTTP_URL.flags);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const raw = match[0].replace(/[).,;:]+$/, "");
    links.push({ text: raw, start: match.index, end: match.index + raw.length });
  }
  return links;
}

export function shouldOpenTerminalLink(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return event.metaKey || event.ctrlKey;
}

export function openExternalUrl(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}
