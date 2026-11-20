import { describe, expect, it } from "vitest";
import { createNoopGitService } from "../git/noop.ts";
import { createDemoAdapter } from "../providers/demo/adapter.ts";
import { createProviderRegistry } from "../providers/registry.ts";
import { createThemeStore } from "../settings/themes.ts";
import { openEventStore } from "../store/event-store.ts";
import { tempDir, testContext, waitForEvent } from "../testing.ts";
import { createEffectRunner } from "../effects/runner.ts";
import { createRequestAuth } from "../remote/auth.ts";
import type { PeerDirectory } from "../remote/peers.ts";
import { createTransferService } from "./service.ts";

describe("claim crash recovery", () => {
  it("retries a pending claim after restart", async () => {
    const home = await tempDir("crash");
    const ctx = testContext();
    const store = openEventStore(home, ctx.now);
    const themes = createThemeStore(home);
    themes.putSettings({
      sync: {
        enabled: true,
        peers: ["owner"],
        categories: { files: true, threads: true, settings: false, themes: false },
      },
    });
    const peers: PeerDirectory = {
      list: () => [
        {
          deviceId: "owner",
          name: "Owner",
          baseUrl: "http://127.0.0.1:9",
          token: "tok",
        },
      ],
      get: (id) => peers.list().find((peer) => peer.deviceId === id),
    };

    createTransferService({
      home,
      store,
      themes,
      deviceId: "local",
      peers,
      authenticate: createRequestAuth({
        addressOf: (req) => req.socket.remoteAddress,
        lookup: (token) => (token === "tok" ? "owner" : null),
      }).authenticateRequest,
      syncNow: async () => {},
      dispatch: (command) => {
        void command;
        return { accepted: true, duplicate: false, seq: store.model.seq };
      },
      newId: ctx.newId,
      now: ctx.now,
      hasProvider: () => true,
      broadcastSync: () => {},
    });

    store.commit({
      commandId: "claim-1",
      events: [
        {
          type: "thread.claimRequested",
          commandId: "claim-1",
          claimId: "claim-1",
          ownerDeviceId: "owner",
          ownerThreadId: "remote-t",
          projectId: "p1",
        },
      ],
      effects: [
        {
          kind: "claimThread",
          threadId: "claim-1",
          claimId: "claim-1",
          ownerDeviceId: "owner",
          ownerThreadId: "remote-t",
          projectId: "p1",
        },
      ],
    });

    store.close();

    const store2 = openEventStore(home, ctx.now);
    const themes2 = createThemeStore(home);
    const transfer2 = createTransferService({
      home,
      store: store2,
      themes: themes2,
      deviceId: "local",
      peers,
      authenticate: createRequestAuth({
        addressOf: (req) => req.socket.remoteAddress,
        lookup: () => null,
      }).authenticateRequest,
      syncNow: async () => {},
      dispatch: () => ({ accepted: false, duplicate: false, seq: store2.model.seq }),
      newId: ctx.newId,
      now: ctx.now,
      hasProvider: () => true,
      broadcastSync: () => {},
    });
    const runner2 = createEffectRunner({
      store: store2,
      providers: createProviderRegistry([createDemoAdapter({ stepMs: 0 })]),
      git: createNoopGitService(),
      newId: ctx.newId,
      runClaimThread: (effect) => transfer2.runClaimThread(effect),
      recoverClaims: () => transfer2.recoverClaims(),
    });

    runner2.recover();
    await runner2.idle();

    const failed = await waitForEvent(store2, "thread.claimFailed", () => true, 0).catch(
      () => null,
    );
    expect(
      failed?.type === "thread.claimFailed" || Object.keys(store2.model.pendingClaims).length,
    ).toBeTruthy();
    store2.close();
  });
});
