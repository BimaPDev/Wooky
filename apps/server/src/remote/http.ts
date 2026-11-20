import type { IncomingMessage, ServerResponse } from "node:http";
import { extname } from "node:path";
import { isLoopbackAddress, type AuthenticateRequest } from "./auth.ts";
import type { PairOutcome } from "./pairing.ts";

const PAIR_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pair this device</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #141412; color: #f4f1ea; font: 16px/1.45 "Iowan Old Style", Palatino, serif; }
  form { width: min(24rem, calc(100% - 2rem)); display: grid; gap: 0.75rem; }
  h1 { font-size: 1.4rem; font-weight: 500; margin: 0; }
  p { margin: 0; color: #c8c2b4; }
  label { display: grid; gap: 0.3rem; font-size: 0.85rem; }
  input { font: inherit; padding: 0.55rem 0.7rem; border: 1px solid #3a3832;
    background: #1c1c19; color: inherit; border-radius: 6px; }
  button { font: inherit; padding: 0.6rem 0.8rem; border: 0; border-radius: 6px;
    background: #d7c9a7; color: #1a1814; }
  button:disabled { opacity: 0.6; }
  .error { color: #f07178; }
</style>
</head>
<body>
<form id="pair">
  <h1>Pair this device</h1>
  <p>Enter the code shown on the computer that is hosting Wooky.</p>
  <label>Code <input name="code" autocomplete="one-time-code" required></label>
  <label>Name <input name="name" value="Browser" required></label>
  <button type="submit">Pair</button>
  <p id="status" role="status"></p>
</form>
<script>
  const form = document.getElementById("pair");
  const status = document.getElementById("status");
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  if (code) form.elements.code.value = code;
  const key = "wooky.pairDeviceId";
  let deviceId = localStorage.getItem(key);
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    localStorage.setItem(key, deviceId);
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    status.className = "";
    status.textContent = "Pairing…";
    form.querySelector("button").disabled = true;
    try {
      const response = await fetch("/pair", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: form.elements.code.value,
          device: { deviceId, name: form.elements.name.value, platform: "other", version: "0.0.0" }
        })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Pairing failed.");
      status.textContent = "Paired with " + (body.host && body.host.name ? body.host.name : "this host") + ".";
    } catch (error) {
      status.className = "error";
      status.textContent = error instanceof Error ? error.message : "Pairing failed.";
    } finally {
      form.querySelector("button").disabled = false;
    }
  });
</script>
</body>
</html>
`;

function readBody(req: IncomingMessage, limit = 65_536): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve(undefined);
      }
    });
    req.on("error", reject);
  });
}

function requestSecure(req: IncomingMessage): boolean {
  if ("encrypted" in req.socket && req.socket.encrypted === true) return true;
  const forwarded = req.headers["x-forwarded-proto"];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const proto = value?.split(",")[0]?.trim().toLowerCase();
  return proto === "https" && isLoopbackAddress(req.socket.remoteAddress);
}

function cookie(token: string, secure: boolean): string {
  const parts = [`wooky_token=${token}`, "HttpOnly", "SameSite=Strict", "Path=/"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    ...extra,
  });
  res.end(payload);
}

const PUBLIC_ASSET_EXT = new Set([
  ".js",
  ".mjs",
  ".css",
  ".map",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".wasm",
  ".webmanifest",
]);

/** The UI shell holds no user data. Data routes stay authenticated. */
export function isPublicShell(method: string, pathname: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  if (
    pathname === "/healthz" ||
    pathname === "/ws" ||
    pathname === "/sync" ||
    pathname.startsWith("/sync/")
  ) {
    return false;
  }
  if (pathname === "/" || pathname === "/index.html") return true;
  if (pathname.endsWith("/manifest.json")) return true;
  const ext = extname(pathname).toLowerCase();
  if (PUBLIC_ASSET_EXT.has(ext)) return true;
  return ext.length === 0;
}

export function createGuardedHandler(options: {
  authenticateRequest: AuthenticateRequest;
  addressOf: (req: IncomingMessage) => string | undefined;
  redeem: (raw: unknown, remoteAddress: string) => PairOutcome;
  staticHandler: (req: IncomingMessage, res: ServerResponse) => void;
}): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "POST" && url.pathname === "/pair") {
      void handlePair(req, res);
      return;
    }
    if (
      (req.method === "GET" || req.method === "HEAD") &&
      (url.pathname === "/pair" || url.pathname === "/pair/")
    ) {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(req.method === "HEAD" ? undefined : PAIR_PAGE);
      return;
    }
    if (isPublicShell(req.method ?? "GET", url.pathname)) {
      options.staticHandler(req, res);
      return;
    }
    if (!options.authenticateRequest(req)) {
      res.writeHead(401, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end("Unauthorized");
      return;
    }
    options.staticHandler(req, res);
  };

  async function handlePair(req: IncomingMessage, res: ServerResponse) {
    const address = options.addressOf(req) ?? "unknown";
    let raw: unknown;
    try {
      raw = await readBody(req);
    } catch {
      sendJson(res, 400, { error: "Expected a pairing code and a device." });
      return;
    }
    const outcome = options.redeem(raw, address);
    if (outcome.status === 200) {
      sendJson(res, 200, outcome.body, {
        "set-cookie": cookie(outcome.token, requestSecure(req)),
      });
      return;
    }
    const headers: Record<string, string> = {};
    if (outcome.status === 429) headers["retry-after"] = "60";
    sendJson(res, outcome.status, outcome.body, headers);
  }
}
