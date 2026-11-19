import { describe, expect, it } from "vitest";
import { AgeEvent, ReadModel } from "@age/contracts";
import { legacyLog, legacyReadModel } from "./legacy-log.fixture.ts";
import { applyEvents, emptyReadModel } from "./project.ts";
import {
  childrenOf,
  fleetRows,
  groupThreads,
  latestPlan,
  pendingQuestions,
  queuedPrompts,
  resumePoint,
  reviewNotesFor,
} from "./selectors.ts";

describe("an event log written before the P0 contracts", () => {
  it("decodes and replays to the read model its own reducer built", () => {
    const events = legacyLog.map((row) => AgeEvent.parse(row));
    const replayed = applyEvents(emptyReadModel(), events);

    // An old snapshot (web client against an older server) decodes to the same model.
    expect(replayed).toEqual(ReadModel.parse(legacyReadModel));
    expect(JSON.parse(JSON.stringify(replayed))).toEqual(
      withEmptyQueues(legacyReadModel as LegacyModel),
    );
  });

  it("answers the new selectors with neutral values", () => {
    const model = applyEvents(
      emptyReadModel(),
      legacyLog.map((row) => AgeEvent.parse(row)),
    );
    for (const threadId of Object.keys(model.threads)) {
      expect(queuedPrompts(model, threadId)).toEqual([]);
      expect(pendingQuestions(model, threadId)).toEqual([]);
      expect(latestPlan(model, threadId)).toBeNull();
      expect(resumePoint(model, threadId)).toBeNull();
      expect(childrenOf(model, threadId)).toEqual([]);
      expect(reviewNotesFor(model, threadId)).toEqual([]);
    }
    expect(groupThreads(model, "missing")).toEqual([]);
    expect(fleetRows(model).map((row) => [row.threadId, row.role, row.status])).toEqual([
      ["t2", "solo", "idle"],
      ["t1", "solo", "failed"],
    ]);
  });
});

type LegacyModel = { threads: Record<string, object> } & Record<string, unknown>;

/** Old snapshots gain an empty queue per thread, plus empty fleet maps. */
function withEmptyQueues(model: LegacyModel) {
  const threads = Object.fromEntries(
    Object.entries(model.threads).map(([id, thread]) => [id, { ...thread, queue: [] }]),
  );
  return { ...model, threads, groups: {}, reviewNotes: {} };
}
