/*
 * A WORKER SITS UNDER THE CHAIR THAT STARTED IT, AND SAYS HOW IT GOT THERE.
 *
 * The board drew every worker as one more agent in a flat grid, so a person
 * with a chair and three workers could not tell whose they were, why one ran
 * on a second-choice engine, or which one had lost its owner. These pin the
 * join (pure, over two small facts), the origin line (built from what the row
 * kept, so a restart of this server does not blank it), and the one action the
 * chair gets: "Change now", which stands the seat down and seats the engine the
 * policy names, and only once the seat has written down what it knows.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const was = process.env.AGENTGLASS_DOCTRINE;
process.env.AGENTGLASS_DOCTRINE = join(mkdtempSync(join(tmpdir(), "agx-chairs-")), "data");
const { placed } = await import("../src/agentboard.ts");
const { seatRoots } = await import("../src/seatpanes.ts");
const { liveOwned } = await import("../src/agentops.ts");
const { nextInChair, handOffWritten, changeChair, nextFor, engineReport, __forgetNext } = await import("../src/seat.ts");
const { originLine, originOf } = await import("../../shared/orchestration.ts");
const { db } = await import("../src/db.ts");
const { seatAllows } = await import("../src/auth.ts");
type Row = Parameters<typeof placed>[0][number];

afterAll(() => { if (was === undefined) delete process.env.AGENTGLASS_DOCTRINE; else process.env.AGENTGLASS_DOCTRINE = was; });

const row = (o: Partial<Row> & { name: string }): Row => ({ from: "seen", state: "working", ...o }) as Row;
const ROOT = "/home/a/code/orbit";
const stamp = { rule: "Night hours", engine: "opencode", model: "big-pickle", position: 1, headless: true };

describe("the join", () => {
  test("a worker is under the chair that started it, and the chair's own row says whose chair it is", () => {
    const out = placed(
      [row({ name: "orchestrator", paneId: "%1" }), row({ name: "builder-1", paneId: "%2" })],
      { chairs: new Map([["%1", ROOT]]), owned: [{ name: "builder-1", paneId: "%2", seatRoot: ROOT, startedBy: stamp }] },
    );
    expect(out[0]!.chairOf).toBe(ROOT);
    expect(out[1]!.under).toBe(ROOT);
    expect(out[1]!.orphaned).toBeUndefined();
  });

  test("a worker whose seat is gone stays at the top level and is marked an orphan", () => {
    const out = placed(
      [row({ name: "builder-1", paneId: "%2" })],
      { chairs: new Map(), owned: [{ name: "builder-1", paneId: "%2", seatRoot: ROOT }] },
    );
    expect(out[0]!.under).toBeUndefined();
    expect(out[0]!.orphaned).toBe(true);
  });

  test("a worker of ANOTHER project's seat is not under this chair", () => {
    const out = placed(
      [row({ name: "builder-1", paneId: "%2" })],
      { chairs: new Map([["%1", "/home/a/code/other"]]), owned: [{ name: "builder-1", paneId: "%2", seatRoot: ROOT }] },
    );
    expect(out[0]!.under).toBeUndefined();
    expect(out[0]!.orphaned).toBe(true);
  });

  test("nesting changes nothing about what a worker asks of a person", () => {
    const needs = { kind: "permission" as const, why: "run the tests", since: 5 };
    const [w] = placed(
      [row({ name: "builder-1", paneId: "%2", state: "waiting", needsYou: needs })],
      { chairs: new Map([["%1", ROOT]]), owned: [{ name: "builder-1", paneId: "%2", seatRoot: ROOT }] },
    );
    expect(w!.needsYou).toEqual(needs);
    expect(w!.state).toBe("waiting");
  });

  test("an agent nobody owns is left exactly as it was", () => {
    const r = row({ name: "review-1042", paneId: "%9" });
    expect(placed([r], { chairs: new Map([["%1", ROOT]]), owned: [] })[0]).toEqual(r);
  });

  test("a worker is found by name when its row has no pane yet", () => {
    const out = placed([row({ name: "builder-1" })], { chairs: new Map([["%1", ROOT]]), owned: [{ name: "builder-1", paneId: "%2", seatRoot: ROOT }] });
    expect(out[0]!.under).toBe(ROOT);
  });

  test("a row on a DIFFERENT pane is not a worker just because it borrowed the name", () => {
    /* Names on /agents/status are free text: another project's session calling
       itself "review" must not be nested under this chair or take its origin. */
    const out = placed(
      [row({ name: "review", paneId: "%99" })],
      { chairs: new Map([["%1", ROOT]]), owned: [{ name: "review", paneId: "%41", seatRoot: ROOT, startedBy: stamp }] },
    );
    expect(out[0]!.under).toBeUndefined();
    expect(out[0]!.orphaned).toBeUndefined();
    expect(out[0]!.startedBy).toBeUndefined();
  });
});

