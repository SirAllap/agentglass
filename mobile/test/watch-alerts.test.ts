/*
 * Which watches and cards buzz this phone, and how many notifications they make.
 *
 * The decision is the feature, so each "no" and each way of collapsing is its
 * own case. Fixtures are the shape the server really sends (a fire carries its
 * alert's payload; an open alert is read back with its server time).
 */
import { describe, expect, test } from "bun:test";
import type { AskedAlert } from "../../shared/notifyPayload.ts";
import type { CardNote, PrWatchFire } from "../../shared/types.ts";
import {
  NO_CURSOR, advanceCursor, decideCatchUp, decideLive, mergeCursor, itemFromAsked, itemFromCard, itemFromFire, markHandled,
  type WatchContext,
} from "../src/notifications/watchAlerts.ts";
import { SAME_ALERT_MS } from "../src/notifications/policy.ts";

const ID = (n: number): string => `0000000${n}-0000-4000-8000-000000000000`;

const fire = (over: Partial<PrWatchFire> = {}): PrWatchFire => ({
  seq: 1, ruleId: "r1", rule: "ci-pass", repo: "acme/orbit", number: 1042, title: "Add the thing",
  summary: "CI passed", detail: "", ok: true, alertId: ID(1),
  payload: { title: "CI passed · acme/orbit #1042", line: "Add the thing", target: { kind: "pr", repo: "acme/orbit", number: 1042, root: "/home/dev/orbit" } },
  ...over,
});

const asked = (n: number, over: Partial<AskedAlert> = {}, num = 1000 + n): AskedAlert => ({
  id: ID(n), key: `acme/orbit#${num}@abc:CI passed`, ok: true, firedAt: 1_000 * n,
  payload: { title: `CI passed · acme/orbit #${num}`, line: "Add the thing", target: { kind: "pr", repo: "acme/orbit", number: num, root: "/home/dev/orbit" } },
  seenAt: null, actedAt: null, closedAt: null, osError: null, ...over,
});

const card = (over: Partial<CardNote> = {}): CardNote => ({
  kind: "comment", id: "86abc12", label: "ORBIT-1042", title: "Fix the thing", status: "in review", who: "Ada", said: "Looks right to me", ...over,
});

const ctx = (over: Partial<WatchContext> = {}): WatchContext => ({ enabled: true, foreground: false, handled: new Map(), now: 1_000_000, ...over });

describe("what a fire becomes", () => {
  test("the server's own words, grouped by pull request, with the checkout to open it on", () => {
    const i = itemFromFire(fire())!;
    expect(i).toMatchObject({ group: "pr:acme/orbit#1042", title: "CI passed · acme/orbit #1042", body: "Add the thing", urgent: false, alertId: ID(1) });
    expect(i.pr).toEqual({ repo: "acme/orbit", number: 1042, root: "/home/dev/orbit" });
  });

  test("a failure is the urgent kind", () => {
    expect(itemFromFire(fire({ ok: false }))!.urgent).toBe(true);
  });

  test("a fire from before the payload existed still says what happened", () => {
    const i = itemFromFire(fire({ payload: undefined, summary: "CI failed", detail: "evals", ok: false }))!;
    expect(i.title).toBe("CI failed · acme/orbit #1042");
    expect(i.body).toBe("evals");
  });

  test("a number or a repository that cannot be real makes nothing", () => {
    for (const number of [0, -3, 1.5, NaN, 1e12, "7" as unknown as number]) expect(itemFromFire(fire({ number }))).toBeNull();
    for (const repo of ["", "orbit", "a/b/c", "../../x", "acme/orbit\nrm"]) expect(itemFromFire(fire({ repo }))).toBeNull();
  });

  test("a root that is not a plain absolute path is dropped, and the rest still stands", () => {
    for (const root of ["relative/path", "/a/../../etc", "/a\nb", "javascript:alert(1)", "/".padEnd(2000, "x")]) {
      const i = itemFromFire(fire({ payload: { title: "t", line: "l", target: { kind: "pr", repo: "acme/orbit", number: 1042, root } } }))!;
      expect(i.pr?.root).toBeUndefined();
    }
  });

  test("text is one line and cut", () => {
    const i = itemFromFire(fire({ payload: { title: "CI failed\n· acme/orbit #1042", line: "x".repeat(500) } }))!;
    expect(i.title).not.toContain("\n");
    expect(i.body.length).toBeLessThanOrEqual(120);
  });

  test("an alert id that is not a UUID is not carried", () => {
    expect(itemFromFire(fire({ alertId: "../../x" }))!.alertId).toBeUndefined();
  });
});

