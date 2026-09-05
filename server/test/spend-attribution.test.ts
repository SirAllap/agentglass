/*
 * Joining spend to the work object — and pinning the cases where the join has
 * to guess.
 *
 * The argument for doing this locally is that the events, the checkouts and the
 * pull requests are in one SQLite file, so "what did this branch cost" is a
 * query rather than an inference over a remote feed. That argument only holds
 * if the query is honest about the two places where it stops knowing, and both
 * of those are quiet failures: a number that is a little bit wrong looks
 * exactly like a number that is right.
 *
 * So the ambiguous cases are the point of this file, not an afterthought to it:
 *
 *  - a turn whose directory has since moved to another branch,
 *  - a turn that recorded no branch at all and can only be placed by where it
 *    ran,
 *  - one session that worked on two branches,
 *  - a directory git no longer calls a worktree,
 *  - money old enough that retention has folded it past the point where any
 *    branch can claim it.
 *
 * Each of those has one right answer, and none of them is obvious enough to
 * survive a refactor on its own.
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/*
 * A TYPE-only import, and that word is doing real work.
 *
 * `import { attributeSpend } from "../src/spend.ts"` is hoisted: it runs before
 * the `process.env` lines below, so spend.ts — and through it db.ts — would
 * initialise against whatever environment happened to be there, pinning the
 * database path and the workspace root for every test file loaded afterwards.
 * That is how this file silently broke test/usage-across-the-seam.ts, which
 * sorts after it and lost its rollup-only day.
 *
 * `import type` is erased at compile time and imports nothing at runtime, so the
 * env below is set before the deferred `await import` in beforeAll. Same reason
 * db and spend are loaded that way rather than named up here.
 */
import type { SpendRow } from "../src/spend.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-spend-"));
const REPO = join(dir, "orbit");
const OTHER = join(dir, "other");
/*
 * The worktrees live INSIDE the repo root on purpose. In real use they are
 * siblings — ~/code/orbit-ORBIT-1042 beside ~/code/orbit — and scopeClause
 * finds them because scopeRoots() asks git for the family. There is no git repo
 * under a temp directory, so here the family is the root alone and a sibling
 * would be legitimately out of scope. Nesting them keeps this test about
 * attribution instead of about what git knows.
 */
const WT_RAIL = join(REPO, "wt", "rail");
const WT_ROUNDING = join(REPO, "wt", "rounding");
for (const p of [REPO, OTHER, WT_RAIL, WT_ROUNDING]) mkdirSync(p, { recursive: true });

// Two days of retention, so the fold and the seam are reachable from a test
// without waiting a week. Read once at db.ts import, so it is set before it.
/*
 * Deliberately NOT setting AGENTGLASS_RETENTION_DAYS.
 *
 * db.ts reads it into a module-level const at import (db.ts:1129), and the
 * whole server suite runs in one process — so a file that sets it does not
 * configure itself, it configures every file loaded after it. This one used to
 * pin it to 2, and because "spend-" sorts before "usage-", it silently shortened
 * the window out from under test/usage-across-the-seam.ts, whose oldest day then
 * fell outside retention and vanished. Nine tests went red in a file nobody had
 * touched.
 *
 * The override bought nothing anyway: the case below needs one event older than
 * retention, and it uses one older than the default. Where a date has to sit on
 * the far side of the boundary, derive it from the constant — the idiom
 * test/session-lifecycle.ts already uses.
 */
process.env.AGENTGLASS_DB = join(dir, "spend.db");
process.env.AGENTGLASS_ROOT = REPO;
process.env.XDG_CONFIG_HOME = dir;

let db: typeof import("../src/db.ts");
let spend: typeof import("../src/spend.ts");

const now = Date.now();

/** One costed turn. Opus input is $5/M, so `mtok` million input tokens is
 *  $5 × mtok — the same lever insights-scope.test.ts pulls to make a spend
 *  assertion a round number instead of a fixture of pricing tables. */
const turn = (o: {
  project: string; session: string; mtok: number;
  cwd?: string; branch?: string; agoMs?: number;
}) => ({
  source_app: "orbit",
  session_id: o.session,
  hook_event_type: "PostToolUse",
  tool_name: "Bash",
  tool_use_id: null,
  agent_id: null,
  agent_type: null,
  model_name: "claude-opus-4-8",
  is_error: 0,
  error_text: null,
  usage: { input_tokens: o.mtok * 1_000_000, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0 },
  usage_is_cumulative: false,
  summary: "",
  timestamp: now - (o.agoMs ?? 0),
  payload: {
    project_path: o.project,
    ...(o.cwd ? { cwd: o.cwd } : {}),
    ...(o.branch ? { git_branch: o.branch } : {}),
  },
  chat: null,
});

