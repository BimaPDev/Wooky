import { isLocalPreviewHost } from "@wooky/contracts";

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

const refused = new Set<string>();

function refuse(url: string, reason: string) {
  if (refused.has(url)) return;
  refused.add(url);
  console.warn(`Wooky: not opening ${url} (${reason})`);
}

/**
 * Opens an http(s) address in the system browser. Anything else is dropped without a dialog;
 * `localOnly` additionally restricts the host to this machine, for preview links.
 */
export function openExternalUrl(url: string, options: { localOnly?: boolean } = {}): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    refuse(url, "not a URL");
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    refuse(url, "only http and https are allowed");
    return false;
  }
  if (options.localOnly && !isLocalPreviewHost(parsed.hostname)) {
    refuse(url, "only a local address is allowed here");
    return false;
  }
  window.open(url, "_blank", "noopener,noreferrer");
  return true;
}