describe("what a card becomes", () => {
  test("one group per card, a mention is the urgent kind", () => {
    expect(itemFromCard(card())).toMatchObject({ group: "card:86abc12", title: "Ada commented on ORBIT-1042", body: "Looks right to me", urgent: false });
    expect(itemFromCard(card({ kind: "mention" }))!.urgent).toBe(true);
  });

  test("a status or assignment note is not told: it carries no author, so it includes the person's own moves", () => {
    expect(itemFromCard(card({ kind: "assigned", who: undefined }))).toBeNull();
    expect(itemFromCard(card({ kind: "status", who: undefined, status: "done" }))).toBeNull();
  });

  test("a Jira card has no screen on the phone, and an id that is not an id makes nothing", () => {
    expect(itemFromCard(card({ tracker: "jira" }))).toBeNull();
    for (const id of ["", "../x", "a b", "a/b", "x".repeat(65)]) expect(itemFromCard(card({ id }))).toBeNull();
  });
});

describe("a fire as it happens", () => {
  test("buzzes once, with the group as the tag so the next one replaces it", () => {
    const v = decideLive(itemFromFire(fire()), ctx());
    expect(v).toMatchObject({ notify: true, raise: { tag: "pr:acme/orbit#1042", urgent: false, data: { kind: "watch", pr: 1042, repo: "acme/orbit", root: "/home/dev/orbit", alertId: ID(1) } } });
  });

  test("a second fire on the same pull request is the same tag", () => {
    const a = decideLive(itemFromFire(fire()), ctx());
    const b = decideLive(itemFromFire(fire({ alertId: ID(2), ok: false, summary: "CI failed" })), ctx());
    expect(a.notify && b.notify && a.raise.tag === b.raise.tag).toBe(true);
  });

  test("not while the switch is off, and not while the app is on screen", () => {
    expect(decideLive(itemFromFire(fire()), ctx({ enabled: false }))).toEqual({ notify: false, because: "off" });
    expect(decideLive(itemFromFire(fire()), ctx({ foreground: true }))).toEqual({ notify: false, because: "foreground" });
  });

  test("the same event twice inside the window is one", () => {
    const c = ctx();
    const i = itemFromFire(fire())!;
    markHandled(c.handled, i.id, c.now - 1000);
    expect(decideLive(i, c)).toEqual({ notify: false, because: "repeat" });
    expect(decideLive(i, { ...c, now: c.now + SAME_ALERT_MS })).toMatchObject({ notify: true });
  });

  test("nothing to say says nothing", () => {
    expect(decideLive(null, ctx())).toEqual({ notify: false, because: "empty" });
  });
});

