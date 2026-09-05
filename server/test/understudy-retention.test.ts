/*
 * What the understudy throws away, and the one thing it must throw away even
 * when the user has switched retention off.
 *
 * Two windows, and they are not the same window on purpose. A sealed situation
 * is the evidence behind one disagreement — useful while somebody might still
 * open it, worthless a month later — so it dies at thirty days. The bare fact
 * that a write happened is a stub, and it dies at ninety. What never dies is a
 * scored decision or a fence: those are the score itself, and a score with
 * holes in it is not a score, it is a number that flatters whichever period
 * survived.
 *
 * The last test is the reason both sweeps sit ABOVE the `if (!RETENTION_DAYS)
 * return` in pruneOldRows. AGENTGLASS_RETENTION_DAYS is the user's to set and 0
 * is a legitimate value meaning "keep the events". If the understudy's expiry
 * hung off that switch, somebody turning event pruning off would silently stop
 * the sealed situations expiring too — a store holding the material the
 * understudy read, growing without bound, because of a setting about something
 * else entirely. It runs in its own process because RETENTION_DAYS is read once
 * at module load, which is exactly how the real server reads it.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "agx-understudy-retention-"));
process.env.AGENTGLASS_DB = join(dir, "retention.db");
process.env.XDG_CONFIG_HOME = dir;

const DAY = 86_400_000;
const daysAgo = (n: number) => Date.now() - n * DAY;

let DB: typeof import("../src/db.ts");
beforeAll(async () => { DB = await import("../src/db.ts"); });

beforeEach(() => {
  DB.db.run("DELETE FROM understudy_snapshots");
  DB.db.run("DELETE FROM understudy_ledger");
});

const snapshot = (hash: string, at: number) =>
  DB.db.run("INSERT INTO understudy_snapshots (hash, at, body) VALUES (?, ?, '{}')", [hash, at]);
const ledger = (kind: string, at: number) =>
  DB.db.run("INSERT INTO understudy_ledger (kind, class, sealed_at) VALUES (?, 'C1', ?)", [kind, at]);
const hashes = () => DB.db.query<{ hash: string }, []>(
  "SELECT hash FROM understudy_snapshots ORDER BY hash").all().map((r) => r.hash);
const kinds = () => DB.db.query<{ kind: string }, []>(
  "SELECT kind FROM understudy_ledger ORDER BY kind").all().map((r) => r.kind);

describe("the thirty-day window on sealed situations", () => {
  test("a month-old snapshot goes and a two-day-old one stays", () => {
    expect(DB.UNDERSTUDY_SNAPSHOT_DAYS).toBe(30);
    snapshot("old", daysAgo(31));
    snapshot("fresh", daysAgo(2));
    const { snapshots } = DB.pruneOldRows();
    expect(snapshots).toBe(1);
    expect(hashes()).toEqual(["fresh"]);
  });

  test("the count comes back beside the others rather than instead of them", () => {
    // Every caller destructures pruneOldRows by name, so an added field is
    // additive — but only if the object carries the old ones too. index.ts
    // logs `events`/`sessions`/`rolled` off this same return.
    snapshot("old", daysAgo(31));
    const out = DB.pruneOldRows();
    expect(Object.keys(out).sort()).toEqual(["events", "rolled", "sessions", "snapshots", "stubs"]);
  });
});

describe("the ninety-day window on stubs", () => {
  test("a stub of that age goes; a decision of exactly the same age stays", () => {
    expect(DB.UNDERSTUDY_STUB_DAYS).toBe(90);
    ledger("stub", daysAgo(91));
    ledger("decision", daysAgo(91));
    ledger("fence", daysAgo(91));
    ledger("stub", daysAgo(2));
    const { stubs } = DB.pruneOldRows();
    expect(stubs).toBe(1);
    // The young stub, and both of the rows that have no expiry at any age.
    expect(kinds()).toEqual(["decision", "fence", "stub"]);
  });

  test("an ancient decision is still there — this is the promise, not an edge case", () => {
    ledger("decision", daysAgo(900));
    DB.pruneOldRows();
    expect(kinds()).toEqual(["decision"]);
  });
});

describe("with event retention switched off", () => {
  test("the sealed situations still expire", () => {
    const dbPath = join(dir, "retention-off.db");
    const moduleUrl = pathToFileURL(join(import.meta.dir, "..", "src", "db.ts")).href;
    const script = `
      process.env.AGENTGLASS_RETENTION_DAYS = "0";
      process.env.AGENTGLASS_DB = ${JSON.stringify(dbPath)};
      process.env.AGENTGLASS_ROOT = ${JSON.stringify(dir)};
      process.env.XDG_CONFIG_HOME = ${JSON.stringify(dir)};
      const M = await import(${JSON.stringify(moduleUrl)});
      const day = 86400000, now = Date.now();
      M.db.run("INSERT INTO understudy_snapshots (hash, at, body) VALUES ('old', ?, '{}')", [now - 31 * day]);
      M.db.run("INSERT INTO understudy_snapshots (hash, at, body) VALUES ('fresh', ?, '{}')", [now - 2 * day]);
      M.db.run("INSERT INTO understudy_ledger (kind, sealed_at) VALUES ('stub', ?)", [now - 91 * day]);
      M.db.run("INSERT INTO understudy_ledger (kind, sealed_at) VALUES ('decision', ?)", [now - 91 * day]);
      const out = M.pruneOldRows();
      process.stdout.write(JSON.stringify({
        retention: M.RETENTION_DAYS,
        out,
        left: M.db.query("SELECT hash FROM understudy_snapshots ORDER BY hash").all().map((r) => r.hash),
        kinds: M.db.query("SELECT kind FROM understudy_ledger ORDER BY kind").all().map((r) => r.kind),
      }));
      M.db.close();
    `;
    const child = Bun.spawnSync([process.execPath, "--eval", script], {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe", stderr: "pipe",
    });
    expect(child.stderr.toString()).toBe("");
    expect(child.exitCode).toBe(0);
    const got = JSON.parse(child.stdout.toString());
    // The switch really is off — otherwise this test proves nothing at all.
    expect(got.retention).toBe(0);
    expect(got.left).toEqual(["fresh"]);
    expect(got.kinds).toEqual(["decision"]);
    expect(got.out).toEqual({ events: 0, sessions: 0, rolled: 0, snapshots: 1, stubs: 1 });
  });
});

describe("the actuator's tables expire too", () => {
  /*
   * The queue, the shifts and the acts arrived with the actuator and arrived
   * without a window. Every other table in this feature had one decided when it
   * was written; these three did not, which is how a store grows without bound
   * — not by anybody deciding to keep everything, but by three tables being
   * added on an afternoon when the interesting question was whether it worked.
   *
   * The windows are deliberately not the same, and the two exceptions are the
   * point of the test:
   *
   *   a PENDING proposal never expires. It is the understudy waiting on a
   *   person, and expiring it would answer for them by doing nothing.
   *
   *   an act that has NOT been undone is never swept. The undo recipe is the
   *   only way back from something that happened while they were away, and
   *   deleting it decides on their behalf that they no longer want one.
   */
  test("resolved proposals expire, pending ones never do", async () => {
    const src = await Bun.file(new URL("../src/db.ts", import.meta.url)).text();
    const block = src.slice(src.indexOf("DELETE FROM understudy_proposals"), src.indexOf("void proposals"));
    expect(block).toContain("state <> 'pending'");
  });

  test("a shift that is still running is never swept", async () => {
    const src = await Bun.file(new URL("../src/db.ts", import.meta.url)).text();
    expect(src).toContain("DELETE FROM understudy_shifts WHERE state <> 'running'");
  });

  test("an act that has not been undone is kept, whatever its age", async () => {
    // The strongest of the three, because it is the row somebody comes back to
    // the machine looking for.
    const src = await Bun.file(new URL("../src/db.ts", import.meta.url)).text();
    expect(src).toContain("DELETE FROM understudy_acts WHERE undone_at IS NOT NULL");
  });

  test("all three sweep above the retention switch, like the other two", async () => {
    /*
     * `AGENTGLASS_RETENTION_DAYS` is the user's setting about EVENTS, and the
     * early return it drives is about the fold-then-delete transaction on that
     * table. None of the understudy's sweeps share an invariant with it, so
     * none of them sit below it — a sweep that could roll back a day of rollup
     * would be the wrong shape whatever its window. Whether a sweep HONOURS the
     * value is a separate question, answered per table just below.
     */
    const src = await Bun.file(new URL("../src/db.ts", import.meta.url)).text();
    const guard = src.indexOf("if (!RETENTION_DAYS) return");
    expect(src.indexOf("DELETE FROM understudy_proposals")).toBeLessThan(guard);
    expect(src.indexOf("DELETE FROM understudy_shifts")).toBeLessThan(guard);
    expect(src.indexOf("DELETE FROM understudy_acts")).toBeLessThan(guard);
  });
});

