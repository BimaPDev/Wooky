import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import {
  PairingCode,
  PairRequest,
  PairResponse,
  PairedDevice,
  PairedDeviceView,
  type DeviceInfo,
  type HostingSettings,
  type PairedDevice as PairedDeviceRecord,
  type TailscaleStatus,
} from "@wooky/contracts";
import { z } from "zod";
import { ServiceError } from "../errors.ts";
import { writePrivateJson } from "./files.ts";

/** Same alphabet PairingCodeText accepts. */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_TTL_MS = 10 * 60 * 1000;
const FAIL_WINDOW_MS = 60 * 1000;
const BASE_LOCK_MS = 60 * 1000;
const MAX_LOCK_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const GLOBAL_FAILURES = 50;
const GLOBAL_ADDRESSES = 10;
const LAST_SEEN_MS = 60 * 1000;
const MAX_CODES = 20;
const MAX_TRACKED_ADDRESSES = 1000;

const StoreFile = z.object({ devices: z.array(PairedDevice) });

export type PairOutcome =
  | { status: 200; body: PairResponse; token: string }
  | { status: 400 | 401 | 429; body: { error: string } };

function safeEqual(left: Buffer, right: Buffer): boolean {
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

export function firstNonInternalIPv4(): string | null {
  const nets = networkInterfaces();
  for (const entries of Object.values(nets)) {
    for (const entry of entries ?? []) {
      const family = entry.family as string | number;
      if (entry.internal || (family !== "IPv4" && family !== 4)) continue;
      return entry.address;
    }
  }
  return null;
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export function createPairing(options: {
  home: string;
  now?: () => number;
  hostInfo: () => DeviceInfo;
  listenPort: () => number;
  /** Hosts the server is listening on right now. */
  listenAddresses: () => string[];
  hosting: () => Pick<HostingSettings, "enabled" | "bind" | "tailscaleServe">;
  tailscaleStatus: () => Promise<Pick<TailscaleStatus, "hostName">>;
  onRevoke: (deviceId: string) => void;
}) {
  const now = options.now ?? Date.now;
  const path = join(options.home, "paired-devices.json");
  let devices = readDevices();
  const codes = new Map<string, number>();
  const failures = new Map<string, { recent: number[]; strikes: number; lockedUntil: number }>();
  const globalFailures: { at: number; address: string }[] = [];
  let globalLockedUntil = 0;

  function readDevices(): PairedDeviceRecord[] {
    try {
      const parsed = StoreFile.safeParse(JSON.parse(readFileSync(path, "utf8")));
      return parsed.success ? parsed.data.devices : [];
    } catch {
      return [];
    }
  }

  function save(): void {
    writePrivateJson(path, { devices });
  }

  function generateCode(): string {
    let code = "";
    const limit = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
    while (code.length < 8) {
      const byte = randomBytes(1)[0] ?? 0;
      if (byte >= limit) continue;
      code += ALPHABET[byte % ALPHABET.length] ?? "";
    }
    return code;
  }

  /**
   * A URL another device can actually reach, or null with the reason there is none.
   * Only addresses the server really listens on are advertised: a LAN IP while the
   * server is bound to loopback would be a dead link.
   */
  async function reachableUrl(): Promise<{ url: string | null; reason: string | null }> {
    const hosting = options.hosting();
    const port = options.listenPort();
    const hosts = options.listenAddresses().filter((host) => !isLoopbackHost(host));
    if (hosts.length === 0) {
      return {
        url: null,
        reason: hosting.enabled
          ? "Hosting is limited to this machine. Allow your tailnet or your network under Settings → Anywhere → Hosting, then show a code again."
          : "Hosting is off. Turn on Accept remote clients under Settings → Anywhere → Hosting before pairing another device.",
      };
    }
    if (hosting.bind === "tailscale") {
      const status = await options.tailscaleStatus();
      if (status.hostName) {
        if (hosting.tailscaleServe) return { url: `https://${status.hostName}`, reason: null };
        return { url: `http://${status.hostName}:${port}`, reason: null };
      }
    }
    const wildcard = hosts.some((host) => host === "0.0.0.0" || host === "::");
    const host = wildcard ? firstNonInternalIPv4() : hosts[0];
    if (!host) return { url: null, reason: "This machine has no network address to pair over." };
    return { url: `http://${host.includes(":") ? `[${host}]` : host}:${port}`, reason: null };
  }

  async function create(): Promise<PairingCode> {
    const at = now();
    for (const [code, expiresAt] of codes) {
      if (expiresAt <= at) codes.delete(code);
    }
    while (codes.size >= MAX_CODES) {
      const oldest = [...codes.entries()].sort((a, b) => a[1] - b[1])[0];
      if (!oldest) break;
      codes.delete(oldest[0]);
    }
    const code = generateCode();
    const expiresAt = at + CODE_TTL_MS;
    codes.set(code, expiresAt);
    return PairingCode.parse({
      code,
      expiresAt: new Date(expiresAt).toISOString(),
      ...(await reachableUrl()),
    });
  }

  function consumeCode(presented: string): boolean {
    const presentedBuf = Buffer.from(presented);
    let matched = false;
    const drop: string[] = [];
    if (codes.size === 0) safeEqual(presentedBuf, Buffer.alloc(presentedBuf.length));
    for (const [code, expiresAt] of codes) {
      if (!safeEqual(presentedBuf, Buffer.from(code))) continue;
      if (expiresAt <= now()) drop.push(code);
      else if (!matched) {
        matched = true;
        drop.push(code);
      }
    }
    for (const code of drop) codes.delete(code);
    return matched;
  }

  function lockMs(strikes: number): number {
    return Math.min(BASE_LOCK_MS * 2 ** Math.max(0, strikes - 1), MAX_LOCK_MS);
  }

  function locked(address: string): boolean {
    const at = now();
    if (at < globalLockedUntil) return true;
    const entry = failures.get(address);
    return entry !== undefined && at < entry.lockedUntil;
  }

  function noteFailure(address: string): void {
    const at = now();
    if (failures.size >= MAX_TRACKED_ADDRESSES) {
      for (const [key, value] of failures) {
        if (
          at >= value.lockedUntil &&
          value.recent.every((stamp) => at - stamp >= FAIL_WINDOW_MS)
        ) {
          failures.delete(key);
        }
      }
    }
    const entry = failures.get(address) ?? { recent: [], strikes: 0, lockedUntil: 0 };
    entry.recent = entry.recent.filter((stamp) => at - stamp < FAIL_WINDOW_MS);
    entry.recent.push(at);
    failures.set(address, entry);
    while (globalFailures.length > 0 && at - (globalFailures[0]?.at ?? at) >= FAIL_WINDOW_MS) {
      globalFailures.shift();
    }
    globalFailures.push({ at, address });
    const distinct = new Set(globalFailures.map((failure) => failure.address));
    if (globalFailures.length >= GLOBAL_FAILURES && distinct.size >= GLOBAL_ADDRESSES) {
      globalLockedUntil = at + BASE_LOCK_MS;
    }
    if (entry.recent.length >= MAX_FAILURES) {
      entry.strikes += 1;
      entry.lockedUntil = at + lockMs(entry.strikes);
      entry.recent = [];
    }
  }

  function lockBody(): PairOutcome {
    return { status: 429, body: { error: "Pairing is locked. Try again shortly." } };
  }

  function redeem(raw: unknown, remoteAddress: string): PairOutcome {
    if (locked(remoteAddress)) return lockBody();
    const parsed = PairRequest.safeParse(raw);
    if (!parsed.success) {
      noteFailure(remoteAddress);
      if (locked(remoteAddress)) return lockBody();
      return { status: 400, body: { error: "Expected a pairing code and a device." } };
    }
    if (!consumeCode(parsed.data.code)) {
      noteFailure(remoteAddress);
      if (locked(remoteAddress)) return lockBody();
      return { status: 401, body: { error: "That pairing code is not valid." } };
    }
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const at = new Date(now()).toISOString();
    const previous = devices.find((device) => device.deviceId === parsed.data.device.deviceId);
    const record: PairedDeviceRecord = {
      deviceId: parsed.data.device.deviceId,
      name: parsed.data.device.name,
      platform: parsed.data.device.platform,
      pairedAt: previous?.pairedAt ?? at,
      lastSeenAt: null,
      tokenHash,
      revoked: false,
    };
    if (previous && !previous.revoked) options.onRevoke(record.deviceId);
    devices = devices.filter((device) => device.deviceId !== record.deviceId).concat(record);
    save();
    return {
      status: 200,
      token,
      body: PairResponse.parse({ token, host: options.hostInfo() }),
    };
  }

  function lookup(token: string): string | null {
    const hash = Buffer.from(createHash("sha256").update(token).digest("hex"));
    let found: PairedDeviceRecord | null = null;
    for (const device of devices) {
      const stored = Buffer.from(device.tokenHash);
      if (stored.length === hash.length && timingSafeEqual(stored, hash) && !device.revoked) {
        found = device;
      }
    }
    if (!found) return null;
    const at = now();
    const seen = found.lastSeenAt ? Date.parse(found.lastSeenAt) : Number.NaN;
    if (!Number.isFinite(seen) || at - seen >= LAST_SEEN_MS) {
      found.lastSeenAt = new Date(at).toISOString();
      save();
    }
    return found.deviceId;
  }

  function view(device: PairedDeviceRecord): PairedDeviceView {
    return PairedDeviceView.parse(device);
  }

  function list(): PairedDeviceView[] {
    return devices.map(view);
  }

  function revoke(deviceId: string): { ok: true } {
    const device = devices.find((item) => item.deviceId === deviceId);
    if (!device) throw new ServiceError("not_found", `No paired device ${deviceId}.`);
    device.revoked = true;
    save();
    options.onRevoke(deviceId);
    return { ok: true };
  }

  function rename(deviceId: string, name: string): PairedDeviceView {
    const device = devices.find((item) => item.deviceId === deviceId);
    if (!device) throw new ServiceError("not_found", `No paired device ${deviceId}.`);
    device.name = name;
    save();
    return view(device);
  }

  return { create, redeem, lookup, list, revoke, rename, path };
}
