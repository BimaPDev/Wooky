import { z } from "zod";

/** Stable id of one Wooky install. Created once and stored in device.json. */
export const DeviceId = z.string().min(1);
export type DeviceId = z.infer<typeof DeviceId>;

export const DevicePlatform = z.enum(["darwin", "win32", "linux", "other"]);
export type DevicePlatform = z.infer<typeof DevicePlatform>;

export const DeviceInfo = z.object({
  deviceId: DeviceId,
  name: z.string().min(1),
  platform: DevicePlatform,
  version: z.string().min(1),
});
export type DeviceInfo = z.infer<typeof DeviceInfo>;

/**
 * Plain http is only safe on a host the user already trusts: loopback, RFC1918,
 * the tailnet CGNAT range, or a MagicDNS name. Public hosts must be https.
 */
const PAIRING_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const PAIRING_CODE_PATTERN = new RegExp(`^[${PAIRING_ALPHABET}]{8}$`);

export const PairingCodeText = z.string().transform((value, ctx) => {
  const code = value.toUpperCase();
  if (!PAIRING_CODE_PATTERN.test(code)) {
    ctx.addIssue({ code: "custom", message: "Expected an 8-character pairing code" });
    return z.NEVER;
  }
  return code;
});
export type PairingCodeText = z.infer<typeof PairingCodeText>;

/** Protocol and host only. Contracts cannot use the DOM `URL` type. */
export function parseHttpUrl(
  value: string,
): { protocol: "http:" | "https:"; hostname: string; userinfo: boolean } | null {
  const match = /^(https?):\/\/([^/?#]*)/i.exec(value);
  if (!match) return null;
  const protocol = match[1]?.toLowerCase() === "https" ? "https:" : "http:";
  let authority = match[2] ?? "";
  const at = authority.lastIndexOf("@");
  const userinfo = at >= 0;
  if (userinfo) authority = authority.slice(at + 1);
  let hostname: string;
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    if (end < 1) return null;
    hostname = authority.slice(1, end);
  } else {
    hostname = authority.split(":")[0] ?? "";
  }
  if (!hostname) return null;
  return { protocol, hostname, userinfo };
}

function isHttpUrl(value: string): boolean {
  const url = parseHttpUrl(value);
  return url !== null && !url.userinfo;
}

/** First hextet of an IPv6 address, or null when the text is not one. */
function firstHextet(host: string): number | null {
  if (host.startsWith("::")) return 0;
  const head = host.split(":")[0] ?? "";
  if (!/^[0-9a-f]{1,4}$/.test(head)) return null;
  return Number.parseInt(head, 16);
}

function isIpv6Private(host: string): boolean {
  const bare = host.split("%")[0] ?? host;
  const first = firstHextet(bare);
  if (first === null) return false;
  if (first >= 0xfd00 && first <= 0xfdff) return true;
  return first >= 0xfe80 && first <= 0xfebf;
}

function isPrivateOrLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1") return true;
  if (host.endsWith(".ts.net")) return true;
  if (host.includes(":") && isIpv6Private(host)) return true;

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

/** `url` connections: https anywhere, http only on loopback, private, tailnet, or *.ts.net. */
function isAllowedUrlConnection(value: string): boolean {
  const url = parseHttpUrl(value);
  if (!url || url.userinfo) return false;
  if (url.protocol === "https:") return true;
  return isPrivateOrLoopbackHost(url.hostname);
}

const HttpUrl = z.string().min(1).refine(isHttpUrl, "Expected an http(s) URL");

const UrlConnection = z
  .string()
  .min(1)
  .refine(
    isAllowedUrlConnection,
    "http is only allowed for localhost, private addresses, tailnet ranges, and .ts.net hosts",
  );

const Port = z.number().int().min(1).max(65535);

export const RemoteConnection = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("tailscale"),
    /** MagicDNS name from `tailscale status --json`. */
    hostName: z.string().min(1),
    port: Port,
    https: z.boolean(),
  }),
  z.object({
    kind: z.literal("direct"),
    url: HttpUrl,
  }),
  z.object({
    kind: z.literal("url"),
    url: UrlConnection,
  }),
  z.object({
    kind: z.literal("ssh"),
    /** `user@host` passed to `ssh -N -L`. No leading dash, so it cannot be an ssh option. */
    target: z
      .string()
      .regex(/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$/, "Expected user@host")
      .refine((value) => !value.startsWith("-"), "Target must not start with -"),
    remotePort: Port,
    localPort: Port.optional(),
    identityFile: z
      .string()
      .min(1)
      .refine((value) => !value.startsWith("-"), "Identity file must not start with -")
      .optional(),
  }),
]);
export type RemoteConnection = z.infer<typeof RemoteConnection>;

/** A Wooky server the client can switch to. The local server is not stored here. */
export const Environment = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  deviceId: DeviceId.optional(),
  connection: RemoteConnection,
  addedAt: z.string(),
});
export type Environment = z.infer<typeof Environment>;

export const PairedDevice = z.object({
  deviceId: DeviceId,
  name: z.string().min(1),
  platform: DevicePlatform,
  pairedAt: z.string(),
  lastSeenAt: z.string().nullable(),
  /** SHA-256 of the device token. The token itself is never stored. */
  tokenHash: z.string().min(1),
  revoked: z.boolean(),
});
export type PairedDevice = z.infer<typeof PairedDevice>;

/** What RPCs return. The token hash stays on the host. */
export const PairedDeviceView = PairedDevice.omit({ tokenHash: true });
export type PairedDeviceView = z.infer<typeof PairedDeviceView>;

export const PairingCode = z.object({
  code: PairingCodeText,
  expiresAt: z.string(),
  /** Host URL the client pairs against. */
  url: z.string().min(1),
});
export type PairingCode = z.infer<typeof PairingCode>;

/** Where this device accepts remote clients. Off until the user enables it. Default port matches WOOKY_DEFAULT_PORT. */
export const HostingSettings = z
  .object({
    enabled: z.boolean().default(false),
    bind: z.enum(["loopback", "tailscale", "all"]).default("tailscale"),
    port: Port.default(4317),
    tailscaleServe: z.boolean().default(false),
  })
  .default({
    enabled: false,
    bind: "tailscale",
    port: 4317,
    tailscaleServe: false,
  });
export type HostingSettings = z.infer<typeof HostingSettings>;

/** Body of the unauthenticated `POST /pair`. */
export const PairRequest = z.object({
  code: PairingCodeText,
  device: DeviceInfo,
});
export type PairRequest = z.infer<typeof PairRequest>;

export const PairResponse = z.object({
  token: z.string().min(1),
  host: DeviceInfo,
});
export type PairResponse = z.infer<typeof PairResponse>;

export const TailscaleStatus = z.object({
  installed: z.boolean(),
  running: z.boolean(),
  hostName: z.string().nullable(),
  ips: z.array(z.string()),
});
export type TailscaleStatus = z.infer<typeof TailscaleStatus>;
