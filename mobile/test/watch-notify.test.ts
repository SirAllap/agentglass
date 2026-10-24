/*
 * The two things notify.ts does for watch alerts: draw one that replaces the
 * last for the same pull request, and take one down by its server alert id.
 * The module is a stub; NODE_ENV=test means the real one is never loaded.
 */
import { describe, expect, mock, test } from "bun:test";

mock.module("react-native", () => ({ Platform: { OS: "android" } }));
mock.module("expo-constants", () => ({
  default: { executionEnvironment: "bare" },
  ExecutionEnvironment: { StoreClient: "storeClient", Standalone: "standalone", Bare: "bare" },
}));

const notify = await import("../src/notifications/notify.ts");

function stub(over: { watchImportance?: number } = {}) {
  const state = { requests: [] as any[], dismissed: [] as string[], channels: [] as string[], presented: [] as any[] };
  notify.__setNotificationsModule({
    AndroidImportance: { NONE: 0, DEFAULT: 3, HIGH: 4 },
    AndroidNotificationPriority: { DEFAULT: "default", HIGH: "high", MAX: "max" },
    setNotificationHandler: () => {},
    setNotificationChannelAsync: async (id: string) => { state.channels.push(id); },
    getNotificationChannelAsync: async (id: string) => ({ id, importance: id === "agentglass-watch" ? over.watchImportance ?? 3 : 4 }),
    getPermissionsAsync: async () => ({ granted: true }),
    scheduleNotificationAsync: async (r: any) => { state.requests.push(r); return r.identifier; },
    getPresentedNotificationsAsync: async () => state.presented,
    dismissNotificationAsync: async (id: string) => { state.dismissed.push(id); },
  } as any);
  return state;
}

const raise = { tag: "pr:acme/orbit#1042", title: "CI failed · acme/orbit #1042", body: "evals", urgent: true, data: { kind: "watch" as const, pr: 1042, repo: "acme/orbit", alertId: "a" } };

describe("raiseWatch", () => {
  test("is drawn on its own channel, tagged so the next replaces it, and carries the computer", async () => {
    const s = stub();
    expect(await notify.raiseWatch(raise, "desk", (t) => `desk: ${t}`)).toEqual({ ok: true });
    expect(s.channels).toContain("agentglass-watch");
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0]).toMatchObject({
      identifier: "desk:pr:acme/orbit#1042",
      content: { title: "desk: CI failed · acme/orbit #1042", body: "evals", data: { kind: "watch", pr: 1042, hostId: "desk" }, priority: "high" },
      trigger: { channelId: "agentglass-watch" },
    });
    notify.__setNotificationsModule(undefined);
  });

  test("a quiet one is the default priority", async () => {
    const s = stub();
    await notify.raiseWatch({ ...raise, urgent: false }, "desk");
    expect(s.requests[0].content.priority).toBe("default");
    notify.__setNotificationsModule(undefined);
  });

  test("a channel the person switched off in Android says so instead of claiming delivery", async () => {
    const s = stub({ watchImportance: 0 });
    expect(await notify.raiseWatch(raise, "desk")).toEqual({ ok: false, why: "channel-off" });
    expect(s.requests).toHaveLength(0);
    notify.__setNotificationsModule(undefined);
  });

  test("without the module nothing throws and nothing is drawn", async () => {
    notify.__setNotificationsModule(null);
    expect(await notify.raiseWatch(raise, "desk")).toMatchObject({ ok: false, why: "unsupported" });
    notify.__setNotificationsModule(undefined);
  });

  test("under a test run the real module is never loaded", async () => {
    notify.__setNotificationsModule(undefined);
    expect(notify.notificationsSupported()).toBe(false);
  });
});