describe("the record of what ran unattended honours \"keep for ever\"", () => {
  /*
   * Shifts, acts and runs are not scaffolding. Each row says an agent did
   * something on this machine with permissions skipped and nobody watching.
   * `AGENTGLASS_RETENTION_DAYS=0` is the user asking for his history to be kept,
   * and these were the three tables that ignored him: his own raw prompts were
   * kept for ever while the record of what ran in his name was swept at ninety
   * days. The rest of the feature — snapshots, stubs, proposals, the queue's
   * marks — keeps its own clock, for the reason the earlier tests give: a
   * setting about events must not let the understudy's scratch grow unbounded.
   *
   * Two child processes, because RETENTION_DAYS is read once at module load,
   * exactly as the server reads it.
   */
  const run = (retention: string, dbName: string) => {
    const dbPath = join(dir, dbName);
    const moduleUrl = pathToFileURL(join(import.meta.dir, "..", "src", "db.ts")).href;
    const script = `
      process.env.AGENTGLASS_RETENTION_DAYS = ${JSON.stringify(retention)};
      process.env.AGENTGLASS_DB = ${JSON.stringify(dbPath)};
      process.env.AGENTGLASS_ROOT = ${JSON.stringify(dir)};
      process.env.XDG_CONFIG_HOME = ${JSON.stringify(dir)};
      const M = await import(${JSON.stringify(moduleUrl)});
      const day = 86400000, now = Date.now(), old = now - 200 * day;
      M.db.run("INSERT INTO understudy_shifts (goal, started_at, ends_at, state) VALUES ('night', ?, ?, 'done')", [old, old + 3600000]);
      M.db.run("INSERT INTO understudy_acts (shift_id, title, at, undone_at) VALUES (1, 'reverted', ?, ?)", [old, old + 60000]);
      M.db.run("INSERT INTO understudy_work (shift_id, source, item_id, title, repo, worktree, branch, started_at, state) VALUES (NULL, 'asked', 'asked:1', 'fixed', '/r', '/w', 'b', ?, 'done')", [old]);
      M.db.run("INSERT INTO understudy_proposals (class, title, state, created_at) VALUES ('C1', 'draft', 'sent', ?)", [old]);
      M.pruneOldRows();
      const count = (t) => M.db.query("SELECT COUNT(*) AS n FROM " + t).get().n;
      process.stdout.write(JSON.stringify({
        retention: M.RETENTION_DAYS,
        shifts: count("understudy_shifts"), acts: count("understudy_acts"),
        work: count("understudy_work"), proposals: count("understudy_proposals"),
      }));
      M.db.close();
    `;
    const child = Bun.spawnSync([process.execPath, "--eval", script], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    expect(child.stderr.toString()).toBe("");
    expect(child.exitCode).toBe(0);
    return JSON.parse(child.stdout.toString()) as { retention: number; shifts: number; acts: number; work: number; proposals: number };
  };

  test("with the switch at 0 a finished shift, an undone act and a finished run outlive the window", () => {
    const got = run("0", "keep-forever.db");
    expect(got.retention).toBe(0);
    expect(got.shifts, "a shift that ran unattended was swept under keep-for-ever").toBe(1);
    expect(got.acts, "an act that ran unattended was swept under keep-for-ever").toBe(1);
    expect(got.work, "a run that ran unattended was swept under keep-for-ever").toBe(1);
    /* And the scaffolding still goes: a sent proposal is a draft nobody wants
       a month later, whatever the events setting says. */
    expect(got.proposals).toBe(0);
  });

  test("with the switch at its default the same rows go at ninety days, as before", () => {
    const got = run("8", "keep-ninety.db");
    expect(got.retention).toBe(8);
    expect(got).toMatchObject({ shifts: 0, acts: 0, work: 0, proposals: 0 });
  });
});

describe("every understudy table has a window, enumerated", () => {
  /*
   * THIS GAP HAS NOW BEEN OPENED TWICE, the same way both times.
   *
   * The queue, the shifts and the acts arrived without any expiry and were
   * given one. Then the work loop arrived with two more tables and no expiry —
   * by the identical route: tables added on an afternoon when the interesting
   * question was whether the thing worked at all, and retention is never the
   * interesting question on that afternoon.
   *
   * Writing the rule down in a comment did not stop it happening again. So the
   * rule is enumerated here instead: every table this feature creates must be
   * swept, and a new one fails this test until somebody has decided what its
   * window is. Deciding "never" is allowed — it just has to be a decision
   * somebody made rather than one nobody noticed.
   */
  test("no understudy table grows without bound", async () => {
    const src = await Bun.file(new URL("../src/db.ts", import.meta.url)).text();

    const created = [...src.matchAll(/CREATE TABLE IF NOT EXISTS (understudy_\w+)/g)].map((m) => m[1]!);
    expect(created.length, "there should be understudy tables to check").toBeGreaterThan(5);

    /*
     * Tables whose rows ARE the score, and which have no expiry by decision.
     * Named individually, with the reason, so that "no sweep" is never the
     * default answer for a table nobody thought about.
     */
    const forever: Record<string, string> = {
      understudy_ledger: "scored decisions and fences ARE the score; a score with holes is not a score",
      understudy_precedents: "the bank is what it learned; it expires when he unticks a source, not on a clock",
      understudy_precedents_fts: "the index over the bank, and it lives and dies with it",
      understudy_quarantine: "what it refused to store — counts only, and they are the privacy record",
      understudy_hold: "one row, overwritten: the nap until the agent's session resets — cleared by writing zero, never grows",
    };

    const swept = new Set([...src.matchAll(/DELETE FROM (understudy_\w+)/g)].map((m) => m[1]!));
    const orphans = created.filter((t) => !swept.has(t) && !(t in forever));

    expect(
      orphans,
      `these grow for ever and nobody decided that:\n${orphans.join("\n")}\n` +
      "Give each one a sweep in pruneOldRows, or add it to `forever` with the reason.",
    ).toEqual([]);
  });

  test("a task worked before the queue kept its own mark still expires", async () => {
    /*
     * The row that made this necessary was sitting on a real machine: worked
     * start to finish, and `taken_at` still NULL, because for a while nothing
     * wrote it. The queue's reader consults BOTH records and correctly stops
     * offering that row as work — so a sweep trusting `taken_at` alone leaves
     * it invisible in the app and permanent on disk. That is the exact shape
     * of bug the sweep exists to close, reappearing inside the fix for it.
     */
    DB.db.run("DELETE FROM understudy_asked");
    DB.db.run("DELETE FROM understudy_work");

    // Worked to completion, and the queue's own mark never written — the state
    // the real rows were found in.
    const worked = DB.db
      .query<{ id: number }, [number]>(
        "INSERT INTO understudy_asked (title, detail, repo, at) VALUES ('worked', '', '/r', ?) RETURNING id",
      )
      .get(daysAgo(200))!.id;
    DB.db.run(
      `INSERT INTO understudy_work (shift_id, source, item_id, title, repo, worktree, branch, started_at, state)
       VALUES (NULL, 'asked', ?, 'worked', '/r', '/w', 'b', ?, 'done')`,
      [`asked:${worked}`, daysAgo(200)],
    );
    // Just as old, and nobody ever started it. This one is him still waiting.
    DB.db.run(
      "INSERT INTO understudy_asked (title, detail, repo, at) VALUES ('waiting', '', '/r', ?)",
      [daysAgo(200)],
    );

    DB.pruneOldRows();

    const left = DB.db.query<{ title: string }, []>("SELECT title FROM understudy_asked").all().map((r) => r.title);
    expect(left, "a row worked start to finish outlived the window").toEqual(["waiting"]);
  });

  test("a run that never finished is kept, and a task still queued is too", async () => {
    /*
     * The two exceptions, and they match the ones the earlier tables already
     * carry. A row saying "started, never finished" is the only record that an
     * agent was killed mid-task. And a queued task is him waiting to be worked
     * for — expiring it answers on his behalf by doing nothing.
     */
    const src = await Bun.file(new URL("../src/db.ts", import.meta.url)).text();
    expect(src).toContain("DELETE FROM understudy_work WHERE state <> 'running'");
    expect(src).toContain("DELETE FROM understudy_asked");
    expect(src).toContain("WHERE at < ?");
  });
});
