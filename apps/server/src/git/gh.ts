import { spawn } from "node:child_process";
import type { PullRequest, PullRequestState } from "@wooky/contracts";
import { resolveCommand, type ResolvedCommand } from "../process/resolve-command.ts";

export const GH_AUTH_CACHE_MS = 60_000;
const DEFAULT_GH_TIMEOUT_MS = 60_000;

export type GhRunResult = { stdout: string; stderr: string; code: number | null };

export interface GhClient {
  available(): boolean;
  authStatus(hostname: string): Promise<boolean>;
  run(
    args: string[],
    opts?: { cwd?: string; input?: string; timeoutMs?: number; allowFail?: boolean },
  ): Promise<GhRunResult>;
  mapPrView(json: GhPrViewJson): Pick<PullRequest, "url" | "number" | "state" | "branch">;
}

export type GhPrViewJson = {
  url: string;
  number: number;
  state: string;
  headRefName: string;
  mergedAt?: string | null;
};

type ResolveGh = (name: string) => ResolvedCommand | null;

export function createGhClient(options?: {
  resolveGh?: ResolveGh;
  ghName?: string;
  timeoutMs?: number;
}): GhClient {
  const resolveGh = options?.resolveGh ?? ((name) => resolveCommand(name));
  const ghName = options?.ghName ?? (process.platform === "win32" ? "gh.exe" : "gh");
  const timeoutMs = options?.timeoutMs ?? DEFAULT_GH_TIMEOUT_MS;
  const resolved = resolveGh(ghName);
  const authCache = new Map<string, { at: number; ok: boolean }>();

  async function run(
    args: string[],
    opts: {
      cwd?: string;
      input?: string;
      timeoutMs?: number;
      allowFail?: boolean;
    } = {},
  ): Promise<GhRunResult> {
    if (!resolved) {
      return { stdout: "", stderr: "gh is not installed", code: 1 };
    }
    const argv = [...resolved.prefixArgs, ...args];
    const limit = opts.timeoutMs ?? timeoutMs;
    const result = await new Promise<GhRunResult>((resolvePromise) => {
      let settled = false;
      const done = (value: GhRunResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise(value);
      };
      const child = spawn(resolved.command, argv, {
        cwd: opts.cwd,
        env: process.env,
        windowsHide: true,
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
      child.on("error", () => done({ stdout: "", stderr: "Could not run gh", code: 1 }));
      child.on("close", (code) =>
        done({
          stdout: Buffer.concat(out).toString("utf8"),
          stderr: Buffer.concat(err).toString("utf8"),
          code,
        }),
      );
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        done({ stdout: "", stderr: `gh timed out after ${limit}ms`, code: null });
      }, limit);
      if (child.stdin) {
        child.stdin.on("error", () => {});
        if (opts.input !== undefined) child.stdin.write(opts.input);
        child.stdin.end();
      }
    });
    if (result.code !== 0 && !opts.allowFail) {
      const detail = (result.stderr || result.stdout).trim();
      throw new Error(detail || "gh command failed");
    }
    return result;
  }

  return {
    available: () => resolved !== null,

    async authStatus(hostname) {
      if (!resolved) return false;
      const cached = authCache.get(hostname);
      const now = Date.now();
      if (cached && now - cached.at < GH_AUTH_CACHE_MS) return cached.ok;
      const result = await run(["auth", "status", "--hostname", hostname], {
        allowFail: true,
        timeoutMs: 15_000,
      });
      const ok = result.code === 0;
      authCache.set(hostname, { at: now, ok });
      return ok;
    },

    run,

    mapPrView(json) {
      return {
        url: json.url,
        number: json.number,
        state: mapPrState(json.state, json.mergedAt),
        branch: json.headRefName,
      };
    },
  };
}

function mapPrState(state: string, mergedAt?: string | null): PullRequestState {
  const upper = state.toUpperCase();
  if (upper === "MERGED" || mergedAt) return "merged";
  if (upper === "CLOSED") return "closed";
  return "open";
}
