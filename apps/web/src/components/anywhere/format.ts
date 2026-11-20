/** Group an 8-character pairing code as 4-4. */
export function groupPairingCode(code: string): string {
  return `${code.slice(0, 4)} ${code.slice(4, 8)}`;
}

/** QR target for a phone or browser: `<url>/#/pair?code=<code>`. */
export function pairingQrText(url: string, code: string): string {
  const base = url.replace(/\/$/, "");
  return `${base}/#/pair?code=${encodeURIComponent(code)}`;
}

/** `#/pair` and `#/pair?code=XXXX`. Anything else is the main app. */
export function pairRoute(hash: string): { code: string | null } | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const queryAt = raw.indexOf("?");
  const path = queryAt === -1 ? raw : raw.slice(0, queryAt);
  if (path !== "/pair") return null;
  const params = new URLSearchParams(queryAt === -1 ? "" : raw.slice(queryAt + 1));
  const code = params.get("code");
  return { code: code && code.length > 0 ? code : null };
}

function parseHttpHost(value: string): { protocol: string; hostname: string } | null {
  const match = /^(https?):\/\/([^/?#]*)/i.exec(value);
  if (!match) return null;
  let authority = match[2] ?? "";
  const at = authority.lastIndexOf("@");
  if (at >= 0) authority = authority.slice(at + 1);
  let hostname: string;
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    if (end < 1) return null;
    hostname = authority.slice(1, end);
  } else {
    hostname = authority.split(":")[0] ?? "";
  }
  if (!hostname) return null;
  return { protocol: match[1]?.toLowerCase() === "https" ? "https:" : "http:", hostname };
}

function firstHextet(host: string): number | null {
  if (host.startsWith("::")) return 0;
  const head = host.split(":")[0] ?? "";
  if (!/^[0-9a-f]{1,4}$/.test(head)) return null;
  return Number.parseInt(head, 16);
}

function isPrivateOrLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1") return true;
  if (host.endsWith(".ts.net")) return true;
  if (host.includes(":")) {
    const bare = host.split("%")[0] ?? host;
    const first = firstHextet(bare);
    if (
      first !== null &&
      ((first >= 0xfd00 && first <= 0xfdff) || (first >= 0xfe80 && first <= 0xfebf))
    )
      return true;
  }
  const mapped = host.startsWith("::ffff:") ? host.slice("::ffff:".length) : host;
  const parts = mapped.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map((part) => Number(part));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const a = nums[0] ?? -1;
  const b = nums[1] ?? -1;
  if (a === 127 || a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/** Direct connections allow public http. The UI warns; the schema does not reject it. */
export function directPublicHttpWarning(url: string): string | null {
  const parsed = parseHttpHost(url.trim());
  if (!parsed || parsed.protocol !== "http:") return null;
  if (isPrivateOrLoopback(parsed.hostname)) return null;
  return "This http address is public. The pairing code and token would travel without encryption.";
}

export function platformLabel(platform: string): string {
  switch (platform) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return "Other";
  }
}

export function formatWhen(iso: string | null): string {
  if (!iso) return "Never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Never";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function unreachableCopy(label: string): string {
  return `Can't reach ${label}. Retrying…`;
}

/**
 * Display names for a list of devices. Two machines often share a host name; those get a
 * short id suffix, "Mac (3f9a)", so they can be told apart. Unique names are left alone.
 */
const nameKey = (name: string) => name.trim().toLowerCase();

export function disambiguateNames(
  items: readonly { id: string; name: string }[],
): Map<string, string> {
  const groups = new Map<string, { id: string; name: string }[]>();
  for (const item of items) {
    const group = groups.get(nameKey(item.name)) ?? [];
    group.push(item);
    groups.set(nameKey(item.name), group);
  }
  const names = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.length === 1) {
      const only = group[0];
      if (only) names.set(only.id, only.name);
      continue;
    }
    // The shortest id prefix (at least 4 characters) that tells every duplicate apart.
    const longest = Math.max(...group.map((item) => item.id.length));
    let length = 4;
    while (
      length < longest &&
      new Set(group.map((item) => item.id.slice(0, length))).size < group.length
    ) {
      length += 1;
    }
    for (const item of group) names.set(item.id, `${item.name} (${item.id.slice(0, length)})`);
  }
  return names;
}
