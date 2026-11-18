import { describe, expect, test } from "bun:test";
import { cardAction, dayLabel, stackCard, type LiveCard } from "../src/lib/noteCard.ts";
import type { SystemNote } from "../src/lib/sysNotify.ts";

// Notifications v2 cards: every card names where its click goes, and repeats
// from one app are one card with ×N.
const note = (over: Partial<SystemNote>): SystemNote => ({ id: "n1", app: "Slack", summary: "s", body: "b", urgency: 1, at: 1, ...over });
const o = { bench: false, appLink: null, gate: false };

describe("cardAction", () => {
  test("a gate hold answers in place", () => {
    expect(cardAction(note({ urgency: 2 }), { ...o, gate: true })).toEqual({ kind: "gate" });
  });
  test("a linked task names Tasks and the key", () => {
    expect(cardAction(note({ goto: { kind: "card", id: "c1", label: "ORBIT-1042" } }), o))
      .toEqual({ kind: "goto", label: "Open in Tasks", target: "ORBIT-1042" });
  });
  test("a PR follows the bench setting", () => {
    const pr = note({ goto: { kind: "pr", repo: "acme/orbit-web", number: 318 } });
    expect(cardAction(pr, o)).toEqual({ kind: "goto", label: "Open in Pull requests", target: "orbit-web#318" });
    expect(cardAction(pr, { ...o, bench: true })).toEqual({ kind: "goto", label: "Open on the bench", target: "orbit-web#318" });
  });
  test("an agent's pane is the terminal", () => {
    expect(cardAction(note({ goto: { kind: "pane", pane: "%3" } }), o)).toEqual({ kind: "goto", label: "Open the terminal" });
  });
  test("Slack with no link opens the app, and says so", () => {
    expect(cardAction(note({}), { ...o, appLink: "Slack" })).toEqual({ kind: "app", label: "Open the Slack app" });
  });
  test("nothing to open says it stays in the bell", () => {
    expect(cardAction(note({ app: "Backup" }), o)).toEqual({ kind: "none", label: "Nothing to open · it stays in the bell" });
  });
});

describe("stackCard", () => {
  test("four from Slack are one card ×4, newest words on top", () => {
    let live: LiveCard[] = [];
    for (let i = 1; i <= 4; i++) live = stackCard(live, `k${i}`, note({ id: `s${i}`, summary: `m${i}`, source: "desktop:slack" }), 3);
    expect(live.length).toBe(1);
    expect(live[0]).toMatchObject({ key: "k1", count: 4, n: { summary: "m4" } });
  });
  test("different apps stack separately, capped", () => {
    let live: LiveCard[] = [];
    for (const a of ["slack", "mail", "docs", "chat"]) live = stackCard(live, a, note({ id: a, source: `desktop:${a}` }), 3);
    expect(live.map((c) => c.key)).toEqual(["chat", "docs", "mail"]);
  });
  test("an agent that waits is never folded", () => {
    let live: LiveCard[] = [];
    live = stackCard(live, "g1", note({ id: "g1", app: "gate", source: "gate", urgency: 2 }), 3);
    live = stackCard(live, "g2", note({ id: "g2", app: "gate", source: "gate", urgency: 2 }), 3);
    expect(live.length).toBe(2);
  });
});

describe("dayLabel", () => {
  const now = new Date(2026, 10, 13, 15, 0).getTime();
  test("today, yesterday, then a short date", () => {
    expect(dayLabel(new Date(2026, 10, 13, 0, 5).getTime(), now)).toBe("Today");
    expect(dayLabel(new Date(2026, 10, 12, 23, 59).getTime(), now)).toBe("Yesterday");
    expect(dayLabel(new Date(2026, 10, 9, 12, 0).getTime(), now)).toBe("Mon, 9 Nov");
  });
});
