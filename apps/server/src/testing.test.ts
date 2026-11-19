import { describe, expect, it } from "vitest";
import type { PendingEvent } from "@wooky/contracts";
import { openEventStore, type EventStore } from "./store/event-store.ts";
import { tempDir, waitForEvent } from "./testing.ts";

const at = "2026-01-01T00:00:00.000Z";
const added: PendingEvent = {
  type: "project.added",
  commandId: null,
  project: { id: "p1", name: "p", root: "/p", createdAt: at },
};

describe("waitForEvent", () => {
  it("sees an event that lands while it scans the history", async () => {
    const store = openEventStore(await tempDir("wait"), () => at);
    const racy: EventStore = Object.create(store);
    racy.eventsAfter = (seq) => {
      const history = store.eventsAfter(seq);
      store.appendInternal([added]);
      return history;
    };
    expect(await waitForEvent(racy, "project.added")).toMatchObject({ seq: 1 });
    store.close();
  });
});
