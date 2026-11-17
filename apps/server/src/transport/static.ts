import { createReadStream, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

/** Plain HTTP: health check plus the built web UI with SPA fallback. */
export function createHttpHandler(webDist: string | null) {
  const root = webDist ? resolve(webDist) : null;
  return (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz") return send(res, 200, "ok");
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");
    if (!root) return send(res, 404, "Not found");

    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return send(res, 400, "Bad request");
    }
    const file = resolve(root, `.${pathname}`);
    if (file !== root && !file.startsWith(root + sep)) return send(res, 404, "Not found");
    if (isFile(file)) return serveFile(req, res, file);
    // Unknown asset paths 404; anything else is a client-side route.
    if (extname(pathname)) return send(res, 404, "Not found");
    const index = join(root, "index.html");
    if (isFile(index)) return serveFile(req, res, index);
    return send(res, 404, "Not found");
  };
}

function serveFile(req: IncomingMessage, res: ServerResponse, file: string) {
  const isHtml = extname(file) === ".html";
  res.writeHead(200, {
    "content-type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    "cache-control": isHtml ? "no-cache" : "public, max-age=3600",
  });
  if (req.method === "HEAD") return res.end();
  createReadStream(file)
    .on("error", () => res.destroy())
    .pipe(res);
}

function send(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
