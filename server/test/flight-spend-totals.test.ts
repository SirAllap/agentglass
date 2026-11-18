/*
 * Flight plan's builder spend is a running total with a watermark: a read counts only the events newer than the last read,
 * by the same rules as the full scan, so the numbers equal the scan and a list of plans never rescans the week's events.
 */
import { afterAll, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "agx-spend-"));
process.env.AGENTGLASS_DB = join(DIR, "d.db");
const { db, insertEvent } = await import("../src/db.ts");
const Plans = await import("../src/flightPlanStore.ts");
const Budget = await import("../src/flightBudget.ts");
afterAll(() => {
  // Leave the shared database as other files expect it: no bulk events, no launched plan from here.
  for (const t of ["events", "flight_plan", "preflight_run", "flight_spend_day", "flight_spend_mark"]) db.run(`DELETE FROM ${t}`);
  rmSync(DIR, { recursive: true, force: true });
});
// The module registry, and so the database, is shared with every other file of the run: start each test from nothing, or their events, plans and preflight cost leak into the totals.
beforeEach(() => { for (const t of ["events", "flight_plan", "preflight_run", "flight_spend_day", "flight_spend_mark"]) db.run(`DELETE FROM ${t}`); });

const ROOT = "/work/orbit";
const OTHER_ROOT = "/work/acme";
const TREE = "/work/orbit-fp-footer";
let seq = 0;
const row = (usd: number, branch: string, cwd: string, root: string, ts: number) => ({
  source_app: "t", session_id: `s${seq}`, event_id: `e${seq++}`, hook_event_type: "Stop", tool_name: null, tool_use_id: null, agent_id: null, agent_type: null,
  model_name: null, is_error: 0, error_text: null, usage: {}, usage_is_cumulative: false, cost_cumulative: null, reported_cost_usd: usd, summary: null, timestamp: ts,
  payload: { git_branch: branch, cwd, project_path: root }, chat: null,
}) as never;
const turn = (usd: number, branch: string, cwd: string, root = ROOT, ts = Date.now()) => insertEvent(row(usd, branch, cwd, root, ts));
const scan = (since: number) => Budget.spentSince(since, { preflight: () => 0 });
// A changed signature recounts in the background: the first read returns at once, so settle it, then read again.
const settled = async (now = Date.now()) => { Budget.budgetState(now); await Budget.settleRecounts(); return Budget.budgetState(now); };
const same = async () => {
  const now = Date.now(), s = await settled(now);
  expect(s.dayUsd).toBeCloseTo(scan(Budget.dayStart(now)), 6);
  expect(s.weekUsd).toBeCloseTo(scan(Budget.weekStart(now)), 6);
  return s;
};
// The SQL every db.query call of `fn` prepared: what ran inside the call, not how long it took.
const sqlOf = <T>(fn: () => T): { out: T; sql: string[] } => {
  const spy = spyOn(db, "query");
  try { const out = fn(); return { out, sql: spy.mock.calls.map((c) => String(c[0])) }; } finally { spy.mockRestore(); }
};
const launch = (title: string, tree: string) => {
  const p = Plans.createPlan({ root: ROOT, title, request: "r", visual: false });
  db.run(`UPDATE flight_plan SET state = 'go' WHERE id = ?`, [p.id]);
  Plans.markLaunched(p.id, { branch: `flight-plan/${title}`, worktree: tree });
  return p;
};