describe("a watch alert's own channel", () => {
  test("a failure of the agent alerts channel does not stop it, and its success does not clear that failure", async () => {
    const s = stub();
    notify.__setNotificationsModule({
      AndroidImportance: { NONE: 0, DEFAULT: 3, HIGH: 4 }, AndroidNotificationPriority: { DEFAULT: "d", HIGH: "h" },
      setNotificationHandler: () => {}, setNotificationChannelAsync: async () => {},
      getNotificationChannelAsync: async (id: string) => ({ id, importance: id === "agentglass-alerts" ? 0 : 3 }),
      getPermissionsAsync: async () => ({ granted: true }),
      scheduleNotificationAsync: async (r: any) => { s.requests.push(r); return "id"; },
    } as any);
    expect((await notify.alertsDeliverable()).ok).toBe(false);
    expect(await notify.raiseWatch(raise, "desk")).toEqual({ ok: true });
    expect(notify.lastAlertFailure()).toMatchObject({ ok: false, why: "channel-off" });
    notify.__setNotificationsModule(undefined);
  });

  test("a watch channel that is off is not the agent card's failure", async () => {
    stub({ watchImportance: 0 });
    await notify.raiseWatch(raise, "desk");
    expect(notify.lastAlertFailure()).toBeNull();
    notify.__setNotificationsModule(undefined);
  });
});

describe("watchAlertsDeliverable", () => {
  test("asks the permission and the watch channel, not the agent alerts channel", async () => {
    stub();
    notify.__setNotificationsModule({
      AndroidImportance: { NONE: 0, DEFAULT: 3, HIGH: 4 },
      setNotificationHandler: () => {}, setNotificationChannelAsync: async () => {},
      getNotificationChannelAsync: async (id: string) => ({ id, importance: id === "agentglass-alerts" ? 0 : 3 }),
      getPermissionsAsync: async () => ({ granted: true }),
    } as any);
    expect(await notify.watchAlertsDeliverable()).toEqual({ ok: true });
    notify.__setNotificationsModule({
      AndroidImportance: { NONE: 0, DEFAULT: 3, HIGH: 4 },
      setNotificationHandler: () => {}, setNotificationChannelAsync: async () => {},
      getNotificationChannelAsync: async (id: string) => ({ id, importance: id === "agentglass-watch" ? 0 : 4 }),
      getPermissionsAsync: async () => ({ granted: true }),
    } as any);
    expect(await notify.watchAlertsDeliverable()).toMatchObject({ ok: false, why: "channel-off" });
    notify.__setNotificationsModule({ ...({} as any), AndroidImportance: { NONE: 0 }, setNotificationHandler: () => {}, setNotificationChannelAsync: async () => {}, getPermissionsAsync: async () => ({ granted: false, canAskAgain: false }) } as any);
    expect(await notify.watchAlertsDeliverable()).toMatchObject({ ok: false, why: "denied" });
    notify.__setNotificationsModule(undefined);
  });
});

describe("dismissWatch", () => {
  test("takes down the notification drawn for that alert and no other", async () => {
    const s = stub();
    s.presented = [
      { request: { identifier: "desk:pr:a#1", content: { data: { kind: "watch", alertId: "x" } } } },
      { request: { identifier: "desk:pr:a#2", content: { data: { kind: "watch", alertId: "y" } } } },
      { request: { identifier: "desk:other", content: { data: null } } },
    ];
    s.presented[0].request.content.data.hostId = "desk";
    s.presented[1].request.content.data.hostId = "desk";
    await notify.dismissWatch("x", "desk");
    expect(s.dismissed).toEqual(["desk:pr:a#1"]);
    await notify.dismissWatch("y", "laptop");
    expect(s.dismissed).toEqual(["desk:pr:a#1"]);
    notify.__setNotificationsModule(undefined);
  });

  test("a failure to ask leaves it where it is", async () => {
    notify.__setNotificationsModule({ getPresentedNotificationsAsync: async () => { throw new Error("no"); } } as any);
    await expect(notify.dismissWatch("x", "desk")).resolves.toBeUndefined();
    notify.__setNotificationsModule(undefined);
  });
});
