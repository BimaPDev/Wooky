import type { IncomingMessage, ServerResponse } from "node:http";
import type { DeviceSettings } from "@wooky/contracts";
import type { ThemeStore } from "../settings/themes.ts";
import type { ReplicaService } from "./replicas.ts";
import { exportSettingsForSync, themeExportPayload } from "./settings-sync.ts";
import type { AuthenticateRequest } from "./types.ts";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
}

export function createTransferHttpHandler(deps: {
  authenticate: AuthenticateRequest;
  replicas: ReplicaService;
  themes: ThemeStore;
  deviceId: string;
  settings: () => DeviceSettings;
  now: () => string;
}): (req: IncomingMessage, res: ServerResponse) => boolean {
  return (req, res) => {
    if (req.method !== "GET" || !req.url) return false;
    const url = new URL(req.url, "http://localhost");
    const deviceId = deps.authenticate(req);
    if (!deviceId) {
      sendText(res, 401, "Unauthorized");
      return true;
    }

    const settings = deps.settings();

    if (url.pathname === "/sync/threads") {
      if (!settings.sync.enabled || !settings.sync.categories.threads) {
        sendJson(res, 200, { events: [], nextSince: Number(url.searchParams.get("since") ?? 0) });
        return true;
      }
      if (!settings.sync.peers.includes(deviceId)) {
        sendText(res, 403, "Forbidden");
        return true;
      }
      const since = Number(url.searchParams.get("since") ?? 0);
      try {
        const batch = deps.replicas.ownerBatch(since, deviceId);
        sendJson(res, 200, batch);
      } catch {
        sendText(res, 403, "Forbidden");
      }
      return true;
    }

    if (url.pathname === "/sync/settings") {
      if (!settings.sync.enabled || !settings.sync.categories.settings) {
        sendJson(res, 200, { values: {}, stamps: {} });
        return true;
      }
      if (!settings.sync.peers.includes(deviceId)) {
        sendText(res, 403, "Forbidden");
        return true;
      }
      const payload = exportSettingsForSync(
        deps.themes.home,
        deps.deviceId,
        deps.themes.getSettings(),
        deps.now(),
      );
      sendJson(res, 200, payload);
      return true;
    }

    if (url.pathname === "/sync/themes") {
      if (!settings.sync.enabled || !settings.sync.categories.themes) {
        sendJson(res, 200, { themes: [] });
        return true;
      }
      if (!settings.sync.peers.includes(deviceId)) {
        sendText(res, 403, "Forbidden");
        return true;
      }
      sendJson(res, 200, { themes: themeExportPayload(deps.themes) });
      return true;
    }

    return false;
  };
}