describe("from the database, which is what a restart leaves", () => {
  beforeEach(() => { db.query("DELETE FROM seat").run(); db.query("DELETE FROM named_agent").run(); });

  test("the origin and the chair are read back from the rows alone", () => {
    db.query(`INSERT INTO seat (root, name, model, powers, started_at, ended_at) VALUES (?, 'orchestrator-abc', '', 'speak', 1, NULL)`).run(ROOT);
    db.query(`INSERT INTO named_agent (name, kind, cwd, pane_id, window_id, started_at, ended_at)
              VALUES ('orchestrator-abc', 'claude', ?, '%1', '@1', 1, NULL)`).run(ROOT);
    db.query(`INSERT INTO named_agent (name, kind, cwd, pane_id, window_id, started_at, ended_at, seat_root, model, started_by)
              VALUES ('builder-1', 'opencode', ?, '%2', '@2', 2, NULL, ?, 'big-pickle', ?)`).run(ROOT, ROOT, JSON.stringify(stamp));
    expect([...seatRoots()]).toEqual([["%1", ROOT]]);
    const [w] = placed([row({ name: "builder-1", paneId: "%2" })], { chairs: seatRoots(), owned: liveOwned() });
    expect(w!.under).toBe(ROOT);
    expect(originLine(w!.startedBy!)).toBe('OpenCode (big-pickle) · rule "Night hours" · 2nd in the chain');
  });

  test("a stood-down seat is no chair, so what it started is orphaned", () => {
    db.query(`INSERT INTO seat (root, name, model, powers, started_at, ended_at) VALUES (?, 'orchestrator-abc', '', 'speak', 1, 50)`).run(ROOT);
    db.query(`INSERT INTO named_agent (name, kind, cwd, pane_id, window_id, started_at, ended_at, seat_root)
              VALUES ('builder-1', 'claude', ?, '%2', '@2', 2, NULL, ?)`).run(ROOT, ROOT);
    const [w] = placed([row({ name: "builder-1", paneId: "%2" })], { chairs: seatRoots(), owned: liveOwned() });
    expect(w!.orphaned).toBe(true);
  });
});

describe("the origin line", () => {
  test("a rule, a position and a retry are each said once", () => {
    expect(originLine(originOf({ engine: "claude", model: "sonnet", rule: "base", position: 0 })!)).toBe("Claude Code (sonnet) · the base policy");
    expect(originLine(originOf({ ...stamp, position: 2, retries: 1 })!)).toBe('OpenCode (big-pickle) · rule "Night hours" · 3rd in the chain · moved after a failed start');
  });
  test("a column that holds something else gives no origin, never half of one", () => {
    for (const bad of [null, undefined, "x", 4, {}, { engine: "" }]) expect(originOf(bad)).toBeNull();
  });
});

describe("what the policy would put in the chair", () => {
  const ok = (engine: string, model: string, ask = false) => ({ ok: true as const, choice: { engine, model }, from: "base" as const, position: 0, ask, because: [] });
  test("a different engine, or the same engine on another model, is a next", () => {
    expect(nextInChair({ kind: "claude", model: "opus" }, ok("opencode", "big-pickle"))).toEqual({ engine: "opencode", model: "big-pickle" });
    expect(nextInChair({ kind: "claude", model: "opus" }, ok("claude", "sonnet"))).toEqual({ engine: "claude", model: "sonnet" });
  });
  test("a chair whose model is not known has no next on the same engine", () => {
    /* An adopted session is saved with no model, while the policy always
       resolves one: comparing "" with it made a difference out of nothing. */
    const r = { ok: true, ask: false, choice: { engine: "claude", model: "claude-sonnet-5" } } as never;
    expect(nextInChair({ kind: "claude", model: "" }, r)).toBeNull();
    expect(nextInChair({ kind: "opencode", model: "" }, r)).not.toBeNull();
  });

  test("the same thing, nothing ready, or a chair set to ask is no next", () => {
    expect(nextInChair({ kind: "claude", model: "opus" }, ok("claude", "opus"))).toBeNull();
    expect(nextInChair({ kind: "claude", model: "opus" }, ok("claude", ""))).toBeNull();
    expect(nextInChair({ kind: "claude", model: "opus" }, { ok: false, why: "none ready", from: "base", because: [] })).toBeNull();
    expect(nextInChair({ kind: "claude", model: "opus" }, ok("opencode", "big-pickle", true))).toBeNull();
  });
});