describe("flight spend totals", () => {
  test("a turn written before the plan is launched, or in another root, counts as the scan counts it", async () => {
    turn(3, "flight-plan/footer", TREE);                   // before launch: the scan counts it once launched
    turn(5, "flight-plan/other", "/work/acme-fp-x", OTHER_ROOT);   // a root with no launched plan
    expect((await same()).dayUsd).toBe(0);                         // nothing launched: nothing counted
    const p = launch("footer", TREE);
    expect((await same()).dayUsd).toBeCloseTo(3);                  // launch recounts the root once
    turn(2, "flight-plan/footer", TREE);
    turn(1.5, "feat/renamed", `${TREE}/web`);              // in a launched tree, branch renamed
    turn(9, "feat/mine", "/work/orbit-other");             // not a builder's
    turn(7, "flight-plan/other", "/work/acme-fp-x", OTHER_ROOT);   // builder branch, root not launched
    expect((await same()).dayUsd).toBeCloseTo(6.5);
    db.query(`UPDATE flight_plan SET state = 'go', launched = NULL WHERE id = ?`).run(p.id);   // leaves launched
    expect((await same()).dayUsd).toBe(0);
    Plans.markLaunched(p.id, { branch: "flight-plan/footer", worktree: TREE });
    expect((await same()).dayUsd).toBeCloseTo(6.5);
  });

  test("an event written with the module not loaded, and one in a symlinked cwd, are counted on the next read", async () => {
    launch("footer", TREE);                                // each test sets up its own launched plan
    mkdirSync(join(DIR, "real")); symlinkSync(join(DIR, "real"), join(DIR, "link"));
    const before = (await settled()).dayUsd;
    // straight into the table: no insertEvent, no hook, as an older build on the same database would write it
    const r = row(4, "flight-plan/footer", TREE, ROOT, Date.now()) as { payload: unknown };
    db.query(`INSERT INTO events (source_app, session_id, event_id, hook_event_type, payload, timestamp, cost_usd) VALUES ('t', 'old', 'old1', 'Stop', ?, ?, 4)`).run(JSON.stringify(r.payload), Date.now());
    turn(1, "x", join(DIR, "link"), ROOT);                 // spelled through a symlink: the scan's COALESCE sees the same string
    expect((await same()).dayUsd).toBeCloseTo(before + 4);
  });

  test("totals equal the full scan on a seeded set, across the week", async () => {
    launch("footer", TREE);
    const now = Date.now(), old = Budget.weekStart(now) + 3_600_000;
    for (let i = 0; i < 40; i++) turn(0.25 + (i % 5) * 0.1, i % 3 ? "flight-plan/footer" : "feat/x", i % 4 ? TREE : "/work/elsewhere", i % 5 ? ROOT : OTHER_ROOT, i % 2 ? now - i * 1000 : old + i * 1000);
    const s = await same();
    expect(s.weekUsd).toBeGreaterThan(s.dayUsd - 1e-9);
  });

  test("a second read with no new events does not scan them", async () => {
    launch("footer", TREE);
    const now = Date.now();
    await settled(now);                                    // the launch's own recount is not what is timed
    db.transaction(() => { for (let i = 0; i < 20000; i++) db.query(`INSERT INTO events (source_app, session_id, event_id, hook_event_type, payload, timestamp, cost_usd) VALUES ('t', 'bulk', ?, 'Stop', ?, ?, 0.01)`).run(`b${i}`, JSON.stringify({ git_branch: "feat/x", cwd: "/work/orbit-bulk", project_path: ROOT }), now); })();
    await settled(now);                                     // the 20000 new events are counted once, here
    // What the second read runs, not how long it takes: a fast machine makes the clock say nothing. The watermark has caught up, so its id range is empty, and no recount query runs.
    const mark = db.query<{ last_id: number }, []>(`SELECT last_id FROM flight_spend_mark`).get()?.last_id;
    expect(mark).toBe(db.query<{ m: number }, []>(`SELECT MAX(id) AS m FROM events`).get()?.m);
    const { sql } = sqlOf(() => Budget.budgetState(now));
    expect(sql.some((q) => q.includes("MIN(id)") || q.includes("AND timestamp >= ?"))).toBe(false);
    await same();
  });
});

