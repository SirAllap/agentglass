/*
 * An alarm the user set behaves like an alarm, not like news.
 *
 * The distinction this suite defends: everything else behind the bell is
 * something that happened and can be read whenever; a reminder is a promise made
 * at a particular minute, and one that arrives as another grey row has failed at
 * the only job it had.
 *
 * No DOM here — the card is a few lines of JSX over this module, and the rules
 * worth pinning are all in the module.
 */
import { beforeEach, describe, expect, it } from "bun:test";

const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(), key: () => null, length: 0,
} as unknown as Storage;

const load = async () =>
  (await import(`../src/lib/alarm.ts?t=${Math.random()}`)) as typeof import("../src/lib/alarm.ts");

const reminder = (over: Partial<import("../../shared/types.ts").Reminder> = {}) => ({
  id: "r1", taskUuid: null, title: "Send the risk review", root: null,
  civil: "2026-08-13T09:00", zone: "Europe/Madrid",
  due: Date.now() - 60_000, created: Date.now() - 3_600_000,
  firedAt: Date.now() - 60_000, ackedAt: null, cancelledAt: null,
  ...over,
} as import("../../shared/types.ts").Reminder);

beforeEach(() => store.clear());

describe("raising one", () => {
  it("holds the reminder it is about, so Done acts on that one", async () => {
    const a = await load();
    a.raiseAlarm({ id: "r7", title: "Stand-up", when: "09:00", at: Date.now() });
    expect(a.alarmNow()).toMatchObject({ id: "r7", title: "Stand-up" });
  });

  it("ignores a repeat of the same alarm", async () => {
    /* The server asks again while a reminder is unanswered — that is the point,
       an alarm you slept through should ask twice. What must not happen is the
       ringing restarting on a card the reader is already looking at. */
    const a = await load();
    a.raiseAlarm({ id: "r7", title: "Stand-up", when: "09:00", at: 1000 });
    a.raiseAlarm({ id: "r7", title: "Stand-up", when: "09:00 · still waiting", at: 2000 });
    expect(a.alarmNow()?.when).toBe("09:00");
  });

  it("lets a different reminder take over", async () => {
    const a = await load();
    a.raiseAlarm({ id: "r7", title: "Stand-up", when: "09:00", at: 1000 });
    a.raiseAlarm({ id: "r8", title: "Call the bank", when: "09:30", at: 2000 });
    expect(a.alarmNow()?.id).toBe("r8");
  });

  it("tells its subscribers, which is how the card appears at all", async () => {
    const a = await load();
    let beats = 0;
    const off = a.subscribeAlarm(() => { beats++; });
    a.raiseAlarm({ id: "r7", title: "x", when: "09:00", at: 1 });
    a.clearAlarm();
    off();
    expect(beats).toBe(2);
  });
});

describe("the one that fired while the app was closed", () => {
  it("is waiting when the app comes back", async () => {
    // The fired-and-unanswered list is the server's and survives a restart.
    // Nobody sets an alarm in order to miss it.
    const a = await load();
    a.restoreAlarm([reminder({ id: "r9", title: "Ship the release" })]);
    expect(a.alarmNow()).toMatchObject({ id: "r9", title: "Ship the release" });
  });

  it("does not push aside one that is already on screen", async () => {
    const a = await load();
    a.raiseAlarm({ id: "live", title: "Now", when: "11:00", at: Date.now() });
    a.restoreAlarm([reminder({ id: "old" })]);
    expect(a.alarmNow()?.id).toBe("live");
  });

  it("says how long it has been waiting, not only when it was set", async () => {
    /* Two different questions, both asked: "what time was this for" and "how
       late am I". A bare 09:00 at eleven o'clock reads as an alarm that has just
       gone off. */
    const a = await load();
    expect(a.whenOf(reminder({ due: Date.now() - 90 * 60_000, firedAt: Date.now() - 90 * 60_000 })))
      .toMatch(/·\s2h ago|·\s1h ago/);
    expect(a.whenOf(reminder({ due: Date.now(), firedAt: Date.now() }))).not.toContain("·");
  });
});

describe("the sound", () => {
  it("has one by default, and Silent is a real choice rather than the absence of one", async () => {
    /* "Silent" keeps the alarm and drops the noise. Without it the only way to
       stop an alarm making a sound is to stop setting alarms. */
    const a = await load();
    expect(a.alarmSound()).toBe(true);
    a.setAlarmVoice("none");
    expect(a.alarmSound()).toBe(false);
    expect(a.alarmVoiceId()).toBe("none");
  });

  it("remembers which one", async () => {
    const a = await load();
    a.setAlarmVoice("bell");
    expect(a.alarmVoiceId()).toBe("bell");
  });

  it("does not throw where there is no audio at all", async () => {
    // This runner has no AudioContext, which is also the state of a browser that
    // has never been interacted with. The card still has to appear.
    const a = await load();
    a.raiseAlarm({ id: "r7", title: "x", when: "09:00", at: 1 });
    expect(a.alarmNow()).not.toBeNull();
  });
});