beforeAll(async () => {
  db = await import("../src/db.ts");
  spend = await import("../src/spend.ts");

  // Named its own branch, in the worktree that still has it out.
  db.insertEvent(turn({ project: REPO, session: "s-rail", mtok: 2, cwd: WT_RAIL, branch: "feat/rail" }) as any);
  // Named a branch that its worktree has since moved off.
  db.insertEvent(turn({ project: REPO, session: "s-old", mtok: 1, cwd: WT_RAIL, branch: "feat/rail-spike" }) as any);
  // Recorded no branch at all: only the directory can place it.
  db.insertEvent(turn({ project: REPO, session: "s-mute", mtok: 3, cwd: WT_ROUNDING }) as any);
  // Another project entirely — must not leak into this repository's answer.
  db.insertEvent(turn({ project: OTHER, session: "s-away", mtok: 8, branch: "feat/rail" }) as any);
});

describe("the attribution rule", () => {
  const rows = (over: Partial<SpendRow>[]): SpendRow[] =>
    over.map((o, i) => ({ branch: "", dir: WT_RAIL, session_id: `s${i}`, usd: 1, last_ts: now, ...o }));

  test("a turn's own branch beats the branch its directory is on now", () => {
    // The case that makes the whole thing defensible rather than approximate:
    // the worktree is on feat/rail today, the turn said it was on the spike
    // branch when it ran, and the turn is the one that was there.
    const { branches } = spend.attributeSpend(
      rows([{ branch: "feat/rail-spike", usd: 4 }]),
      new Map([[WT_RAIL, "feat/rail"]]),
    );
    expect(branches.map((b) => b.branch)).toEqual(["feat/rail-spike"]);
    expect(branches[0].namedUsd).toBe(4);
    expect(branches[0].inferredUsd).toBe(0);
  });

  test("a turn that named no branch is placed by its directory, and stays marked as a guess", () => {
    // The genuinely ambiguous one. It is counted — leaving it out would make
    // every branch worked on by an agent that does not record branches read as
    // free — but it never joins namedUsd, so the panel can still say which part
    // of the figure it is sure of.
    const { branches } = spend.attributeSpend(
      rows([{ branch: "", usd: 6 }]),
      new Map([[WT_RAIL, "feat/rail"]]),
    );
    expect(branches[0]).toMatchObject({ branch: "feat/rail", usd: 6, namedUsd: 0, inferredUsd: 6 });
    expect(branches[0].dirs).toEqual([WT_RAIL]);
  });

  test("named and guessed money on the same branch stay apart inside one total", () => {
    const { branches } = spend.attributeSpend(
      rows([{ branch: "feat/rail", usd: 4 }, { branch: "", usd: 1 }]),
      new Map([[WT_RAIL, "feat/rail"]]),
    );
    expect(branches).toHaveLength(1);
    expect(branches[0]).toMatchObject({ usd: 5, namedUsd: 4, inferredUsd: 1 });
  });

  test("one session across two branches is split by turn, not by session", () => {
    // A session is not the unit of work: an agent asked to land two things does
    // both in one session, and charging the whole session to whichever branch
    // it happened to touch first would be wrong by the size of the other one.
    // The session then legitimately counts under both — `sessions` reads as
    // "sessions that worked on this branch", never as a partition of them.
    const { branches } = spend.attributeSpend(
      [
        { branch: "feat/rail", dir: WT_RAIL, session_id: "s-both", usd: 7, last_ts: now },
        { branch: "fix/rounding", dir: WT_RAIL, session_id: "s-both", usd: 3, last_ts: now },
      ],
      new Map([[WT_RAIL, "feat/rail"]]),
    );
    expect(branches.map((b) => [b.branch, b.usd])).toEqual([["feat/rail", 7], ["fix/rounding", 3]]);
    expect(branches.every((b) => b.sessions === 1)).toBe(true);
  });

  test("a turn deeper than the checkout is placed by the LONGEST checkout that contains it", () => {
    // The agent recorded a package inside a worktree, not the worktree itself.
    // Both the repo root and the worktree contain that path — worktrees here
    // are nested under the root — so "the first ancestor that matches" would
    // file the worktree's afternoon under whatever trunk the root has out. The
    // longest match is the one git itself would give.
    const { branches } = spend.attributeSpend(
      rows([{ branch: "", dir: join(WT_RAIL, "packages", "api"), usd: 5 }]),
      new Map([[REPO, "main"], [WT_RAIL, "feat/rail"]]),
    );
    expect(branches.map((b) => b.branch)).toEqual(["feat/rail"]);
    expect(branches[0].inferredUsd).toBe(5);
  });

  test("a directory git no longer knows reaches no branch, but is still reported", () => {
    // The worktree was removed after the merge — the normal end of a branch in
    // this repo. Nothing may invent a branch for it, and nothing may make the
    // money disappear either: it shows up under worktrees with a null branch,
    // which is what keeps the branch totals from silently failing to add up.
    const { branches, worktrees } = spend.attributeSpend(
      rows([{ branch: "", dir: WT_ROUNDING, usd: 9 }]),
      new Map(),
    );
    expect(branches).toEqual([]);
    expect(worktrees).toEqual([{ dir: WT_ROUNDING, branch: null, usd: 9, sessions: 1, lastTs: now }]);
  });

  test("a branch named by a turn survives its worktree being deleted", () => {
    // Same deletion, opposite input: the turn recorded the branch, so the
    // answer does not depend on the checkout still existing. This is why named
    // spend is worth preferring rather than merely nice to have.
    const { branches } = spend.attributeSpend(rows([{ branch: "feat/rail", usd: 2 }]), new Map());
    expect(branches[0]).toMatchObject({ branch: "feat/rail", usd: 2, namedUsd: 2 });
  });
});

