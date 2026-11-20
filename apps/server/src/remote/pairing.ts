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
const LOCKOUT_MS = 60 * 1000;
const MAX_FAILURES = 5;
const LAST_SEEN_MS = 60 * 1000;
const MAX_CODES = 20;

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

export function createPairing(options: {
  home: string;
  now?: () => number;
  hostInfo: () => DeviceInfo;
  listenPort: () => number;
  hosting: () => Pick<HostingSettings, "enabled" | "bind" | "tailscaleServe">;
  tailscaleStatus: () => Promise<Pick<TailscaleStatus, "hostName">>;
  onRevoke: (deviceId: string) => void;
}) {
  const now = options.now ?? Date.now;
  const path = join(options.home, "paired-devices.json");
  let devices = readDevices();
  const codes = new Map<string, number>();
  const failures = new Map<string, number[]>();
  let lockedUntil = 0;

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

  async function baseUrl(): Promise<string> {
    const hosting = options.hosting();
    const port = options.listenPort();
    if (hosting.enabled && hosting.bind === "tailscale") {
      const status = await options.tailscaleStatus();
      if (status.hostName) {
        if (hosting.tailscaleServe) return `https://${status.hostName}`;
        return `http://${status.hostName}:${port}`;
      }
    }
    const ip = firstNonInternalIPv4() ?? "127.0.0.1";
    return `http://${ip}:${port}`;
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
      url: await baseUrl(),
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

  function locked(): boolean {
    return now() < lockedUntil;
  }

  function noteFailure(address: string): void {
    const at = now();
    const recent = (failures.get(address) ?? []).filter((stamp) => at - stamp < FAIL_WINDOW_MS);
    recent.push(at);
    failures.set(address, recent);
    if (recent.length >= MAX_FAILURES) {
      lockedUntil = at + LOCKOUT_MS;
      failures.clear();
    }
  }

  function lockBody(): PairOutcome {
    return { status: 429, body: { error: "Pairing is locked. Try again in a minute." } };
  }

  function redeem(raw: unknown, remoteAddress: string): PairOutcome {
    if (locked()) return lockBody();
    const parsed = PairRequest.safeParse(raw);
    if (!parsed.success) {
      noteFailure(remoteAddress);
      if (locked()) return lockBody();
      return { status: 400, body: { error: "Expected a pairing code and a device." } };
    }
    if (!consumeCode(parsed.data.code)) {
      noteFailure(remoteAddress);
      if (locked()) return lockBody();
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
