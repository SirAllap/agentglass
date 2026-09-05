/*
 * The scoped recent-events read answers the same list, faster.
 *
 * `SELECT *` with a filter the index cannot serve makes SQLite sort the whole
 * matching set before it can know which 300 rows are newest, and every row it
 * drags through that sort carries its payload — the prompt, the file contents,
 * the command output. Measured on a real 476 MB cockpit database scoped to one
 * project: 31,090 rows through a temp B-tree, 204 ms of blocked event loop, for
 * 300 rows of answer. Sorting ids and fetching by primary key: 13 ms.
 *
 * The saving is only worth anything if the answer is the same one, so that is
 * what this file asserts — the same rows, in the same order, including the case
 * the rewrite could plausibly get wrong: two events sharing a timestamp, where
 * the tiebreak on id is what decides.
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-recent-"));
const SCOPE = join(dir, "project");
const OUTSIDE = join(dir, "elsewhere");
mkdirSync(SCOPE, { recursive: true });
mkdirSync(OUTSIDE, { recursive: true });
process.env.AGENTGLASS_ROOT = SCOPE;

let mod: typeof import("../src/db.ts");
let ing: typeof import("../src/ingest.ts");

const SESSION = "s-recent-scoped";
/** Rows the scope should keep, newest last as inserted. */
const KEEP = 40;

beforeAll(async () => {
  mod = await import("../src/db.ts");
  ing = await import("../src/ingest.ts");
  /* Through the real ingest path, not a raw INSERT: the scope clause is built
     from the paths the DB is KNOWN to contain, and it is `insertEvent` that
     tells that cache a new path has arrived. A raw insert leaves a cockpit
     scoped to a project it has never heard of, which is an empty answer. */
  const add = (session: string, cwd: string, ts: number) =>
    mod.insertEvent(ing.normalize({
      source_app: "probe", session_id: session, hook_event_type: "PreToolUse",
      timestamp: ts, payload: { cwd, project_path: cwd, big: "x".repeat(2000) },
    } as unknown as Parameters<typeof ing.normalize>[0]));

  for (let i = 0; i < KEEP; i++) {
    // Deliberately one shared timestamp across the newest four rows: the id
    // tiebreak is the part a rewrite can silently reorder.
    const ts = i >= KEEP - 4 ? 1_700_000_000_000 + (KEEP - 2) * 1000 : 1_700_000_000_000 + i * 1000;
    add(SESSION, SCOPE, ts);
  }
  for (let i = 0; i < 25; i++) add(`${SESSION}-out`, OUTSIDE, 1_700_000_500_000 + i * 1000);
});

/** The shape getRecent replaced, kept here so the two can be compared. */
function recentTheOldWay(limit: number) {
  const scope = mod.scopeClause();
  return mod.db
    .query<{ id: number }, (string | number)[]>(
      `SELECT id FROM (SELECT * FROM events WHERE 1=1${scope.clause} ORDER BY timestamp DESC, id DESC LIMIT ?)`
    )
    .all(...scope.args, limit)
    .map((r) => r.id)
    .reverse();
}

describe("getRecent under a workspace scope", () => {
  test("returns the same ids, in the same order, as the row-sorting query", () => {
    expect(mod.scopeClause().clause).not.toBe("");
    const got = mod.getRecent(300).map((e) => e.id);
    expect(got).toEqual(recentTheOldWay(300));
    expect(got.length).toBeGreaterThan(0);
  });

  test("keeps the id tiebreak when timestamps collide", () => {
    const rows = mod.getRecent(300).filter((e) => e.session_id === SESSION);
    const tail = rows.slice(-4);
    // Same timestamp on all four, so the only thing ordering them is the id —
    // ascending, because getRecent hands the client oldest-first.
    expect(new Set(tail.map((e) => e.timestamp)).size).toBe(1);
    expect(tail.map((e) => e.id)).toEqual([...tail.map((e) => e.id)].sort((a, b) => a - b));
  });

  test("still refuses everything outside the scope", () => {
    const apps = mod.getRecent(300);
    expect(apps.some((e) => e.session_id === `${SESSION}-out`)).toBe(false);
  });

  test("a limit that matches nothing comes back empty rather than throwing", () => {
    // The id list is spliced into the second query, and an empty `IN ()` is a
    // syntax error in SQLite — so the empty case has to return before it.
    expect(mod.getRecent(0)).toEqual([]);
  });
});