describe("the hand-off", () => {
  const MIN = 60_000, H = 60 * MIN;
  test("written means the brief changed after this one sat down", () => {
    expect(handOffWritten(100, 0, 0)).toBe(false);
    expect(handOffWritten(100, 0, 100)).toBe(false);
    expect(handOffWritten(100, 0, 101)).toBe(true);
    expect(handOffWritten(0, 0, 5)).toBe(false);
  });
  test("a brief from the first minutes does not unlock a seating that kept working for hours", () => {
    expect(handOffWritten(0 + 1, 6 * H, 2 * MIN)).toBe(false);
  });
  test("a brief written in the round the seat has just closed, or since, counts", () => {
    expect(handOffWritten(1, 6 * H, 6 * H - 2 * MIN)).toBe(true);
    expect(handOffWritten(1, 6 * H, 6 * H + MIN)).toBe(true);
  });
});

describe("Change now", () => {
  const view = (o: { next?: { engine: string; model: string } | null; handedOff?: boolean } = {}) => async () => ({
    root: ROOT, name: "orchestrator-abc", kind: "claude", model: "opus",
    next: o.next === undefined ? { engine: "opencode", model: "big-pickle" } : o.next, handedOff: o.handedOff ?? true,
  });
  const fakes = () => {
    const calls: string[] = [];
    return {
      calls,
      close: async () => { calls.push("close"); return { ok: true, was: true }; },
      open: async (p: { root: string; kind: string; model: string }) => {
        calls.push(`open ${p.kind} ${p.model}`);
        return { ok: true as const, seat: { root: p.root } as never, agent: {} as never, already: false };
      },
    };
  };

  test("refuses a chair that is the person's own adopted session, and touches nothing", async () => {
    const f = fakes();
    const adopted = async () => ({ ...(await view()()), adopted: true });
    const r = await changeChair(ROOT, { view: adopted, close: f.close, open: f.open });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("adopted");
    expect(f.calls).toEqual([]);
  });

  test("a second call while one is running answers \"already changing\" and writes nothing", async () => {
    /* A second window or a phone gets past the button's own busy flag; two runs
       interleaved would stop the seat the other had just started, or leave one
       on a credential the other revoked. */
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const close = async () => { calls.push("close"); await gate; return { ok: true, was: true }; };
    const f = fakes();
    const first = changeChair(ROOT, { view: view(), close, open: f.open });
    await Bun.sleep(5);
    const second = await changeChair(ROOT, { view: view(), close: f.close, open: f.open });
    expect(second).toEqual({ ok: false, error: "the chair is already changing; wait for it to finish" });
    expect(f.calls).toEqual([]);
    release();
    expect((await first).ok).toBe(true);
    expect((await changeChair(ROOT, { view: view(), close: f.close, open: f.open })).ok).toBe(true);
  });

  test("the lock is let go when a change throws", async () => {
    const f = fakes();
    await changeChair(ROOT, { view: async () => { throw new Error("boom"); }, close: f.close, open: f.open }).catch(() => null);
    expect((await changeChair(ROOT, { view: view(), close: f.close, open: f.open })).ok).toBe(true);
  });

  test("the new seat is told the wake floor the person set, not the default", async () => {
    const seen: (number | undefined)[] = [];
    const open = async (p: { root: string; kind: string; model: string; wakeHours?: number }) => {
      seen.push(p.wakeHours);
      return { ok: true as const, seat: { root: p.root } as never, agent: {} as never, already: false };
    };
    await changeChair(ROOT, { view: view(), close: fakes().close, open, wakeHours: 1 });
    expect(seen).toEqual([1]);
  });

  test("stands the seat down, then opens the engine the policy names", async () => {
    const f = fakes();
    const r = await changeChair(ROOT, { view: view(), close: f.close, open: f.open });
    expect(r.ok).toBe(true);
    expect(f.calls).toEqual(["close", "open opencode big-pickle"]);
  });

  test("is refused while the hand-off has not been written, and nothing is touched", async () => {
    const f = fakes();
    const r = await changeChair(ROOT, { view: view({ handedOff: false }), close: f.close, open: f.open });
    expect(r).toEqual({ ok: false, error: "orchestrator-abc has not written its hand-off yet. Ask it to update the brief, then change the chair." });
    expect(f.calls).toEqual([]);
  });

  test("is refused with nothing to change to, and with nobody in the chair", async () => {
    const f = fakes();
    expect((await changeChair(ROOT, { view: view({ next: null }), close: f.close, open: f.open })).ok).toBe(false);
    expect((await changeChair(ROOT, { view: async () => null, close: f.close, open: f.open })).ok).toBe(false);
    expect(f.calls).toEqual([]);
  });

  test("says so when the chair was stood down and the new engine would not sit", async () => {
    const f = fakes();
    const r = await changeChair(ROOT, { view: view(), close: f.close, open: async () => ({ ok: false, error: "that agent CLI is not installed here" }) });
    expect(r).toEqual({ ok: false, error: "the chair was stood down and opencode did not take it: that agent CLI is not installed here" });
  });
});