describe("what a reconnect catches up", () => {
  const at = (n: number) => ({ at: n, ids: [] as string[] });
  /** Told about alert n, as a real cursor is: its time and its id. */
  const after = (n: number) => ({ at: 1_000 * n, ids: [ID(n)] });
  const items = (...ns: number[]) => ns.map((n) => itemFromAsked(asked(n)));

  test("nothing new is nothing", () => {
    expect(decideCatchUp(items(1, 2), at(5_000), ctx())).toEqual({ raise: null, seen: [], cursor: at(5_000) });
  });

  test("one pull request that moved is that notification, not a summary", () => {
    const r = decideCatchUp(items(3), after(1), ctx());
    expect(r.raise).toMatchObject({ tag: "pr:acme/orbit#1003", title: "CI passed · acme/orbit #1003" });
    expect(r.cursor).toEqual({ at: 3_000, ids: [ID(3)] });
  });

  test("several are ONE summary naming the newest, however many fires", () => {
    const r = decideCatchUp(items(1, 2, 3, 4, 5), at(0), ctx());
    expect(r.raise).toMatchObject({ tag: "summary", title: "5 updates while you were away", data: { kind: "watch", summary: true } });
    expect(r.raise!.body).toBe("#1005, #1004, #1003 +2");
    expect(r.seen).toHaveLength(5);
    expect(r.cursor).toEqual({ at: 5_000, ids: [ID(5)] });
  });

  test("two fires on one pull request are one pull request, the latest wins", () => {
    const r = decideCatchUp([itemFromAsked(asked(1, {}, 77)), itemFromAsked(asked(2, { ok: false, payload: { title: "CI failed · acme/orbit #77", line: "evals", target: { kind: "pr", repo: "acme/orbit", number: 77 } } }, 77))], at(0), ctx());
    expect(r.raise).toMatchObject({ tag: "pr:acme/orbit#77", title: "CI failed · acme/orbit #77", urgent: true });
  });

  test("a failure among them makes the summary urgent", () => {
    const r = decideCatchUp([itemFromAsked(asked(1)), itemFromAsked(asked(2, { ok: false }))], at(0), ctx());
    expect(r.raise).toMatchObject({ tag: "summary", urgent: true });
  });

  test("what a live frame already handled is not told again", () => {
    const c = ctx();
    markHandled(c.handled, ID(2), c.now);
    const r = decideCatchUp(items(1, 2), at(0), c);
    expect(r.raise).toMatchObject({ tag: "pr:acme/orbit#1001" });
    expect(r.seen).toEqual([ID(1)]);
  });

  test("a switch that is off, or a screen that is open, still counts them as told", () => {
    for (const over of [{ enabled: false }, { foreground: true }]) {
      const r = decideCatchUp(items(1, 2), at(0), ctx(over));
      expect(r.raise).toBeNull();
      expect(r.seen).toHaveLength(2);
      expect(r.cursor.at).toBe(2_000);
    }
  });

  test("an open alert that is not a pull request makes nothing", () => {
    const odd = asked(1, { payload: { title: "Blocked", line: "", target: { kind: "pane", pane: "%1" } } });
    expect(itemFromAsked(odd)).toBeNull();
    expect(itemFromAsked(asked(1, { id: "nope" }))).toBeNull();
  });

  test("a second fire stamped like the one already told is still new", () => {
    // One tick of the watch stamps every fire the same; hearing the first must not bury the second.
    const same = [itemFromAsked(asked(1, { firedAt: 7_000 })), itemFromAsked(asked(2, { firedAt: 7_000 }))];
    const heard = advanceCursor(NO_CURSOR, 7_000, ID(1));
    const r = decideCatchUp(same, heard, ctx());
    expect(r.seen).toEqual([ID(2)]);
    expect(r.raise).toMatchObject({ tag: "pr:acme/orbit#1002" });
    expect(r.cursor).toEqual({ at: 7_000, ids: [ID(1), ID(2)] });
  });

  test("an alert a live frame handled still moves the cursor, so a restart does not announce it again", () => {
    const c = ctx();
    markHandled(c.handled, ID(2), c.now);
    const r = decideCatchUp(items(1, 2), after(1), c);
    expect(r.seen).toEqual([]);
    expect(r.cursor).toEqual({ at: 2_000, ids: [ID(2)] });
  });

  test("text that is not text is nothing, and cannot throw", () => {
    const junk = { id: ID(1), ok: true, firedAt: 1, payload: { title: { x: 1 }, line: 5, target: { kind: "pr", repo: "acme/orbit", number: 3 } } } as never;
    expect(itemFromAsked(junk)).toBeNull();
    expect(() => itemFromFire(fire({ summary: 7 as never, detail: {} as never, title: [] as never, payload: undefined }))).not.toThrow();
    expect(() => itemFromCard(card({ status: 3 as never, who: {} as never, said: 9 as never, title: null as never, label: 1 as never }))).not.toThrow();
  });
});

describe("the cursor", () => {
  test("moves forward, collects ids at one time, and merges", () => {
    const a = advanceCursor(NO_CURSOR, 5, "x");
    expect(advanceCursor(a, 4, "y")).toBe(a);
    expect(advanceCursor(a, 5, "x")).toBe(a);
    expect(advanceCursor(a, 5, "y")).toEqual({ at: 5, ids: ["x", "y"] });
    expect(advanceCursor(a, 6, "z")).toEqual({ at: 6, ids: ["z"] });
    expect(mergeCursor({ at: 5, ids: ["x"] }, { at: 5, ids: ["y"] })).toEqual({ at: 5, ids: ["x", "y"] });
    expect(mergeCursor({ at: 5, ids: ["x"] }, { at: 9, ids: ["z"] })).toEqual({ at: 9, ids: ["z"] });
    expect(mergeCursor({ at: 9, ids: ["z"] }, { at: 5, ids: ["x"] })).toEqual({ at: 9, ids: ["z"] });
  });
});
