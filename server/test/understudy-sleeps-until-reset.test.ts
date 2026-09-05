/*
 * SLEEP UNTIL THE SESSION COMES BACK, AND RESUME.
 *
 * When the agent's session limit is hit, the CLI says when it resets and the
 * loop already read the hour — and then nobody used it: the run died, the
 * watchdog saw an idle shift and restarted the loop three times, each time
 * paying for a run whose whole output was "you have hit your limit". Now the
 * hour is a hold: the loop takes nothing until then, the watchdog neither
 * resumes nor spends a try while it holds, and the moment it lapses the loop
 * is resumed at once. Persisted, so a restart mid-nap keeps napping.
 */
import { test, expect, beforeEach, describe } from "bun:test";
import { db } from "../src/db.ts";
import * as Work from "../src/understudy-work.ts";
import { ask } from "../src/understudy-sources-work.ts";
import { sweepIdleShift, setResumeHook, __forgetResumes, setGitHook } from "../src/understudy-watchdog.ts";
import { workUntilDone, ranOutOfSession } from "../src/understudy-loop.ts";
import * as Shift from "../src/understudy-shift.ts";

const REPO = "/tmp/understudy-nap-probe";
const at = (h: number, m = 0) => { const d = new Date(2026, 8, 5, h, m, 0, 0); return d.getTime(); };

beforeEach(() => {
  db.exec("DELETE FROM understudy_work");
  db.exec("DELETE FROM understudy_asked");
  db.exec("DELETE FROM understudy_shifts");
  Work.clearHold();
  __forgetResumes();
  setGitHook(async () => ({ ok: false, out: "" }));
  setResumeHook(null);
});

describe("the reset hour the CLI announces", () => {
  test("is read as a clock time today — or tomorrow, when that hour is already behind", () => {
    const noon = at(12);
    expect(Work.resetTimeFrom("3pm", noon)).toBe(at(15) + 60_000);
    expect(Work.resetTimeFrom("3:30pm (Europe/Madrid)", noon)).toBe(at(15, 30) + 60_000);
    expect(Work.resetTimeFrom("15:00", noon)).toBe(at(15) + 60_000);
    // 9am is behind at noon: tomorrow's 9am, capped at six hours out.
    expect(Work.resetTimeFrom("9am", noon)).toBe(noon + 6 * 60 * 60_000 + 60_000);
  });
  test("no readable hour is an hour's nap, never zero and never for ever", () => {
    const now = at(12);
    expect(Work.resetTimeFrom("", now)).toBe(now + 60 * 60_000);
    expect(Work.resetTimeFrom("later", now)).toBe(now + 60 * 60_000);
    expect(Work.resetTimeFrom("99:99", now)).toBe(now + 60 * 60_000);
  });
  test("and the sentence the CLI writes yields the hour that feeds it", () => {
    expect(ranOutOfSession("You've hit your usage limit. Your limit resets at 3pm (Europe/Madrid).")).toBe("3pm (Europe/Madrid)");
  });
});

describe("the hold", () => {
  test("is a row: written, read back, lapsed on its own, and cleared by writing zero", () => {
    const now = at(12);
    expect(Work.heldUntil(now)).toBeNull();
    Work.holdUntil(at(15), "the agent's session limit — it comes back at 3pm", now);
    expect(Work.heldUntil(now)).toMatchObject({ until: at(15), why: "the agent's session limit — it comes back at 3pm" });
    expect(Work.heldUntil(at(15, 1)), "a lapsed hold is no hold").toBeNull();
    expect(Work.holdLapsed(at(15, 1)), "…but it is known to have lapsed, once, so the loop is woken").toBe(true);
    Work.clearHold(at(15, 1));
    expect(Work.holdLapsed(at(15, 2))).toBe(false);
  });

  test("the loop takes nothing while it holds, and says until when", async () => {
    Work.holdUntil(Date.now() + 60 * 60_000, "the agent's session limit — it comes back at 3pm");
    let asked = 0;
    const r = await workUntilDone({
      repos: [REPO], shiftId: null,
      keepGoing: () => ({ go: true, why: "" }),
      next: async () => { asked++; return null; },
      agent: async () => ({ ok: false, out: "" }),
      git: async () => ({ ok: false, out: "" }),
      verify: async () => ({ ok: true, out: "" }),
    });
    expect(asked, "nothing is even looked at").toBe(0);
    expect(r.stopped).toMatch(/^asleep until \d{1,2}:\d{2}/);
    expect(r.stopped).toContain("session limit");
  });
});

describe("the watchdog and the nap", () => {
  test("does not resume — and spends no try — while the loop holds; resumes at once when it lapses", () => {
    const shift = Shift.start("probe", 30, 5);
    expect(shift.ok).toBe(true);
    const id = (shift as { shift: { id: number } }).shift.id;
    ask({ title: "something to do", detail: "", repo: REPO });
    let resumed = 0;
    setResumeHook(async () => { resumed++; });

    const t0 = Date.now();
    Work.holdUntil(t0 + 10 * 60_000, "the agent's session limit — it comes back at 3pm", t0);
    /* Well past the idle threshold that would otherwise resume. */
    const asleep = sweepIdleShift(t0 + 5 * 60_000);
    expect(asleep.kind).toBe("asleep");
    expect(resumed, "not a single run paid for during the nap").toBe(0);
    expect(sweepIdleShift(t0 + 9 * 60_000).kind).toBe("asleep");

    /* The hold lapses: woken on the very next look, with no idle wait. */
    const woke = sweepIdleShift(t0 + 10 * 60_000 + 1);
    expect(woke.kind).toBe("woke");
    expect(resumed).toBe(1);
    expect(Work.heldUntil(t0 + 10 * 60_000 + 2), "the hold is spent").toBeNull();
    expect(Work.holdLapsed(t0 + 10 * 60_000 + 2), "and does not wake it twice").toBe(false);
    Shift.stop(id, "probe over");
    setResumeHook(null);
  });
});