describe("the change is on the record", () => {
  test("the route notes the person's \"Change now\" in the action log, as every other act of theirs", async () => {
    const src = await Bun.file(join(import.meta.dir, "../src/index.ts")).text();
    const from = src.indexOf('if (verb === "change") {');
    const body = src.slice(from, src.indexOf("return json(r, r.ok ? 200 : 409);", from));
    expect(from).toBeGreaterThan(0);
    expect(body).toContain('noteAction(clientIp, "/seat/change"');
  });
});

describe("who may change the chair", () => {
  test("a seat never may, at any power: standing itself down to sit as something else is not its call", () => {
    for (const power of ["speak", "nudge", "assign"] as const) expect(seatAllows(power, "POST", "/seat/change")).toBe(false);
  });
});

describe("how often the policy is asked", () => {
  const sitting = { kind: "claude", model: "opus" };
  const pick = { engine: "opencode", model: "big-pickle" };
  test("the board's five-second read asks once in half a minute, and the button always asks", async () => {
    __forgetNext();
    let asked = 0;
    const read = async () => { asked++; return pick; };
    await nextFor(ROOT, sitting, { now: 1_000, read });
    await nextFor(ROOT, sitting, { now: 6_000, read });
    await nextFor(ROOT, sitting, { now: 11_000, read });
    expect(asked).toBe(1);
    await nextFor(ROOT, sitting, { now: 40_000, read });
    expect(asked).toBe(2);
    await nextFor(ROOT, sitting, { now: 41_000, read, fresh: true });
    expect(asked).toBe(3);
  });
  const report = (versionOk: boolean | null) => async () => ({ host: "h", engines: [{ id: "opencode", found: true, versionOk }] }) as never;
  test("chairs share one probe, and an engine whose probe timed out is not asked again for five minutes", async () => {
    __forgetNext();
    let spawned = 0;
    const probe = async () => { spawned++; return report(null)(); };
    await Promise.all([1, 2, 3].map(() => engineReport({ now: 1_000, probe })));
    await engineReport({ now: 40_000, probe });
    await engineReport({ now: 200_000, probe });
    expect(spawned).toBe(1);
    await engineReport({ now: 400_000, probe });
    expect(spawned).toBe(2);
    await engineReport({ now: 401_000, probe, fresh: true });
    expect(spawned).toBe(3);
  });
  test("a healthy probe is kept for half a minute only", async () => {
    __forgetNext();
    let spawned = 0;
    const probe = async () => { spawned++; return report(true)(); };
    await engineReport({ now: 1_000, probe });
    await engineReport({ now: 20_000, probe });
    expect(spawned).toBe(1);
    await engineReport({ now: 40_000, probe });
    expect(spawned).toBe(2);
  });
  test("another seating is another question", async () => {
    __forgetNext();
    let asked = 0;
    const read = async () => { asked++; return null; };
    await nextFor(ROOT, sitting, { now: 1_000, read });
    await nextFor(ROOT, { kind: "claude", model: "sonnet" }, { now: 2_000, read });
    expect(asked).toBe(2);
  });
});