describe("flight spend rebuild is bounded to the week", () => {
  test("launching a second plan after old events were pruned leaves the week total unchanged; days before the week are untouched", async () => {
    setSystemTime(new Date(2026, 10, 12, 12, 0, 0));          // a Thursday
    try {
      const now = Date.now(), wk = Budget.weekStart(now), DAY = 86_400_000;
      launch("a", "/work/orbit-fp-a");
      turn(3, "flight-plan/a", "/work/orbit-fp-a", ROOT, wk + 3_600_000);   // Monday
      turn(2, "flight-plan/a", "/work/orbit-fp-a", ROOT, now - 1000);       // today
      expect((await settled(now)).weekUsd).toBeCloseTo(5);
      db.query(`INSERT INTO flight_spend_day (root, day_start, usd) VALUES (?, ?, 40)`).run(ROOT, wk - 2 * DAY);   // last week: not the rebuild's to touch
      db.run(`DELETE FROM events WHERE timestamp < ?`, [now - DAY]);   // retention prunes Monday
      launch("b", "/work/orbit-fp-b");                                  // signature changes
      expect((await settled(now)).weekUsd).toBeCloseTo(5);
      expect(db.query<{ usd: number }, [string, number]>(`SELECT usd FROM flight_spend_day WHERE root = ? AND day_start = ?`).get(ROOT, wk - 2 * DAY)?.usd).toBe(40);
      // bounded: the rebuild query reads no event older than the week
      turn(7, "flight-plan/a", "/work/orbit-fp-a", ROOT, wk - 3 * DAY);
      launch("c", "/work/orbit-fp-c");
      expect((await settled(now)).weekUsd).toBeCloseTo(2 + 3);
    // No argument: setSystemTime(date) freezes the clock at that date, and every later file in the process then
    // waits forever on a Date.now() that never moves (the server suite spun at 100% CPU after this file).
    } finally { setSystemTime(); }
  });

  test("a swap after retention removed staged events does not add onto the old row of that day", async () => {
    setSystemTime(new Date(2026, 10, 12, 12, 0, 0));
    try {
      const now = Date.now(), wk = Budget.weekStart(now);
      launch("a", "/work/orbit-fp-a");
      turn(3, "flight-plan/a", "/work/orbit-fp-a", ROOT, wk + 3_600_000);   // Monday
      turn(2, "flight-plan/a", "/work/orbit-fp-a", ROOT, now - 1000);       // today
      await settled(now);
      launch("b", "/work/orbit-fp-b");
      const orig = db.query.bind(db);
      const spy = spyOn(db, "query").mockImplementation(((sql: string) => {
        if (sql.includes("MIN(timestamp)")) { spy.mockRestore(); db.run(`DELETE FROM events WHERE timestamp < ?`, [now - 86_400_000]); }   // retention runs between the last chunk and the swap
        return orig(sql);
      }) as never);
      try { await settled(now); } finally { spy.mockRestore(); }
      expect(db.query<{ usd: number }, [string, number]>(`SELECT usd FROM flight_spend_day WHERE root = ? AND day_start = ?`).get(ROOT, Budget.dayStart(wk + 3_600_000))?.usd).toBeCloseTo(3);
    } finally { setSystemTime(); }
  });

  test("two boots with different paths recorded and the same events recount nothing", async () => {
    launch("footer", TREE);
    const now = Date.now();
    turn(1, "flight-plan/footer", TREE, ROOT, now - 2000);
    turn(1, "flight-plan/footer", `${ROOT}/fp-b`, ROOT, now - 1500);
    await settled(now);
    const sig = () => db.query<{ sig: string }, [string]>(`SELECT sig FROM flight_spend_mark WHERE root = ?`).get(ROOT)!.sig;
    const before = sig(), day = Budget.budgetState(now).dayUsd;
    // another boot: a new path recorded in scope, and a row planted in the day table that a recount would wipe
    turn(1, "x", `${ROOT}/fp-a`, ROOT, now - 1000);
    db.query(`INSERT INTO flight_spend_day (root, day_start, usd) VALUES (?, ?, 100)`).run(ROOT, Budget.dayStart(now) - 86_400_000);
    Budget.budgetState(now);
    await Budget.settleRecounts();                          // a recount, if one started, has finished: its wipe shows below
    expect(sig()).toBe(before);
    expect(JSON.parse(before)).toEqual([TREE]);            // launched trees only: no build id, no path list
    expect(db.query<{ usd: number }, [string]>(`SELECT usd FROM flight_spend_day WHERE root = ? AND usd = 100`).get(ROOT)).not.toBeNull();
    expect(Budget.budgetState(now).dayUsd).toBeCloseTo(day);
  });

  test("a real scope change returns at once and recounts in the background", async () => {
    launch("footer", TREE);
    const now = Date.now();
    turn(2, "flight-plan/footer", TREE, ROOT, now - 1000);
    await settled(now);
    launch("second", "/work/orbit-fp-second");
    turn(3, "flight-plan/second", "/work/orbit-fp-second", ROOT, now - 500);
    const { out: during, sql } = sqlOf(() => Budget.budgetState(now).dayUsd);
    expect(during).toBeCloseTo(2);                         // old totals stand while the recount runs
    expect(sql.some((q) => q.includes("MIN(id)") || q.includes("AND timestamp >= ?"))).toBe(false);   // the request ran no recount query, not even the first chunk
    await Budget.settleRecounts();
    expect(Budget.budgetState(now).dayUsd).toBeCloseTo(5);
    await same();
  });

  test("events written between the recount's start and its swap are counted once", async () => {
    launch("footer", TREE);
    const now = Date.now();
    turn(2, "flight-plan/footer", TREE, ROOT, now - 1000);
    await settled(now);
    launch("second", "/work/orbit-fp-second");
    Budget.budgetState(now);                               // recount starts, has not read yet
    turn(3, "flight-plan/second", "/work/orbit-fp-second", ROOT, now - 500);
    expect((await same()).dayUsd).toBeCloseTo(5);
  });

  test("a week bigger than one recount chunk is counted whole", async () => {
    const now = Date.now(), n = Budget.RECOUNT_CHUNK + 5;
    db.transaction(() => { for (let i = 0; i < n; i++) db.query(`INSERT INTO events (source_app, session_id, event_id, hook_event_type, payload, timestamp, cost_usd) VALUES ('t', 'bulk', ?, 'Stop', ?, ?, 0.01)`).run(`c${i}`, JSON.stringify({ git_branch: "flight-plan/footer", cwd: TREE, project_path: ROOT }), now); })();
    launch("footer", TREE);
    expect((await same()).weekUsd).toBeCloseTo(n * 0.01, 4);
  });

  test("a plan unlaunched during a recount leaves no rows behind", async () => {
    const p = launch("footer", TREE);
    turn(2, "flight-plan/footer", TREE);
    Budget.budgetState();                                  // recount starts
    db.query(`UPDATE flight_plan SET state = 'go', launched = NULL WHERE id = ?`).run(p.id);
    await Budget.settleRecounts();
    expect(db.query<{ n: number }, []>(`SELECT (SELECT COUNT(*) FROM flight_spend_day) + (SELECT COUNT(*) FROM flight_spend_mark) AS n`).get()?.n).toBe(0);
  });

  test("trees that change again during a recount start a fresh recount", async () => {
    launch("footer", TREE);
    const now = Date.now();
    turn(1, "flight-plan/footer", TREE, ROOT, now - 3000);
    await settled(now);
    launch("second", "/work/orbit-fp-second");
    Budget.budgetState(now);                               // recount for [footer, second]
    launch("third", "/work/orbit-fp-third");               // changes again while it runs
    turn(4, "flight-plan/third", "/work/orbit-fp-third", ROOT, now - 500);
    await Budget.settleRecounts();
    expect(JSON.parse(db.query<{ sig: string }, [string]>(`SELECT sig FROM flight_spend_mark WHERE root = ?`).get(ROOT)!.sig)).toHaveLength(3);
    expect((await same()).dayUsd).toBeCloseTo(5);
  });

  test("events far behind the mark are caught up in the background, the read returns the totals as they stand", async () => {
    launch("footer", TREE);
    const now = Date.now();
    turn(2, "flight-plan/footer", TREE, ROOT, now - 1000);
    await settled(now);
    const n = Budget.RECOUNT_CHUNK + 5;
    db.transaction(() => { for (let i = 0; i < n; i++) db.query(`INSERT INTO events (source_app, session_id, event_id, hook_event_type, payload, timestamp, cost_usd) VALUES ('t', 'gap', ?, 'Stop', ?, ?, 0.01)`).run(`g${i}`, JSON.stringify({ git_branch: "flight-plan/footer", cwd: TREE, project_path: ROOT }), now); })();
    const { out, sql } = sqlOf(() => Budget.budgetState(now).dayUsd);
    expect(out).toBeCloseTo(2);
    expect(sql.some((q) => q.includes("id > ?"))).toBe(false);   // no event read inside the request
    await Budget.settleRecounts();
    expect(Budget.budgetState(now).dayUsd).toBeCloseTo(2 + n * 0.01, 4);
  });

  const gap = (now: number) => {
    const n = Budget.RECOUNT_CHUNK + 5;
    db.transaction(() => { for (let i = 0; i < n; i++) db.query(`INSERT INTO events (source_app, session_id, event_id, hook_event_type, payload, timestamp, cost_usd) VALUES ('t', 'gap', ?, 'Stop', ?, ?, 0.01)`).run(`g${i}`, JSON.stringify({ git_branch: "flight-plan/footer", cwd: TREE, project_path: ROOT }), now); })();
    return n;
  };
  // Make queries that match `bad` throw; the rest run as normal. Returns how many threw.
  const failing = (bad: (q: string) => boolean) => {
    const real = db.query.bind(db) as (q: string) => unknown;
    let threw = 0;
    const spy = spyOn(db, "query").mockImplementation(((q: string) => { if (bad(String(q))) { threw++; throw new Error("boom"); } return real(q); }) as never);
    return { count: () => threw, stop: () => spy.mockRestore() };
  };

  test("a failed catch-up backs off by itself and does not block a recount", async () => {
    launch("footer", TREE);
    const now = Date.now();
    turn(2, "flight-plan/footer", TREE, ROOT, now - 1000);
    await settled(now);
    gap(now);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const f = failing((q) => q.includes("id <= ?") && !q.includes("timestamp >= ?"));   // the catch-up's chunk query only
    try {
      Budget.budgetState(now); await Budget.settleRecounts();
      Budget.budgetState(now); Budget.budgetState(now); await Budget.settleRecounts();
      expect(f.count()).toBe(1);                           // three reads, one try: the catch-up waits
      launch("second", "/work/orbit-fp-second");
      Budget.budgetState(now); await Budget.settleRecounts();
      expect(JSON.parse(db.query<{ sig: string }, [string]>(`SELECT sig FROM flight_spend_mark WHERE root = ?`).get(ROOT)!.sig)).toHaveLength(2);   // the recount ran
    } finally { f.stop(); warn.mockRestore(); }
  });

  test("a far-behind mark with a stale signature keeps counting under the mark's own signature", async () => {
    setSystemTime(new Date(Date.now() + 10_000));          // backoff is module state: the previous test's failed catch-up must have expired
    launch("footer", TREE);
    const now = Date.now();
    turn(2, "flight-plan/footer", TREE, ROOT, now - 1000);
    await settled(now);
    const n = gap(now);
    launch("second", "/work/orbit-fp-second");             // signature is now stale
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const f = failing((q) => q.includes("MIN(id)"));       // the recount fails, so it backs off and the mark stays stale
    try {
      Budget.budgetState(now); await Budget.settleRecounts();
      expect(f.count()).toBe(1);
      Budget.budgetState(now); await Budget.settleRecounts();   // far behind, stale signature, recount backing off: catch-up
      expect(JSON.parse(db.query<{ sig: string }, [string]>(`SELECT sig FROM flight_spend_mark WHERE root = ?`).get(ROOT)!.sig)).toHaveLength(1);
      expect(Budget.budgetState(now).dayUsd).toBeCloseTo(2 + n * 0.01, 4);
    } finally { f.stop(); warn.mockRestore(); setSystemTime(); }
  });
});
