import type { TailscaleStatus } from "@wooky/contracts";
import { findTailscale, runArgv } from "../process/tailscale-cli.ts";

const TIMEOUT_MS = 3_000;

export function parseTailscaleStatus(raw: unknown): TailscaleStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as {
    BackendState?: unknown;
    Self?: { DNSName?: unknown; TailscaleIPs?: unknown };
  };
  const dns = typeof record.Self?.DNSName === "string" ? record.Self.DNSName.replace(/\.$/, "") : "";
  const ips = Array.isArray(record.Self?.TailscaleIPs)
    ? record.Self.TailscaleIPs.filter((ip): ip is string => typeof ip === "string")
    : [];
  return {
    installed: true,
    running: record.BackendState === "Running",
    hostName: dns.length > 0 ? dns : null,
    ips,
  };
}

export interface TailscaleReport extends TailscaleStatus {
  serveError?: string;
}

export function createTailscale(options: { timeoutMs?: number } = {}) {
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  let serveError: string | undefined;

  function withServeError(status: TailscaleStatus): TailscaleReport {
    return serveError ? { ...status, serveError } : status;
  }

  async function status(): Promise<TailscaleReport> {
    const bin = findTailscale();
    if (!bin) return withServeError({ installed: false, running: false, hostName: null, ips: [] });
    const result = await runArgv(bin, ["status", "--json"], timeoutMs);
    if (result.timedOut || result.code !== 0) {
      return withServeError({ installed: true, running: false, hostName: null, ips: [] });
    }
    try {
      const parsed = parseTailscaleStatus(JSON.parse(result.stdout));
      if (!parsed) return withServeError({ installed: true, running: false, hostName: null, ips: [] });
      return withServeError(parsed);
    } catch {
      return withServeError({ installed: true, running: false, hostName: null, ips: [] });
    }
  }

  async function serve(port: number): Promise<void> {
    const bin = findTailscale();
    if (!bin) {
      serveError = "tailscale is not installed";
      console.error(`tailscale serve: ${serveError}`);
      return;
    }
    const result = await runArgv(
      bin,
      ["serve", "--bg", "--https=443", `http://127.0.0.1:${port}`],
      timeoutMs,
    );
    if (result.code === 0 && !result.timedOut) {
      serveError = undefined;
      return;
    }
    serveError = result.stderr.trim() || result.stdout.trim() || "tailscale serve failed";
    console.error(`tailscale serve: ${serveError}`);
  }

  async function serveOff(): Promise<void> {
    const bin = findTailscale();
    if (!bin) return;
    const result = await runArgv(bin, ["serve", "--https=443", "off"], timeoutMs);
    if (result.code === 0 && !result.timedOut) {
      serveError = undefined;
      return;
    }
    serveError = result.stderr.trim() || "tailscale serve off failed";
    console.error(`tailscale serve: ${serveError}`);
  }

  return { status, serve, serveOff };
}
