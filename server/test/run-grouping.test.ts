// A run reads history that was written before the run existed.
//
// Nothing is tagged at write time and no column was added for this. What ties a
// leg to its stored work is the DIRECTORY it ran in, and db.ts already records
// that: `cwd_path` is a VIRTUAL generated column over the event payload, so it
// applies to rows written long before any of this code did, and the same
// migration backfills the real column on `sessions` from them.
//
// The consequence is the one the feature is sold on. Somebody has had a codex
// pane going in a hand-cut worktree for three hours. Adopting it is not a
// subscription that starts collecting from now — the three hours are already in
// the database, under the only key that was ever going to be common to an agent
// we started and one we did not. So this file writes the events FIRST, with no
// run anywhere, and only then makes the run that has to find them.
//
// The other direction is asserted too, because a grouping that over-collects is
// worse than one that under-collects: a directory that is not a leg of this run
// must not appear in its totals, however busy it is.
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-run-group-")));
const REPO = join(dir, "repo");
/** Two checkouts cut by hand, long before the run. */
const OLD_A = join(dir, "repo-old-a");
const OLD_B = join(dir, "repo-old-b");
/** A third, just as busy, that this run has nothing to do with. */
const STRANGER = join(dir, "repo-stranger");

process.env.XDG_CONFIG_HOME = dir;
process.env.AGENTGLASS_DB = join(dir, "group.db");
process.env.AGENTGLASS_ROOT = dir;

