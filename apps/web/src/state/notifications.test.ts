/**
 * @vitest-environment happy-dom
 */
import type { AgeEvent } from "@wooky/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureModel } from "../dev/fixture.ts";
import { receiveEvent, useStore } from "./store.ts";
import {
  noticeForEvent,
  setNotifyPref,
  shouldNotify,
  startNotifications,
  titleWithBadge,
  useNotifyPermission,
  useNotifyPrefs,
  visibleThreadIds,
  type NotifyContext,
} from "./notifications.ts";

const context = (over: Partial<NotifyContext> = {}): NotifyContext => ({
  focused: true,
  visibleThreadIds: ["t1"],
  permission: "granted",
  prefs: { finished: true, needsInput: true, workerReports: true, sound: false },
  ...over,
});

const finished = (threadId: string): AgeEvent => ({
  seq: 1000,
  at: new Date().toISOString(),
  commandId: null,
  type: "turn.finished",
  threadId,
  turnId: "turn-x",
  status: "completed",
  checkpointAfter: null,
  changedFiles: [],
  usage: null,
  error: null,
});

describe("notification policy", () => {
  it("stays quiet when the thread is on screen in a focused window", () => {
    expect(shouldNotify("finished", "t1", context())).toBe(false);
  });

  it("notifies when the window is blurred, even for the visible thread", () => {
    expect(shouldNotify("finished", "t1", context({ focused: false }))).toBe(true);
  });

  it("notifies when the thread is not the one on screen", () => {
    expect(shouldNotify("needsInput", "t2", context())).toBe(true);
  });

  it("respects the per-kind switch and the browser permission", () => {
    const off = { finished: false, needsInput: true, workerReports: true, sound: false };
    expect(shouldNotify("finished", "t2", context({ prefs: off }))).toBe(false);
    expect(shouldNotify("needsInput", "t2", context({ permission: "default" }))).toBe(false);
    expect(shouldNotify("needsInput", "t2", context({ permission: "denied" }))).toBe(false);
  });

  it("describes finished turns, approvals, questions and worker reports", () => {
    const model = fixtureModel;
    expect(noticeForEvent(finished("t1"), model)).toMatchObject({
      kind: "finished",
      threadId: "t1",
    });
    expect(
      noticeForEvent({ ...finished("t1"), status: "interrupted" } as AgeEvent, model),
    ).toBeNull();
    expect(
      noticeForEvent(
        {
          seq: 1,
          at: "",
          commandId: null,
          type: "worker.reported",
          coordinatorThreadId: "t-coord",
          workerThreadId: "t-w1",
          turnId: "x",
          summary: "Done.",
        },
        model,
      ),
    ).toMatchObject({ kind: "workerReport", threadId: "t-coord" });
  });

  it("puts the waiting count in the tab title", () => {
    expect(titleWithBadge("Wooky", 2)).toBe("(2) Wooky");
    expect(titleWithBadge("Wooky", 0)).toBe("Wooky");
  });

  it("counts a split's panes as visible and a full-page view as none", () => {
    const base = {
      selectedThreadId: "t1",
      panes: null,
      model: fixtureModel,
      fleetBoardOpen: false,
      compareGroupId: null,
      settingsOpen: false,
    };
    expect(visibleThreadIds(base)).toEqual(["t1"]);
    expect(visibleThreadIds({ ...base, fleetBoardOpen: true })).toEqual([]);
  });
});

describe("delivery", () => {
  const shown: { title: string; options: NotificationOptions | undefined }[] = [];
  const requestPermission = vi.fn<() => Promise<NotificationPermission>>(() =>
    Promise.resolve("granted"),
  );

  beforeEach(() => {
    shown.length = 0;
    requestPermission.mockClear();
    class FakeNotification {
      static permission: NotificationPermission = "default";
      static requestPermission = requestPermission;
      constructor(title: string, options?: NotificationOptions) {
        shown.push({ title, options });
      }
      addEventListener() {}
      close() {}
    }
    vi.stubGlobal("Notification", FakeNotification);
    useNotifyPermission.setState({ permission: "default" });
    useNotifyPrefs.setState({
      finished: true,
      needsInput: true,
      workerReports: true,
      sound: false,
    });
    useStore.setState({ model: fixtureModel, selectedThreadId: "t1", fleetBoardOpen: false });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("never asks for permission on load or when events arrive, only from the toggle", async () => {
    startNotifications();
    receiveEvent(finished("t2"));
    expect(requestPermission).not.toHaveBeenCalled();
    expect(shown).toHaveLength(0);

    useNotifyPrefs.setState({ finished: false });
    await setNotifyPref("finished", true);
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(useNotifyPrefs.getState().finished).toBe(true);
  });

  it("leaves a kind off when the browser refuses", async () => {
    requestPermission.mockResolvedValueOnce("denied");
    useNotifyPrefs.setState({ finished: false });
    await setNotifyPref("finished", true);
    expect(useNotifyPrefs.getState().finished).toBe(false);
    expect(useNotifyPermission.getState().permission).toBe("denied");
  });

  it("raises one notification when blurred and none when the thread is visible and focused", () => {
    (Notification as unknown as { permission: string }).permission = "granted";
    startNotifications();
    const focus = vi.spyOn(document, "hasFocus");

    focus.mockReturnValue(true);
    receiveEvent(finished("t1"));
    expect(shown).toHaveLength(0);

    focus.mockReturnValue(false);
    receiveEvent(finished("t1"));
    expect(shown).toHaveLength(1);
    expect(shown[0]?.title).toBe("Turn finished");
    expect(shown[0]?.options?.tag).toBe("t1");
  });
});
