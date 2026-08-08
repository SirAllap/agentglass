import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * The reminder engine, which is the half of this feature that must not fail.
 *
 * A task list that is briefly stale is an inconvenience. A reminder that fires
 * twice at three in the morning, or does not fire at all, is the reason someone
 * turns the feature off — so what is asserted here is the claim: exactly once,
 * never after cancellation, and never eight times because a laptop was shut.
 *
 * Its own database, because these tests write.
 */
const dir = mkdtempSync(join(tmpdir(), "agx-rem-"));
process.env.AGENTGLASS_DB = join(dir, "t.db");
process.env.AGENTGLASS_SCAN_DISABLED = "1";
// Deliberately NOT setting AGENTGLASS_NOTIFY: an attached client is handed the
// frame whether or not notify-send is wanted, and that is what makes a reminder
// arrive in an app somebody has open. If this file ever needs the flag back,
// the behaviour regressed.

let R: typeof import("../src/reminders.ts");
let DB: typeof import("../src/db.ts");

beforeAll(async () => {
  DB = await import("../src/db.ts");
  R = await import("../src/reminders.ts");
});
beforeEach(() => { DB.db.run("DELETE FROM reminders"); });

const p = (n: number) => String(n).padStart(2, "0");
/** A civil string `mins` from now, in this machine's zone. */
const civilIn = (mins: number) => {
  const d = new Date(Date.now() + mins * 60_000);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

describe("claiming", () => {
  it("fires a reminder exactly once, however many drains race it", () => {
    // The claim is one atomic statement precisely so two ticks — or a tick and
    // a manual drain — cannot both take the same row. Delivery may then fail
    // freely; the ledger is already written.
    const { reminder } = R.addReminder({ title: "pay the accountant", civil: civilIn(-1) });
    expect(reminder).toBeTruthy();
    const a = R.drainDue();
    const b = R.drainDue();
    const c = R.drainDue();
    expect(a.length).toBe(1);
    expect(a[0]!.id).toBe(reminder!.id);
    expect(b.length + c.length).toBe(0);
  });

  it("never fires one that was cancelled, even after it came due", () => {
    // Cancellation lives in the claim predicate rather than in a timer that has
    // to be found and cleared — which is the version that fires anyway after a
    // restart, because the timer was rebuilt from the row.
    const { reminder } = R.addReminder({ title: "the meeting that moved", civil: civilIn(-5) });
    R.cancelReminder(reminder!.id);
    expect(R.drainDue().length).toBe(0);
  });

  it("never fires one that was acknowledged first", () => {
    const { reminder } = R.addReminder({ title: "already dealt with", civil: civilIn(-5) });
    R.ackReminder(reminder!.id);
    expect(R.drainDue().length).toBe(0);
  });

  it("leaves the future alone", () => {
    R.addReminder({ title: "tomorrow's problem", civil: civilIn(120) });
    expect(R.drainDue().length).toBe(0);
  });

  it("claims a whole weekend's backlog in one pass, not one tick at a time", () => {
    // The shut-lid case. Boot is just the first tick, so eight past-due rows
    // are claimed together and the budget decides how many are *spoken* — the
    // alternative is eight notifications arriving at once on Monday morning.
    for (let i = 1; i <= 8; i++) R.addReminder({ title: `thing ${i}`, civil: civilIn(-i * 30) });
    const claimed = R.drainDue();
    expect(claimed.length).toBe(8);
    expect(R.drainDue().length).toBe(0);
    // All eight are on screen; only the ledger cares how many were announced.
    expect(R.listReminders("live").length).toBe(8);
  });
});

describe("snooze", () => {
  it("closes the old row and opens a new one, so the ledger stays append-only", () => {
    const { reminder } = R.addReminder({ title: "call the bank", civil: civilIn(-1) });
    R.drainDue();
    const again = R.snoozeReminder(reminder!.id, 15);
    expect(again.ok).toBe(true);
    expect(again.reminder!.snoozeOf).toBe(reminder!.id);
    // The original stays fired-and-acknowledged: "did this fire?" has one
    // answer forever, and there is no timer left over to fire it a second time.
    const all = R.listReminders("history");
    const first = all.find((r) => r.id === reminder!.id)!;
    expect(first.firedAt).toBeTruthy();
    expect(first.ackedAt).toBeTruthy();
    expect(R.drainDue().length).toBe(0);
    expect(R.listReminders("live").length).toBe(0);
  });

  it("the snoozed copy fires when its own time comes", () => {
    const { reminder } = R.addReminder({ title: "the one that came back", civil: civilIn(-1) });
    R.drainDue();
    const snoozed = R.snoozeReminder(reminder!.id, 15).reminder!;
    expect(R.drainDue(Date.now() + 16 * 60_000).length).toBe(1);
    expect(R.listReminders("history").some((r) => r.id === snoozed.id && r.firedAt)).toBe(true);
  });
});

describe("civil time", () => {
  it("keeps the wall clock across a daylight-saving change", () => {
    // Europe/Madrid goes forward on the last Sunday of March. Nine in the
    // morning is nine in the morning on both sides of it; an instant fixed at
    // creation would land at eight or ten. Twice a year, silently.
    const before = R.resolveCivil("2026-03-28T09:00", "Europe/Madrid");
    const after = R.resolveCivil("2026-03-30T09:00", "Europe/Madrid");
    const hourIn = (at: number) =>
      new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", hour: "2-digit", hour12: false }).format(new Date(at));
    expect(hourIn(before)).toBe("09");
    expect(hourIn(after)).toBe("09");
    // …and they are genuinely a different number of hours apart than the naive
    // arithmetic would give, which is the whole point.
    expect(after - before).toBe(2 * 86_400_000 - 3_600_000);
  });

  it("resolves a zone it has never heard of rather than throwing", () => {
    expect(Number.isFinite(R.resolveCivil("2026-08-05T09:00", "Mars/Olympus"))).toBe(true);
  });

  it("refuses a time it cannot read", () => {
    const r = R.addReminder({ title: "when?", civil: "next tuesday-ish" });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it("refuses a reminder with nothing to say", () => {
    expect(R.addReminder({ title: "   ", civil: civilIn(10) }).ok).toBe(false);
  });
});

describe("what the surfaces read", () => {
  it("counts only what is shouting, not the backlog", () => {
    R.addReminder({ title: "later", civil: civilIn(60) });
    const { reminder } = R.addReminder({ title: "now", civil: civilIn(-1) });
    expect(R.firedUnacked()).toBe(0);
    R.drainDue();
    expect(R.firedUnacked()).toBe(1);
    R.ackReminder(reminder!.id);
    expect(R.firedUnacked()).toBe(0);
  });

  it("gives a task its soonest live reminder and no others", () => {
    R.addReminder({ taskUuid: "u1", title: "soon", civil: civilIn(30) });
    R.addReminder({ taskUuid: "u1", title: "later", civil: civilIn(300) });
    R.addReminder({ taskUuid: "u2", title: "other task", civil: civilIn(45) });
    const map = R.remindersFor(["u1", "u2", "u3"]);
    expect(map.u1!.title).toBe("soon");
    expect(map.u2!.title).toBe("other task");
    expect(map.u3).toBeUndefined();
  });

  it("survives a task list it cannot read — the title is a snapshot", () => {
    // The reason `title` is stored rather than joined: a reminder must be able
    // to fire on a machine where Taskwarrior is missing entirely, and
    // "reminder about (unavailable)" is worse than no reminder at all.
    const { reminder } = R.addReminder({ taskUuid: "a-task-nothing-can-resolve", title: "still says this", civil: civilIn(-1) });
    const fired = R.drainDue();
    expect(fired[0]!.title).toBe("still says this");
    expect(fired[0]!.id).toBe(reminder!.id);
  });
});

describe("retention", () => {
  it("ages out settled reminders and never a live one", () => {
    // The same ruling db.ts already makes for gates: a pending row is a live
    // request, however old it looks.
    const old = Date.now() - 400 * 86_400_000;
    const mk = (id: string, acked: number | null) => DB.db.run(
      `INSERT INTO reminders (id, task_uuid, title, root, civil, zone, due, created, fired_at, acked_at)
       VALUES (?, NULL, ?, NULL, '2025-01-01T09:00', 'UTC', ?, ?, ?, ?)`,
      [id, id, old, old, old, acked],
    );
    mk("settled", old);
    mk("still-waiting", null);
    DB.pruneOldRows();
    const ids = R.listReminders("history").map((r) => r.id);
    expect(ids).toContain("still-waiting");
    expect(ids).not.toContain("settled");
  });
});

describe("delivery", () => {
  it("hands a fired reminder to the one path everything else uses", async () => {
    // Not a delivery path of its own: `pushReminder` is a sibling of
    // `pushGate`, so a reminder buys the webhook, every attached client (the
    // cockpit, the desktop, a paired phone) and notify-send from code that
    // already gets each right.
    // What is asserted here is that it is *reached* — the transports themselves
    // are alerts.ts's, and already covered.
    const alerts = await import("../src/alerts.ts");
    const seen: { title: string; body: string; urgency: number }[] = [];
    alerts.setAlertSink({
      broadcast: (a) => { seen.push({ title: a.title, body: a.body, urgency: a.urgency }); },
      // One socket, and it answered its last ping: a client that is there and
      // demonstrably listening. See AlertSink.census.
      census: () => ({ attached: 1, live: 1 }),
    });
    try {
      R.addReminder({ title: "the delivery test", civil: civilIn(-1) });
      const fired = R.drainDue();
      expect(fired.length).toBe(1);
      const mine = seen.filter((a) => a.title.includes("the delivery test"));
      expect(mine.length, "the reminder never reached the alert path").toBe(1);
      // Urgency 1, never 2: 2 is the level a phone shows at Android's `max`,
      // over whatever you are doing, and it is for an agent that is stopped
      // until somebody answers. A reminder is news.
      expect(mine[0]!.urgency).toBe(1);
    } finally {
      alerts.setAlertSink(null);
    }
  });

  it("speaks three times and then counts, however many came due at once", async () => {
    // Close the lid on Friday, open it on Monday. Eight notifications is not
    // eight times as useful as one; it is how a feature gets turned off.
    const alerts = await import("../src/alerts.ts");
    const seen: string[] = [];
    alerts.setAlertSink({ broadcast: (a) => { seen.push(a.title); }, census: () => ({ attached: 1, live: 1 }) });
    try {
      for (let i = 1; i <= 8; i++) R.addReminder({ title: `backlog item ${i}`, civil: civilIn(-i * 7) });
      const fired = R.drainDue();
      expect(fired.length).toBe(8);
      const spoken = seen.filter((t) => t.includes("backlog item"));
      const digest = seen.filter((t) => t.includes("more reminder"));
      expect(spoken.length).toBe(3);
      expect(digest.length).toBe(1);
      expect(digest[0]).toContain("5 more reminders");
    } finally {
      alerts.setAlertSink(null);
    }
  });
});
