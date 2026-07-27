// #292 built the rollup so the numbers outlive the rows. Nothing read it.
//
// So the dashboard kept answering "last 30d" and "all time" from the events
// table alone, which retention trims to 8 days — thirty days of label over
// eight days of data, and the difference between "we spent nothing" and "we no
// longer keep that". dailyUsage() is the join the rollup's own doc comment
// asked a caller to make.
//
// The interesting case is not "old days plus new days". It is the ONE day the
// two sources share: the prune cuts at `now - N days`, a timestamp rather than
// a midnight, so the day the cutoff lands in is half folded and half live and
// is only whole once both halves are added — while a session that ran across
// that cutoff has a row on each side and must still count once.
//
// Fixtures write daily_rollup directly instead of pruning, so the split day is
// a day this test chooses rather than whatever hour it happens to run at.
// Whether the prune folds correctly is rollup-before-prune.test.ts's question.
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-seam-"));
const ROOT = join(dir, "proj");
const PKG = join(ROOT, "packages", "api"); // a monorepo subdir, not the root
const OTHER = join(dir, "other");
for (const d of [PKG, OTHER]) mkdirSync(d, { recursive: true });
process.env.AGENTGLASS_DB = join(dir, "seam.db");
process.env.AGENTGLASS_ROOT = ROOT;
process.env.XDG_CONFIG_HOME = dir;

let db: typeof import("../src/db.ts");
const DAY = 86_400_000;

/** A UTC day well outside retention, and noon inside it — far enough from
 *  either midnight that no timezone or rounding accident moves an event to a
 *  neighbouring day. */
const dayOf = (msAgo: number) => new Date(Date.now() - msAgo).toISOString().slice(0, 10);
const noonOn = (day: string) => Date.parse(`${day}T12:00:00Z`);

const SPLIT = dayOf(20 * DAY); // half in the rollup, half still in events
const OLD = dayOf(40 * DAY); // rollup only
const LIVE = dayOf(0); // events only

const event = (over: Record<string, unknown> = {}) => ({
  source_app: "proj",
  session_id: "seam-live",
  hook_event_type: "PostToolUse",
  tool_name: "Bash",
  tool_use_id: null,
  agent_id: null,
  agent_type: null,
  model_name: "claude-opus-4-8",
  is_error: 0,
  error_text: null,
  usage: { input_tokens: 100, output_tokens: 40, cache_creation_tokens: 0, cache_read_tokens: 10 },
  usage_is_cumulative: false,
  summary: "x",
  timestamp: Date.now(),
  payload: { project_path: PKG },
  chat: null,
  ...over,
});

/** A folded day, written the way foldExpiringEvents() would have written it. */
function fold(over: {
  day: string;
  session_id: string;
  project_path?: string;
  events?: number;
  input_tokens?: number;
  cost_usd?: number;
}) {
  db.db.run(
    `INSERT INTO daily_rollup (day, project_path, session_id, source_app, model_name, provider,
       events, tool_calls, tool_errors, errors, input_tokens, output_tokens,
       cache_creation_tokens, cache_read_tokens, cost_usd, duration_ms_total, timed_calls)
     VALUES (?, ?, ?, 'proj', 'claude-opus-4-8', 'anthropic', ?, ?, 0, 0, ?, 0, 0, 0, ?, 0, 0)`,
    [
      over.day,
      over.project_path ?? PKG,
      over.session_id,
      over.events ?? 1,
      over.events ?? 1,
      over.input_tokens ?? 0,
      over.cost_usd ?? 0,
    ],
  );
}

const byDay = <T extends { day: string }>(days: T[], d: string) => days.find((x) => x.day === d);

beforeAll(async () => {
  db = await import("../src/db.ts");

  // Rollup side.
  fold({ day: OLD, session_id: "seam-old", events: 7, input_tokens: 700, cost_usd: 3 });
  fold({ day: SPLIT, session_id: "seam-split", events: 3, input_tokens: 300, cost_usd: 1 });
  // The same day in a project this scope does not cover.
  fold({ day: OLD, session_id: "seam-elsewhere", project_path: OTHER, events: 99, cost_usd: 99 });

  // Events side. Two on the split day under the SAME session as its folded
  // half, plus one live today.
  db.insertEvent(event({ timestamp: noonOn(SPLIT), session_id: "seam-split" }) as any);
  db.insertEvent(event({ timestamp: noonOn(SPLIT) + 1000, session_id: "seam-split" }) as any);
  db.insertEvent(event({ timestamp: Date.now() - 60_000, session_id: "seam-live" }) as any);
});

