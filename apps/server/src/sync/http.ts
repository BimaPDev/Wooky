import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream";
import type { SyncEngine } from "./engine.ts";
import type { AuthenticateRequest } from "../remote/auth.ts";

function reply(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/**
 * `/sync/*` routes for peers. Returns true when the request was one of ours (answered or
 * rejected), false to let the next handler have it. Every route is authenticated first.
 */
export function createSyncRoutes(engine: SyncEngine, authenticate: AuthenticateRequest) {
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/sync/")) return false;
    // Loopback is `local`, not a device: peers must present a live device token.
    const caller = authenticate(req);
    if (!caller || caller.deviceId === "local") {
      reply(res, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "GET") {
      reply(res, 405, { error: "method not allowed" });
      return true;
    }
    if (url.pathname === "/sync/projects") {
      if (!engine.servesProjects(caller.deviceId)) {
        reply(res, 403, { error: "this device does not sync with you" });
        return true;
      }
      engine.projects().then(
        (projects) => reply(res, 200, { projects }),
        () => reply(res, 500, { error: "could not read projects" }),
      );
      return true;
    }
    if (!engine.servesPeer(caller.deviceId)) {
      reply(res, 403, { error: "this device does not sync with you" });
      return true;
    }
    if (url.pathname === "/sync/tips") {
      engine.tips().then(
        (tips) => reply(res, 200, tips),
        () => reply(res, 500, { error: "could not read tips" }),
      );
      return true;
    }
    if (url.pathname === "/sync/bundle") {
      const project = url.searchParams.get("project");
      if (!project) {
        reply(res, 400, { error: "project is required" });
        return true;
      }
      engine.openBundle(project, url.searchParams.get("have")).then(
        (bundle) => {
          if (!bundle) return reply(res, 404, { error: "no snapshots for that project" });
          if (bundle.empty) {
            res.writeHead(204);
            return res.end();
          }
          res.writeHead(200, { "content-type": "application/octet-stream" });
          res.on("close", () => {
            if (!res.writableFinished) bundle.kill();
          });
          pipeline(bundle.stdout, res, () => {});
        },
        () => reply(res, 500, { error: "could not create the bundle" }),
      );
      return true;
    }
    reply(res, 404, { error: "not found" });
    return true;
  };
}