function git(cwd: string, ...args: string[]) {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

let db: typeof import("../src/db.ts");
let runs: typeof import("../src/runs.ts");
let gitwork: typeof import("../src/gitwork.ts");
let run: import("../src/runs.ts").Run;

const T0 = Date.now() - 3 * 3600 * 1000;

/** One turn's worth of event, filed under the directory it ran in. `cwd` is the
 *  field db.ts lifts `cwd_path` out of — nothing else here is load-bearing. */
const turn = (session: string, cwd: string, i: number, isError = 0) => ({
  source_app: "repo",
  session_id: session,
  hook_event_type: "PreToolUse",
  tool_name: "Bash",
  tool_use_id: `${session}-${i}`,
  agent_id: null,
  agent_type: null,
  model_name: "claude-opus-4-8",
  is_error: isError,
  error_text: null,
  usage: { input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0 },
  usage_is_cumulative: false,
  summary: "",
  timestamp: T0 + i * 1000,
  payload: { project_path: REPO, cwd, tool_input: { command: "bun test" } },
  chat: null,
});

beforeAll(async () => {
  process.env.AGENTGLASS_ROOT = dir;
  mkdirSync(REPO, { recursive: true });
  git(REPO, "init", "-q", "-b", "main");
  git(REPO, "config", "user.email", "t@example.com");
  git(REPO, "config", "user.name", "t");
  writeFileSync(join(REPO, "README"), "x\n");
  git(REPO, "add", "-A");
  git(REPO, "commit", "-q", "-m", "root");
  for (const [path, branch] of [[OLD_A, "old-a"], [OLD_B, "old-b"], [STRANGER, "stranger"]]) {
    git(REPO, "worktree", "add", "-q", "-b", branch!, path!);
  }

  // Everything that follows happens with no run in existence. This is the
  // history the run has to discover afterwards, not produce.
  db = await import("../src/db.ts");
  for (let i = 0; i < 6; i++) db.insertEvent(turn("sess-a", OLD_A, i) as any);
  for (let i = 0; i < 4; i++) db.insertEvent(turn("sess-b1", OLD_B, i) as any);
  for (let i = 0; i < 3; i++) db.insertEvent(turn("sess-b2", OLD_B, i, i === 2 ? 1 : 0) as any);
  for (let i = 0; i < 40; i++) db.insertEvent(turn("sess-x", STRANGER, i) as any);

  gitwork = await import("../src/gitwork.ts");
  runs = await import("../src/runs.ts");
  runs.__clearRuns();

  const started = await runs.startRun(REPO, "which of these is right?", [{ agent: "claude-code" }], {
    cut: (root, path, branch, from) => gitwork.addWorktree(root, path, branch, true, from),
    open: async () => ({ paneId: "%1", windowId: "@1" }),
    bin: () => "/bin/echo",
    exists: existsSync,
  });
  // Two panes, two ids: the same person's two terminals, which is what a run
  // with two adopted legs actually looks like.
  const deps = (paneId: string, path: string, seen: string) => ({
    panes: () => [{ paneId, path: REPO, agentCwds: [path] }],
    agentIn: () => seen,
  });
  const a = await runs.adoptPane(started.run!.id, "%7", "", deps("%7", OLD_A, "codex"));
  const b = await runs.adoptPane(started.run!.id, "%8", "", deps("%8", OLD_B, "gemini"));
  if (!a.ok || !b.ok) throw new Error(`fixture: ${a.error ?? ""} ${b.error ?? ""}`);
  run = runs.runById(started.run!.id)!;
});

describe("grouping by the set of directories the legs ran in", () => {
  test("finds work recorded before the run was ever created", () => {
    const legs = runs.runActivity(run);
    const a = legs.find((l) => l.worktree === OLD_A)!;
    const b = legs.find((l) => l.worktree === OLD_B)!;
    expect(a.sessions).toBe(1);
    expect(a.events).toBe(6);
    // Two sessions in one checkout roll up to the leg, because the leg is a
    // place and not a session.
    expect(b.sessions).toBe(2);
    expect(b.events).toBe(7);
    expect(b.errors).toBe(1);
  });

  test("carries the leg's own facts alongside the numbers", () => {
    const legs = runs.runActivity(run);
    const a = legs.find((l) => l.worktree === OLD_A)!;
    expect(a.origin).toBe("adopted");
    expect(a.agent).toBe("codex");
    expect(a.branch).toBe("old-a");
    expect(a.lastSeen).toBeGreaterThan(0);
  });

  test("a busy directory that is not a leg stays out of the totals", () => {
    const legs = runs.runActivity(run);
    expect(legs.some((l) => l.worktree === STRANGER)).toBe(false);
    // 40 events sat next door the whole time; none of them are in this run.
    expect(legs.reduce((n, l) => n + l.events, 0)).toBe(13);
  });

  test("a leg with no history reports zero rather than vanishing", () => {
    const legs = runs.runActivity(run);
    // The spawned leg was cut a moment ago and has produced nothing. A run that
    // silently dropped it would be a comparison missing an arm.
    const fresh = legs.find((l) => l.origin === "spawned")!;
    expect(fresh.sessions).toBe(0);
    expect(fresh.events).toBe(0);
    expect(fresh.lastSeen).toBe(0);
    expect(legs).toHaveLength(3);
  });

  test("the numbers keep arriving after adoption, from the same key", () => {
    // Nothing was subscribed and nothing was tagged: the next event lands under
    // the same directory and the next read picks it up.
    db.insertEvent(turn("sess-a", OLD_A, 99) as any);
    const a = runs.runActivity(run).find((l) => l.worktree === OLD_A)!;
    expect(a.events).toBe(7);
  });
});

describe("the column this leans on", () => {
  test("is generated from the payload, not written by anything here", () => {
    // Stated as a test because the whole retroactive property rests on it: no
    // code in runs.ts writes `cwd_path`, and no migration had to walk the table
    // to fill it in.
    const row = db.db
      .query<{ cwd_path: string | null }, [string]>("SELECT cwd_path FROM events WHERE session_id = ? LIMIT 1")
      .get("sess-a");
    expect(row?.cwd_path).toBe(OLD_A);
    const sql = db.db
      .query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name = 'events'")
      .get()!.sql;
    expect(sql).toContain("GENERATED ALWAYS AS");
  });
});
