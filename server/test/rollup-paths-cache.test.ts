/*
 * The rollup's path list has to see rows written after it was first read.
 *
 * ── what this guards ─────────────────────────────────────────────────────
 * `rollupScopeClause()` filters daily_rollup by the set of project paths the
 * rollup contains, and that set was cached on first read and dropped only in
 * the prune, on the stated ground that the prune is the only writer. True of
 * the product, false as an invariant — and the failure is silent in the worst
 * way: a project missing from the cached list has its entire folded history
 * filtered out. Not short by a row. Absent. And the days that disappear are
 * exactly the ones the rollup exists to keep, whose events have been deleted,
 * so nothing else can put them back.
 *
 * ── how it was found ─────────────────────────────────────────────────────
 * `bun test` shares one process across suites. A suite that read the rollup
 * while it was empty warmed the cache for every suite after it; a suite that
 * then wrote its own rows directly was invisible to its own scope. CI was green
 * for months and went red on an unchanged commit, when the runner's file order
 * changed. The tell was which day vanished: the rollup-ONLY day, while the day
 * that also had live events survived on its events half.
 *
 * So this test warms the cache first, deliberately, because reading an empty
 * rollup is the step that used to poison everything after it.
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-rollup-cache-"));
const ROOT = join(dir, "proj");
const PKG = join(ROOT, "packages", "api");
const OTHER = join(dir, "elsewhere");
mkdirSync(PKG, { recursive: true });
mkdirSync(OTHER, { recursive: true });
// A repository, so `resolveScope` stops here rather than at whatever the
// machine's temp directory happens to sit inside.
Bun.spawnSync(["git", "init", "-q", ROOT], { stdout: "ignore", stderr: "ignore" });
process.env.AGENTGLASS_DB = join(dir, "cache.db");
process.env.AGENTGLASS_ROOT = ROOT;
process.env.XDG_CONFIG_HOME = dir;

let db: typeof import("../src/db.ts");

const fold = (day: string, path: string, events: number) =>
  db.db.run(
    `INSERT INTO daily_rollup (day, project_path, session_id, source_app, model_name, provider,
       events, tool_calls, tool_errors, errors, input_tokens, output_tokens,
       cache_creation_tokens, cache_read_tokens, cost_usd, duration_ms_total, timed_calls)
     VALUES (?, ?, ?, 'proj', 'claude-opus-4-8', 'anthropic', ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0)`,
    [day, path, `s-${day}-${path}`, events, events],
  );

beforeAll(async () => {
  db = await import("../src/db.ts");
});

describe("the rollup's path set", () => {
  test("an empty rollup answers empty, and does not pin that answer", () => {
    // The poisoning step, on purpose.
    expect(db.rollupDays()).toEqual([]);
  });

  test("a day written after that read is visible", () => {
    fold("2026-07-27", PKG, 7);
    expect(db.rollupDays().map((d) => d.day)).toEqual(["2026-07-27"]);
    expect(db.rollupDays()[0]!.events).toBe(7);
  });

  test("and so is a second one, written after the first was read", () => {
    // Two writes rather than one: a cache keyed on "have I ever answered" is
    // fixed by any re-read, and would pass with only the test above.
    fold("2026-07-28", PKG, 3);
    expect(db.rollupDays().map((d) => d.day)).toEqual(["2026-07-27", "2026-07-28"]);
  });

  test("a row outside the scope is still excluded", () => {
    // The fix makes the list current. It must not make it permissive.
    fold("2026-07-29", OTHER, 99);
    const days = db.rollupDays().map((d) => d.day);
    expect(days).toEqual(["2026-07-27", "2026-07-28"]);
  });

  test("a delete that leaves the count alone is still noticed", () => {
    /* The reason the stamp carries MAX(rowid) and not COUNT(*) alone: removing
       one row and adding another leaves the count identical, and a cache keyed
       on the count would keep answering with the path that is gone. */
    db.db.run("DELETE FROM daily_rollup WHERE day = '2026-07-28'");
    fold("2026-07-30", PKG, 1);
    expect(db.rollupDays().map((d) => d.day)).toEqual(["2026-07-27", "2026-07-30"]);
  });
});