describe("over a seeded database", () => {
  /** The query groups down to the session as well, so a branch two sessions
   *  worked on arrives as two rows. Summing here rather than picking the first
   *  is the same mistake this guards the server against. */
  const usdFor = (rows: SpendRow[], pick: (r: SpendRow) => boolean): number =>
    rows.filter(pick).reduce((n, r) => n + r.usd, 0);

  test("the query groups the repository by branch and directory", () => {
    const rows = spend.spendRows(REPO, 0);
    expect(usdFor(rows, (r) => r.branch === "feat/rail" && r.dir === WT_RAIL)).toBeCloseTo(10, 6); // 2M input tokens
    expect(usdFor(rows, (r) => r.branch === "feat/rail-spike")).toBeCloseTo(5, 6);
    expect(usdFor(rows, (r) => r.branch === "" && r.dir === WT_ROUNDING)).toBeCloseTo(15, 6); // recorded no branch
  });

  test("another project's spend on a branch of the same name does not leak in", () => {
    // The failure that would make this feature actively misleading rather than
    // merely incomplete: two repositories both have a `feat/rail`.
    const rows = spend.spendRows(REPO, 0);
    expect(rows.some((r) => r.dir === OTHER)).toBe(false);
    expect(usdFor(rows, (r) => r.branch === "feat/rail")).toBeCloseTo(10, 6);
  });

  test("money the fold has swallowed is reported apart, not silently dropped", async () => {
    // Retention folds expiring events into daily_rollup, which carries neither
    // the cwd nor the branch — so this is real spend that no branch can claim
    // any more. The panel has to be able to say so; a total that quietly
    // shrinks the week after the work happened is worse than one that admits
    // where it stops.
    db.insertEvent(turn({
      project: REPO, session: "s-ancient", mtok: 4,
      cwd: WT_RAIL, branch: "feat/rail", agoMs: (db.RETENTION_DAYS + 2) * 86_400_000,
    }) as any);
    expect(usdFor(spend.spendRows(REPO, 0), (r) => r.branch === "feat/rail")).toBeCloseTo(30, 6);

    db.pruneOldRows();
    spend.forgetSpend();
    const after = await spend.repoSpend(REPO);
    expect(after.ok).toBe(true);
    // The old turn is gone from the branch...
    const rail = after.branches.find((b) => b.branch === "feat/rail");
    expect(rail!.usd).toBeCloseTo(10, 6);
    // ...and its $20 is accounted for as unattributable rather than vanishing.
    expect(after.beforeSeamUsd).toBeCloseTo(20, 6);
    expect(after.seamDay).toBeTruthy();
  });
});