describe("one continuous series across the retention boundary", () => {
  test("days from both sides are present, in order", () => {
    const days = db.dailyUsage();
    expect(days.map((d) => d.day)).toEqual([OLD, SPLIT, LIVE]);
    // The rollup alone stops at the boundary — that is what made it unusable
    // for a chart on its own.
    expect(db.rollupDays().map((d) => d.day)).toEqual([OLD, SPLIT]);
  });

  test("the split day is whole: both halves are added, not chosen between", () => {
    const d = byDay(db.dailyUsage(), SPLIT)!;
    expect(d.events).toBe(5); // 3 folded + 2 live
    expect(d.input_tokens).toBe(500); // 300 folded + 2 × 100 live
    expect(d.cost_usd).toBeGreaterThan(1); // the folded 1.00 plus the live rows'
  });

  test("and a session that ran across the boundary counts once", () => {
    // seam-split has a row on each side. Summing the two COUNT(DISTINCT)s would
    // report two sessions where one agent ran.
    expect(byDay(db.dailyUsage(), SPLIT)!.sessions).toBe(1);
  });

  test("two different sessions on the same day still count as two", () => {
    // The opposite error: deduping so hard that distinct work merges.
    fold({ day: SPLIT, session_id: "seam-other-agent", events: 1 });
    expect(byDay(db.dailyUsage(), SPLIT)!.sessions).toBe(2);
  });

  test("a day the rollup alone knows survives with its numbers", () => {
    const d = byDay(db.dailyUsage(), OLD)!;
    expect(d.events).toBe(7);
    expect(d.input_tokens).toBe(700);
    expect(d.cost_usd).toBe(3);
  });

  test("the from bound trims both sources, not just one", () => {
    const days = db.dailyUsage(SPLIT);
    expect(days.map((d) => d.day)).toEqual([SPLIT, LIVE]);
    // The events half is bounded on `timestamp`, which is a different
    // expression from the rollup's `day >= ?` — an off-by-one there would drop
    // or duplicate the boundary day itself.
    expect(byDay(days, SPLIT)!.events).toBe(6); // 4 folded (3 + the extra) + 2 live
  });

  test("the to bound excludes days after it and keeps the day itself whole", () => {
    const days = db.dailyUsage(undefined, SPLIT);
    expect(days.map((d) => d.day)).toEqual([OLD, SPLIT]);
    expect(byDay(days, SPLIT)!.events).toBe(6); // the live half of SPLIT is still in
  });
});

describe("the rollup is scoped by what the rollup knows", () => {
  test("another project's folded days stay out", () => {
    // seam-elsewhere folded 99 events on OLD under a path outside this scope.
    expect(byDay(db.dailyUsage(), OLD)!.events).toBe(7);
    expect(db.dailyUsage().every((d) => d.cost_usd < 99)).toBe(true);
  });

  test("a monorepo subdirectory is inside the project, as it is for events", () => {
    // Every fixture above writes project_path = <root>/packages/api, which is
    // where a monorepo's events actually come from. Scoping the rollup by
    // equality against the scope roots matched none of them and reported a
    // project with months of history as having none.
    expect(db.dailyUsage().length).toBeGreaterThan(0);
    expect(db.rollupDays().length).toBeGreaterThan(0);
  });
});

describe("saying where the seam is", () => {
  test("the boundary is reported as a day the chart can mark", () => {
    // A gap before this day means "not kept in that detail"; a gap after it
    // means the fleet was idle. A chart that cannot tell them apart is worse
    // than one that shows less.
    expect(db.retentionSeamDay()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(db.retentionSeamDay()! < dayOf(0)).toBe(true);
    expect(db.retentionSeamDay()! > OLD).toBe(true);
  });
});
