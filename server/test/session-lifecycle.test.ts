// When a session is over, and when it only looks over (#248, F11 and F17).
//
// Two defects, one subject: the moment a session is called finished.
//
// F11 — a `SubagentStop` fires in the *parent* session every time a Task
// subagent finishes, several times in a long run. It was treated as terminal,
// so the parent got an `ended_at` while it went right on working: the deep dive
// showed a duration that stopped mid-run, and the fleet drew a live session as
// ended. Nothing ever cleared it, because the upsert only ever COALESCEd the
// old value forward.
//
// F17 — the detail read `started_at` from the events (MIN(timestamp)) and
// `ended_at` from the session row. Retention prunes events, so the start
// walked forward while the end stayed put, and one session reported two
// different durations depending on which panel you asked.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-lifecycle-"));
const PROJ = join(dir, "proj");
mkdirSync(PROJ, { recursive: true });
process.env.AGENTGLASS_DB = join(dir, "lifecycle.db");
process.env.AGENTGLASS_ROOT = PROJ;
process.env.XDG_CONFIG_HOME = dir;

// Imported here rather than in a hook because the retention window has to be
// readable while the tests are being declared. db.ts reads it once, at import,
// and a whole-suite run may have imported the module before this file was
// reached — so the window is asked for rather than assumed.
const db = await import("../src/db.ts");
const ing = await import("../src/ingest.ts");

const DAY = 86_400_000;
/** Old enough that retention will take it, whatever the window is set to. */
const PRUNABLE_DAYS = db.RETENTION_DAYS + 2;

/** One event, from a session, at a moment. */
const ev = (session: string, type: string, timestamp: number) => ({
  source_app: "app",
  session_id: session,
  hook_event_type: type,
  model_name: "claude-opus-5",
  payload: { project_path: PROJ },
  timestamp,
});

/** Insert, and hand back the session row the write itself returned. Not
 *  `getSessions`, which memoizes for a second and would answer with the state
 *  before the event under test. */
const put = (session: string, type: string, timestamp: number) =>
  db.insertEvent(ing.normalize(ev(session, type, timestamp) as any)).session;

describe("a subagent finishing does not end the session it ran in", () => {
  test("SubagentStop leaves the session open, and later work keeps it open", () => {
    const now = Date.now();
    put("sub", "UserPromptSubmit", now - 5000);
    expect(put("sub", "SubagentStop", now - 4000).ended_at).toBeNull();

    const s = put("sub", "PostToolUse", now - 1000);
    expect(s.ended_at).toBeNull();
    // What the fleet actually asks: no end, and seen recently.
    expect(s.last_seen).toBeGreaterThan(s.started_at);
  });

  test("Stop and SessionEnd do end it", () => {
    const now = Date.now();
    put("stopped", "UserPromptSubmit", now - 3000);
    expect(put("stopped", "Stop", now - 2000).ended_at).toBe(now - 2000);

    put("closed", "UserPromptSubmit", now - 3000);
    expect(put("closed", "SessionEnd", now - 1500).ended_at).toBe(now - 1500);
  });
});

describe("a session that speaks again is not over", () => {
  test("an event after the end clears it", () => {
    const now = Date.now();
    put("resumed", "UserPromptSubmit", now - 9000);
    expect(put("resumed", "Stop", now - 8000).ended_at).toBe(now - 8000);

    // `claude --resume`, or simply a turn that arrives after the Stop.
    expect(put("resumed", "UserPromptSubmit", now - 7000).ended_at).toBeNull();
  });

  test("an event that predates the end does not", () => {
    const now = Date.now();
    put("late", "UserPromptSubmit", now - 9000);
    expect(put("late", "Stop", now - 5000).ended_at).toBe(now - 5000);
    // Arrives now, but happened before the Stop: a delayed hook, not new work.
    expect(put("late", "PostToolUse", now - 6000).ended_at).toBe(now - 5000);
  });
});

describe("the deep dive agrees with the list", () => {
  // Retention off (AGENTGLASS_RETENTION_DAYS=0) means nothing is ever deleted,
  // and the disagreement this covers cannot arise.
  test.skipIf(db.RETENTION_DAYS === 0)("start and end survive retention pruning together", () => {
    const now = Date.now();
    const first = now - PRUNABLE_DAYS * DAY;
    put("pruned", "SessionStart", first);
    const row = put("pruned", "PostToolUse", now - 1000);

    const before = db.getSession("pruned")!;
    expect(before.started_at).toBe(first);

    // Retention deletes the old event. The session row is untouched: its
    // last_seen is now.
    const gone = db.pruneOldRows();
    expect(gone.events).toBeGreaterThan(0);

    const after = db.getSession("pruned")!;
    // The start is the session's, not the oldest surviving event's, so the
    // duration does not shrink because history aged out.
    expect(after.started_at).toBe(first);
    // And it is the same number the list shows: the session row's own.
    expect(after.started_at).toBe(row.started_at);
    expect(after.last_seen).toBe(row.last_seen);
  });
});
