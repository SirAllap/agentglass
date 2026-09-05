/*
 * The work loop — the thing "a clone of me" actually meant.
 *
 * WHAT CAME BEFORE THIS AND WHY IT WAS THE WRONG HALF. The understudy could
 * predict the SHAPE of thirteen decisions and carry out five reversible git
 * actions. That is an instrument for measuring whether it decides like him. It
 * is not a thing you can leave working on your issues for a day, and no amount
 * of accuracy turns the first into the second — they are different objects.
 *
 * What he asked for: take a card or a pull request, do the work, and when that
 * one is finished go and find the next where he would have looked.
 *
 * THE DESIGN MISTAKE THAT WAS BLOCKING IT. Everything before this was built on
 * "every action must be reversible with a recipe written down", which forces a
 * table of five git verbs and nothing else. A real agent with Bash cannot
 * satisfy that on any action, so the rule made the useful version impossible.
 *
 * Isolation replaces reversibility. All the work happens inside a DISPOSABLE
 * WORKTREE, so it does not matter whether the individual steps can be undone —
 * the whole thing is thrown away by removing a directory. That buys the agent
 * every tool the person has: Bash, their MCPs, their skills, installing what it
 * needs. It is also exactly how he works by hand: a worktree per task, test,
 * PR, delete the local trace.
 *
 * WHAT STILL BOUNDS IT. The shift — how long, how much, and stop on failure.
 * The halt, which now reaches the actuator. And the repository allow-list,
 * which starts at the open project because an error there costs a worktree and
 * an error in his employer's repository costs something else entirely.
 */
import { createHash } from "node:crypto";
import type { UnderstudyWorkItem, UnderstudyWorkRun } from "../../shared/types.ts";
import { db } from "./db.ts";
import { ask } from "./understudy-ask.ts";
import { raiseHand } from "./understudy-help.ts";
import { OPEN_PARTITION, retrieve } from "./understudy.ts";

/**
 * How many goes one item gets before it stops being re-offered and starts
 * being a question.
 *
 * Two. The first re-offer covers the honest accident — an install restarted
 * the server, the machine rebooted, the pane died on its way up. An item
 * whose run has now been abandoned twice is not failing by accident, and
 * offering it a third time spends a shift re-running the same thing instead
 * of telling somebody.
 *
 * Shared with the hand-filled queue's own retry count (`understudy-sources-
 * work.ts` re-exports this rather than declaring its own) — one number for
 * "how many unattended goes before a person is asked", not two that could
 * drift apart.
 */
export const MAX_ATTEMPTS = 2;

/* ── where work comes from ──────────────────────────────────────────────────
 *
 * DELIBERATELY A LIST OF SOURCES rather than one hard-coded path, because his
 * answer to "where does work come from" was, correctly, "it depends": at work
 * it is ClickUp and Slack threads, on personal projects it is issues or things
 * he decides himself. A loop that only knew about one of those would be useful
 * on one day of the week.
 *
 * A source only has to say what work EXISTS. Choosing between them is a
 * separate step, because that choice is a judgement about priorities and the
 * bank has something to say about it.
 */
export type WorkItem = UnderstudyWorkItem;

export interface WorkSource {
  id: string;
  label: string;
  /** What this source can offer right now. Read-only, always. */
  find(opts: { repos: string[] }): Promise<WorkItem[]>;
  /**
   * Optional: this item has been picked up, stop offering it.
   *
   * Only a source that keeps its own list needs this. A pull request stops
   * being offered because the review was addressed and a card because its state
   * moved — both facts the source re-reads anyway. The queue he fills by hand
   * has no such outside fact, so somebody has to tell it.
   *
   * Called when the run BEGINS, never on success. Marking it on success leaves
   * a failed item pending, and the next round picks it up again into the
   * worktree the failed run deliberately left on disk — which the loop refuses,
   * forever. One attempt per queued item; what happened to it is the run record.
   */
  taken?(itemId: string): void;
}

const SOURCES = new Map<string, WorkSource>();

/**
 * Register a source.
 *
 * Exported so the loop is extensible without editing it: a source is a thing
 * that can list work, and adding one should not mean touching the code that
 * decides what to do next.
 */
export function addSource(s: WorkSource): void {
  SOURCES.set(s.id, s);
}

export function sources(): { id: string; label: string }[] {
  return [...SOURCES.values()].map((s) => ({ id: s.id, label: s.label }));
}

/* ── what has been picked up already ────────────────────────────────────── */

/* The table lives in db.ts with every other one — see the note there for why
   a schema that depends on import order is not a schema. */

export type WorkRun = UnderstudyWorkRun;

const rowToRun = (r: {
  id: number; shift_id: number | null; source: string; item_id: string; title: string;
  repo: string; worktree: string; branch: string; started_at: number; finished_at: number | null;
  state: string; outcome: string; tip_sha?: string; pane_id?: string;
}): WorkRun => ({
  id: r.id,
  shiftId: r.shift_id,
  source: r.source,
  itemId: r.item_id,
  title: r.title,
  repo: r.repo,
  worktree: r.worktree,
  branch: r.branch,
  tipSha: r.tip_sha ?? "",
  paneId: r.pane_id ?? "",
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  state: r.state as WorkRun["state"],
  outcome: r.outcome,
});

const listRuns = db.query<Parameters<typeof rowToRun>[0], [number]>(
  "SELECT * FROM understudy_work ORDER BY id DESC LIMIT ?",
);
/*
 * WHICH RUNS COUNT AS "THIS ITEM IS SPOKEN FOR".
 *
 * `failed` was in that set, and it should never have been: a run that failed
 * delivered nothing, and its item was hidden from the queue for ever. Measured
 * today — two tasks sat in `understudy_asked` with `taken_at` cleared, which is
 * the queue's own word for "pending again", while this count answered "taken"
 * and the screen showed an empty queue. Nothing was working on them and
 * nothing ever would.
 *
 * Putting an item back is always deliberate (`requeue` clears `taken_at`), so
 * this may safely ignore the states that mean "did not deliver": a failed run
 * that left commits raises a hand instead of queueing anything, and its item
 * stays off the list because nobody put it back.
 */
const seenQ = db.query<{ n: number }, [string, string]>(
  "SELECT COUNT(*) AS n FROM understudy_work WHERE source = ? AND item_id = ? AND state NOT IN ('abandoned', 'empty', 'failed')",
);
/* Every abandonment on record for one item, newest first — not just a count,
   because raising a hand at the ceiling needs a title and a repo to address
   it with, and the run row is the only place those still live once the
   source itself has moved on. */
const abandonmentsQ = db.query<{ title: string; repo: string; outcome: string }, [string, string]>(
  `SELECT title, repo, outcome FROM understudy_work
     WHERE source = ? AND item_id = ? AND state IN ('abandoned', 'empty')
     ORDER BY id DESC`,
);

export function runs(limit = 30): WorkRun[] {
  try { return listRuns.all(Math.max(1, Math.min(200, limit))).map(rowToRun); } catch { return []; }
}

const listRunningRuns = db.query<Parameters<typeof rowToRun>[0], []>(
  "SELECT * FROM understudy_work WHERE state = 'running' ORDER BY started_at DESC",
);

/** Runs still `running`, direct rather than filtered out of `runs`' recency
 *  window — a table with any real history can have its most recent rows be
 *  finished ones, which would hide a run still going underneath them. */
export function runningRuns(): WorkRun[] {
  try { return listRunningRuns.all().map(rowToRun); } catch { return []; }
}

const listFailedRuns = db.query<Parameters<typeof rowToRun>[0], []>(
  "SELECT * FROM understudy_work WHERE state IN ('failed', 'empty') ORDER BY started_at DESC",
);

/** Runs still `failed` or `empty`, same reason `runningRuns` bypasses the
 *  recency window: a table with real history can push one past the last 50
 *  rows while it still sits unread on disk. Both leave their worktree on
 *  purpose, as the evidence — an `empty` one is the same unread directory as
 *  a `failed` one, just for a different reason, so it counts toward the same
 *  "nobody has looked at these" stop rule below. */
export function failedRuns(): WorkRun[] {
  try { return listFailedRuns.all().map(rowToRun); } catch { return []; }
}

/**
 * Has this item been picked up before, in any shift?
 *
 * `abandoned` and `empty` are excused from the count: neither is a verdict on
 * the item, both are a run that never got the chance to reach one — a restart
 * killed it mid-way, or its branch was gone before anyone could look. Without
 * this, the run row that PROVES a pull request was interrupted is the same
 * row that hides it from every shift after, for ever.
 *
 * That excuse is not unlimited. Past `MAX_ATTEMPTS` abandonments it stops
 * being an honest accident and starts being a person's turn to look, same
 * rule the hand-filled queue already applies to itself.
 */
export function alreadyTaken(source: string, itemId: string): boolean {
  try {
    if ((seenQ.get(source, itemId)?.n ?? 0) > 0) return true;
    const abandonments = abandonmentsQ.all(source, itemId);
    if (!abandonments.length) return false;
    if (abandonments.length < MAX_ATTEMPTS) return false;
    raiseHand({
      title: abandonments[0]!.title,
      question:
        `This item's run has been abandoned ${abandonments.length} times without finishing. ` +
        "It needs a person to look before it is offered again.",
      tried: abandonments.map((a) => a.outcome).join("\n\n"),
      repo: abandonments[0]!.repo,
    });
    return true;
  } catch { return false; }
}

const tallyQ = db.query<{ done: number | null; failed: number | null }, []>(
  `SELECT SUM(CASE WHEN state = 'done' THEN 1 ELSE 0 END) AS done,
          SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failed
     FROM understudy_work`,
);

/**
 * How much has been finished, and how much of it broke.
 *
 * `workUntilDone` knows only the call it is inside. A shift spread over several
 * calls — or picked up again after a restart — has nothing else to ask, because
 * the table is the only part of a shift that outlives the process.
 *
 * Counts the two ENDED states and no others: a run still going has proved
 * nothing either way yet, and an abandoned one was never worked.
 */
export function runsSoFar(): { done: number; failed: number } {
  try {
    const t = tallyQ.get();
    return { done: t?.done ?? 0, failed: t?.failed ?? 0 };
  } catch {
    return { done: 0, failed: 0 };
  }
}

/* ── choosing ───────────────────────────────────────────────────────────── */

/**
 * The next thing to work on, or null.
 *
 * Sources say what exists; this says which. The ordering is the source's own
 * weight nudged by how much the bank has to say about it — a card whose words
 * match things he has decided before is a card he has a way of handling, and
 * one he has never touched is a worse first pick for something working alone.
 *
 * Deliberately NOT the predictor. Its thirteen classes answer "what shape would
 * his answer take", which has nothing to say about which of four cards to open.
 */
/*
 * SLEEP UNTIL THE SESSION COMES BACK, AND RESUME.
 *
 * When the agent's session limit is hit the run died and the loop stopped —
 * and the watchdog, seeing an idle shift, restarted it, three times, each
 * time paying for a run whose whole output was "you have hit your limit".
 * The CLI says WHEN the limit resets, and `ranOutOfSession` already reads
 * it; nobody used the hour. Now it is a hold: the loop refuses to take work
 * until then, the watchdog neither resumes nor counts a try while it holds,
 * and the moment it lapses the loop is resumed at once. Persisted, because a
 * nap is exactly the kind of state a restart in the middle of it would lose.
 */
const holdRead = db.query<{ until: number; why: string; at: number }, []>(`SELECT until, why, at FROM understudy_hold WHERE id = 1`);
const holdWrite = db.query<never, [number, string, number]>(`INSERT INTO understudy_hold (id, until, why, at) VALUES (1, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET until = excluded.until, why = excluded.why, at = excluded.at`);

export function holdUntil(until: number, why: string, now = Date.now()): void {
  holdWrite.run(Math.max(0, Math.floor(until)), why.slice(0, 300), now);
}
export function clearHold(now = Date.now()): void { holdWrite.run(0, "", now); }
/** The hold in force, or null: a lapsed hold is no hold. */
export function heldUntil(now = Date.now()): { until: number; why: string; at: number } | null {
  const r = holdRead.get();
  return r && r.until > now ? r : null;
}
/** A hold that was in force and has lapsed since it was written — the one
 *  moment the watchdog resumes without waiting for the shift to look idle. */
export function holdLapsed(now = Date.now()): boolean {
  const r = holdRead.get();
  return !!r && r.until > 0 && r.until <= now;
}

/**
 * The CLI's "resets at 3pm (Europe/Madrid)" as a clock time, today or — if
 * that hour is already behind us — tomorrow. The zone in brackets is the
 * machine's own and is ignored. Text with no readable hour is an hour's nap:
 * every limit this CLI announces resets within a few hours, and an hour is
 * the longest wait that is still cheaper than a run that says "limit" again.
 */
export function resetTimeFrom(text: string, now = Date.now()): number {
  const m = /([0-9]{1,2})(?::([0-9]{2}))?\s*(am|pm)?/i.exec(text || "");
  if (!m) return now + 60 * 60_000;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ap = (m[3] ?? "").toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (!ap && m[1]!.length <= 2 && h <= 12 && !m[2]) {
    /* A bare "3" with no am/pm and no minutes is ambiguous; the CLI writes
       "3pm", so this branch is the odd case — read as the next such hour. */
  }
  if (h > 23 || min > 59) return now + 60 * 60_000;
  const d = new Date(now);
  d.setHours(h, min, 0, 0);
  let t = d.getTime();
  if (t <= now) t += 24 * 60 * 60_000;
  /* Never nap past six hours on a misread: the limit windows are shorter. */
  return Math.min(t, now + 6 * 60 * 60_000) + 60_000;
}

export async function nextTask(opts: { repos: string[] }): Promise<WorkItem | null> {
  const found: WorkItem[] = [];
  for (const s of SOURCES.values()) {
    try {
      for (const item of await s.find(opts)) {
        if (!alreadyTaken(item.source, item.id)) found.push(item);
      }
    } catch {
      // A source that cannot answer right now offers nothing. One broken
      // integration must not stop the loop finding work elsewhere.
    }
  }
  if (!found.length) return null;

  const scored = found.map((item) => {
    const seen = retrieve({
      cls: "general",
      partition: OPEN_PARTITION,
      text: `${item.title} ${item.detail}`.slice(0, 400),
      limit: 8,
    }).length;
    return { item, score: item.weight + Math.min(4, seen) };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]!.item;
}

/* ── the brief ──────────────────────────────────────────────────────────── */

/**
 * One precedent as one bullet.
 *
 * A row out of a note or a memory file carries its own paragraphs and its own
 * blank lines, and splitting the retrieval by kind is what surfaced it: the
 * conclusions people write down are long, where the chat turns that used to
 * fill this section were a sentence each. Left whole they break the list they
 * are in — a bullet whose second line starts at column one reads as the brief's
 * own prose, and the agent cannot tell where the person stopped talking.
 *
 * Cut at the same 300 characters a run's title is cut at, for the same reason:
 * enough to carry what was decided, short enough to stay a list.
 */
function oneLine(c: { hisWords: string; decision: string }): string {
  const text = (c.hisWords || c.decision).replace(/\s+/g, " ").trim();
  return `- ${text.length > 300 ? `${text.slice(0, 300)}…` : text}`;
}

/**
 * What the agent is told, and why the bank is most of it.
 *
 * An agent given only the card writes what any competent engineer would write.
 * Given his rules and the cases he has decided before, it writes something he
 * recognises — which is the entire difference between an assistant and a clone,
 * and the only thing 10,479 precedents were ever for.
 *
 * WHAT IT SAYS IS NOW READ BACK OFF THE TRANSCRIPTS OF ITS OWN RUNS, which is
 * the only way to tell a sentence that helps from one that merely sounds like
 * a senior engineer wrote it. Seven runs are on record; between 57% and 85% of
 * each one's wall time was spent sitting inside a full test suite, and one was
 * killed at the ceiling with nothing in its worktree at all. Every paragraph
 * added below is marked with what it is answering.
 *
 * Everything here has already been through the private-terms gate on its way
 * into the bank, so this assembles rather than filters.
 */
export function brief(
  item: WorkItem,
  worktree: string,
  api?: { url: string },
  /** The ceiling the loop will stop this run at. Told, never guessed here. */
  budgetMs?: number,
  /** What is left of the plan allowance, so a run can pace what it spends. */
  usage?: { weekRemaining: number } | null,
): string {
  /*
   * RANKED AGAINST THIS TASK, rather than the first forty in the file.
   *
   * `compiledRules().slice(0, 40)` took compile order and nothing else, and
   * compile order is the order the sources happened to be walked in. Measured
   * on the brief a run was actually handed on 2026-08-22: nineteen of its
   * forty rules were HTTP API guidance out of a third-party skill — idempotency
   * keys, cursor pagination, a sacred duty to downstream consumers — in a task
   * about naming a git branch. The rule that says never to create a worktree
   * or a branch in his employer's repository sits at index 727 of 1,239, so no
   * run has ever been sent it.
   *
   * `ask` already does this properly for the panel: rules that share a word
   * with the question, the question's own class as a bonus rather than as the
   * filter, and precedents tried with AND before falling back to OR. The brief
   * was the last caller still doing it by hand.
   */
  const bank = ask({
    text: `${item.title} ${item.detail}`.slice(0, 400),
    partition: OPEN_PARTITION,
    limit: 12,
  });
  const rules = bank.rules.map((r) => `- ${r.text}`);
  /*
   * TWO HEADINGS, because they were never the same claim.
   *
   * Everything retrieved used to arrive under "THINGS THEY DECIDED IN SIMILAR
   * SITUATIONS". The ten sent to the run of 2026-08-22 15:13 were all
   * transcript turns, none of them about the task, and the first of them was
   * the string "The previous response failed to produce a valid tool call.
   * Please retry the tool call now." — a harness error, presented to the agent
   * as a decision the person had made.
   *
   * `ask` keeps the two apart already: a note or a memory file is a conclusion
   * somebody wrote down, a transcript turn is what they said in the middle of
   * doing something, and most of those are questions. Both are worth showing;
   * only one of them is a decision, and the heading has to say which.
   */
  const decided = bank.decided.map(oneLine);
  const said = bank.said.map(oneLine);
  const minutes = budgetMs ? Math.round(budgetMs / 60_000) : null;

  /*
   * What is left of the week, told rather than guessed at.
   *
   * A run that does not know cannot pace its spending any more than it could
   * pace its time before the clock was added — and the failure looks the same
   * from outside: work that stops halfway for a reason nobody wrote down.
   */
  const budgetLine = usage
    ? `WHAT IS LEFT THIS WEEK: ${Math.round(usage.weekRemaining)}% of the owner's allowance`
      + `${usage.weekRemaining < 25 ? " — thin. Prefer the cheaper model and say what you skipped." : "."}`
    : "";

  return [
    "You are standing in for the person whose machine this is. Work the way they",
    "work, not the way you would. Where their rules and yours disagree, follow",
    "theirs — that is the whole point of you being here.",
    "",
    "HOW THEY WORK (their own words, from what they have written and done —",
    "the ones that share the words of this task, not the first that came to hand):",
    ...(rules.length ? rules : ["- (nothing of theirs matches this task)"]),
    "",
    ...(decided.length ? ["THINGS THEY SETTLED AND WROTE DOWN, in cases like this one:", ...decided, ""] : []),
    ...(said.length ? [
      "THINGS THEY SAID AT THE TIME — transcript turns, not conclusions. One is",
      "here because its words matched, which is not the same as it applying. Most",
      "of them are questions or a complaint about a screen:",
      ...said,
      "",
    ] : []),
    ...(bank.thin ? [
      "NOTHING OF THEIRS MATCHES THIS SITUATION. Do not reach for a precedent that",
      "is not there — work from the code in front of you and say that is what you",
      "did.",
      "",
    ] : []),
    "THE TASK:",
    item.title,
    item.detail ? `\n${item.detail}` : "",
    item.url ? `\n${item.url}` : "",
    "",
    "WHERE YOU ARE:",
    `A worktree of your own at ${worktree}. It is disposable — if this goes wrong`,
    "the whole directory is deleted, so work freely inside it.",
    "",
    /*
     * THE INSTALL, because four runs in a row found this out the expensive way —
     * and then the loop stopped leaving it to them.
     *
     * A worktree is cut with `git worktree add` and nothing links node_modules
     * into it, so before this paragraph moved the job, every suite's first
     * complaint was a missing package, and more than one run spent most of its
     * clock reading that as its own change breaking things. The fix was to stop
     * telling the agent to run `bun install` and have the loop run it before the
     * agent ever sees the worktree — see `installInto` in understudy-loop.ts.
     * A brief that still told you to do a job the loop already did would be
     * wrong twice over: redundant, and confusing about who is responsible when
     * it fails.
     */
    "The install has already been run for you in this worktree — you do not",
    "need to run `bun install` yourself. If a package is still missing, that",
    "means the install failed; you were told above if it did, and a missing",
    "package after that is the environment, not your change.",
    "",
    ...(api ? [
      /*
       * THE VIEWS, in the only form something without a screen can use them.
       *
       * He asked for the clone to have the views as well — the pull request
       * panel, the diff, the branch list. A view is pixels and a layout, which
       * means nothing to an agent; what a view IS underneath is a route. So it
       * gets the routes, and it gets told which view each one is, because
       * "/prs/list" and "the panel you look at every morning" being the same
       * thing is not obvious from the path.
       *
       * The credential is minted for this run and carries the understudy's
       * principal: every GET answers, every write refuses. Before this the
       * agent inherited the MACHINE token from the environment and could have
       * driven the entire application — the thing being fenced was holding the
       * key to its own fence.
       */
      "WHAT ELSE YOU CAN SEE:",
      `agentglass is running at ${api.url}, and $AGENTGLASS_READ_TOKEN is in your`,
      "environment. The same things the person sees in the app, as JSON:",
      "",
      `  curl -s -H "Authorization: Bearer $AGENTGLASS_READ_TOKEN" ${api.url}/prs/list?root=<repo>`,
      "      the pull request panel",
      "  …/git/changes-all        everything uncommitted, anywhere",
      "  …/git/branches?root=     the branch list",
      `  …/understudy/ask?q=<question>&partition=${OPEN_PARTITION}`,
      "      what THEY have written and done about something — use this when you",
      "      are unsure how they would want it, rather than deciding for them",
      "",
      "That token reads and cannot write: anything that would change the",
      "application refuses on purpose. Use git and your own tools for changes,",
      "inside this worktree.",
      "",
    ] : []),
    /*
     * THE CLOCK AND WHAT THINGS COST, which nothing here used to say.
     *
     * The loop stops a run at its ceiling wherever it has got to. One task —
     * an audit, whose whole deliverable was findings written down — was killed
     * at 45 minutes and 1 second with no commit and a clean worktree: it had
     * spent 17 of those minutes on five full suite runs and never reached the
     * writing. It could not have paced itself, because it was never told there
     * was anything to pace against.
     *
     * The costs are measured off the seven runs on record, not estimated: the
     * server suite between 234 and 293 seconds, the web suite about 32, and
     * every finishing run gave between 57% and 85% of its wall time to them.
     */
    ...(minutes ? [
      "HOW LONG YOU HAVE:",
      `${minutes} minutes from now, then the run is stopped wherever it is. Run \`date\``,
      "at the start if you want a deadline you can check against — nothing else",
      "will tell you the time.",
      "",
      "What things cost here, measured on the runs before you:",
      "  the server suite       ~4 minutes      the web suite   ~30 seconds",
      "  one test file           a second or two",
      "",
      "Every run so far spent between 57% and 85% of its time waiting for a full",
      "suite, most of it re-running the whole thing to read one failure. Run the",
      "file you touched while you work; keep the full suite for the end. A run",
      "that never commits is worth nothing, so leave time for it.",
      "",
    ] : []),
    /*
     * COMMIT BEFORE THE TURN ENDS, because two runs in a row lost finished work
     * to the same shape of mistake — one that thought there was a next turn to
     * wait in, one that thought a verdict of nothing was too small to write
     * down. There is no next turn: this text is read once, the loop records
     * whatever the shift left behind, and a background process nobody is left
     * to check on might as well not have been started.
     */
    "COMMIT AS SOON AS IT IS GREEN, THEN KEEP GOING. Not at the end — the",
    "moment the file you touched passes its own tests. A commit costs a second",
    "and can be amended, replaced or added to as many times as you like; the",
    "full suite costs four minutes and is the thing that runs out the clock.",
    "Three runs before you did the work, ran it green, started the full suite",
    "and ended their turn inside it, and all three left finished work sitting",
    "unrecorded. Commit first, verify second: if the suite then finds something,",
    "you fix it and commit again, and you have lost nothing either way.",
    "",
    "COMMIT BEFORE YOUR TURN ENDS. Work that sits uncommitted in this worktree",
    "when you stop talking did not happen, no matter how finished it was a",
    "moment before. If a suite is still running, wait for it in the foreground",
    "— a four-minute wait costs four minutes; ending the turn on a background",
    "run costs the whole task, because nothing you start in the background",
    "survives you. There is no next turn coming to read a notification, because",
    "there is nobody left to send it to.",
    "If you genuinely cannot finish, commit what you have and use your last",
    "words to say exactly what is done and what is not. A half-finished branch",
    "that says so honestly is worth far more than a clean worktree that quietly",
    "lost an hour of work.",
    "And if your answer really is \"there is nothing to change here\", that IS",
    "the deliverable — say it in full, with the evidence for it, as your last",
    "words. Whatever you say last is what gets recorded as the outcome of this",
    "run; there is no report anywhere else for it to live.",
    "",
    "HOW THEY EXPECT IT DONE — this is a senior engineer's working method and",
    "they will read the result as one:",
    "- ONE feature on this branch. If you find a second thing worth doing, write",
    "  it down and leave it; two changes tangled in one branch is the thing they",
    "  will send back first.",
    "- read the surrounding code before writing any. Match its comment density,",
    "  its naming, its idiom. Code that reads as though somebody else wrote it is",
    "  a change they have to review twice.",
    /*
     * THE COMMAND, spelled out, because four runs went looking for it.
     *
     * "the command they use" sent every one of them grepping the Makefile, the
     * package.json files and a CLAUDE.md that does not exist, two or three tool
     * calls each, and they still did not agree afterwards: one ran `make test`
     * and then the server suite again, another ran the web suite and chased an
     * unhandled error in a file it had not touched. Naming it costs four lines
     * and it is not a secret — `runTestsIn` is what actually decides the run.
     */
    "- their tests, green before you call it finished. `make test` is the command",
    "  they use: `cd server && bun test --timeout 20000`, then `cd web && bun test`.",
    "  The verdict recorded against this run is BOTH of those, run again after",
    "  you stop — a confident transcript over a red suite is a failed run.",
    "  Compiling is not evidence — they have said so in exactly those words.",
    "- a commit in their style, describing what changed and why.",
    "",
    /*
     * THE TOOLS IT HAS, WHICH THE BRIEF NEVER MENTIONED.
     *
     * Measured: "skill" appeared twice in this file and both were comments;
     * the text the agent reads named none of them, and said nothing about the
     * web at all. So a run had the person's skills, their MCPs, a browser
     * already signed in, and web search — and no reason to believe it did.
     *
     * Named individually rather than "you have skills": a list of five with
     * one line each is something an agent can act on, and "use your skills"
     * is not. The rule for each is HIS, taken from how he uses them.
     */
    /*
     * CHANGING GEAR MID-RUN, which is what he actually does.
     *
     * "within a single session the model and effort sometimes get changed
     * several times" — he drops to sonnet or haiku for the mechanical stretch and goes
     * back up for the thinking. Once this ran as `claude -p`, one shot with
     * the model fixed at launch, and the only thing a run could do about that
     * was hand the mechanical stretches to a cheaper subagent. Now the run
     * itself may be a real interactive session in a leased tmux window — see
     * understudy-pane.ts — and `/model` and `/effort` are commands it can type
     * into its own pane, the same two words he would type. Handing off to a
     * subagent is still the right call for a bounded mechanical stretch; this
     * is for the run's OWN gear over the course of a long task.
     *
     * The weekly allowance is his, not the clone's. Spending it on a rename at
     * the top tier is not thoroughness, it is taking his Thursday.
     */
    ...(budgetLine ? [budgetLine, ""] : []),
    "SPEND THE ALLOWANCE THE WAY THE OWNER DOES:",
    "- it is the OWNER'S weekly allowance and they need it for their own work. Running out",
    "  on a Wednesday is a worse failure than a slower answer.",
    "- do NOT type `/model` or `/effort` into your own pane to change gear",
    "  mid-task. Unlike the owner's own chat, nothing here can navigate the picker",
    "  they open — it waits on an arrow key nobody will send, and the run",
    "  dies right there. This run's model and effort are fixed for its",
    "  whole length; never ask for `fable` either way — see below.",
    "- hand the mechanical stretches to a cheaper subagent — a rename across",
    "  twelve files, a mechanical edit, reading a long file for one fact. Ask",
    "  for haiku when there is nothing to work out, sonnet for the middle.",
    "- keep your own turns for what actually needs the reasoning: the decision,",
    "  the diagnosis, the design. That is what you were given the tier for.",
    /*
     * MEASURED, and it cost a whole shift.
     *
     * The task-provider design run spawned two subagents and then spent every
     * remaining minute saying it would wait for them: "now let the subagents
     * finish — waiting for notification", "I'll just wait for the completion
     * notifications rather than poll", "I'll wait for the notifications now
     * instead of polling further". They never came back. It wrote nothing and
     * recorded itself done.
     *
     * The advice above is still right — delegating the mechanical stretch is
     * how a shift affords the thinking. What was missing is that delegation
     * has a cost of its own, and that a shift has a clock.
     */
    "- if you delegate, budget for it. A subagent you then wait on with no",
    "  deadline is one way to spend an entire shift producing nothing — that",
    "  has happened, twice over, on one task. Do the work yourself if you",
    "  cannot say roughly when the delegate is due back, and if you have",
    "  waited and nothing came, stop waiting and read the files. Slower per",
    "  file, and it finishes.",
    "- never ask for `fable`, for any part of anything. That allowance is the owner's.",
    "- if what is left is thin, say what you did NOT do because of it rather",
    "  than doing it badly and calling it done.",
    "",
    "WHAT YOU CAN REACH, and when the owner reaches for it:",
    /*
     * FOUR OF THE FIVE, counted by hand and named by hand.
     *
     * `~/.claude/skills` holds `browser-use`, `old-coder`, `old-coder-api`,
     * `scrum` and `test-harness-html`. A loader that read the directory would
     * be shorter and worse: it would also sweep in the twenty-odd plugin
     * skills and bury the four that carry his rule, and it would name `scrum`.
     *
     * `scrum` posts his daily standup, in his voice, to the channel his team
     * reads. It stays unnamed here for the same reason the task tracker is
     * fenced off — a run has no business speaking to people as him.
     */
    "- the owner's skills. `browser-use` drives the browser that is already signed in —",
    "  use it for a page behind a login, never curl. `old-coder` is the",
    "  evidence-first loop, for anything touching money, auth, data loss or a",
    "  public API. `old-coder-api` for changing an HTTP surface others call.",
    "  `test-harness-html` builds the page that walks the acceptance criteria of",
    "  a card by hand, for a card whose criteria have to be checked by hand.",
    "- the web, and in this order: the repository first, then the web. The owner has",
    "  said it plainly — look at what is already there before inventing. Search",
    "  when the answer is outside this codebase: a library's real behaviour, an",
    "  error nobody here has seen, a format you are guessing at. Do not search",
    "  for how to write code the owner has already written once.",
    "- installing what you need. If a tool would make this task right rather",
    "  than merely faster, install it inside this worktree and say so.",
    "",
    /*
     * PERMISSION TO ARGUE, and it is his own way of working.
     *
     * The only thing this brief said about disagreement was "where their rules
     * and yours disagree, follow theirs" — which is right about STYLE and
     * wrong about the task. He argues constantly: "I don't understand the ledger",
     * "that is no use to me", "this is not what I asked for". An understudy that never
     * pushes back is not standing in for him, it is impersonating a yes-man.
     *
     * The measured case: a run spent forty-five minutes on a task whose
     * framing was wrong and delivered nothing. Saying so in minute three would
     * have been worth more than the other forty-two.
     */
    /*
     * A VAGUE TASK IS NOT A SMALL TASK, and it is the common case.
     *
     * What arrives is usually a sentence: "a plugin system", "an
     * orchestrator", "make the UI better". Taken literally that produces a
     * framework nobody asked for; taken as an excuse to ask, it produces
     * nothing, because he is asleep. The third way is the one he uses on
     * himself — turn it into the question worth answering, from what is known
     * about how he decides, and then answer THAT.
     *
     * The rules below are his, drawn from the sessions in the bank: measure
     * before building, ask what the person gains, look for what already
     * exists, refuse the decorative, ship the smallest thing that can be
     * checked.
     */
    "IF THE TASK IS VAGUE, MAKE IT SHARPER — do not ask, and do not take it",
    "literally. Turn it into the question the owner would have asked:",
    "- what does somebody GAIN from this? If you cannot say who is better off",
    "  and how, that is the finding — write it down and stop.",
    "- what already exists here that does part of it? The owner looks before they",
    "  builds, and a thing this codebase already does is not a thing to build.",
    "- what is the smallest version that can be MEASURED? The owner does not accept",
    "  work they cannot check, including from themselves.",
    "- which part is decoration? The owner removes controls that govern nothing and",
    "  numbers with no data behind them, and they will remove yours.",
    "Say in the commit what you decided the task actually was, and why. Getting",
    "that wrong out loud is fine; getting it wrong silently is not.",
    "",
    "IF THE TASK IS WRONG, SAY SO — early, and then decide:",
    "- if the framing is wrong but the goal is clear, do the RIGHT thing and",
    "  say in the commit what you changed about the ask and why.",
    "- if it cannot be done well, stop and say what you would need. Forty-five",
    "  minutes of work on a bad premise is worth less than three minutes of",
    "  saying so.",
    "- do not agree with a suggestion you think is wrong just because it came",
    "  with the task. The owner does not, and they notice when something does.",
    "- and hold that line about your own work: a change you are not convinced",
    "  by, reported as finished, is the thing the owner trusts least.",
    "",
    "WHAT YOU MUST NOT DO:",
    "- do not push, and do not open a pull request. You could not if you tried:",
    "  this run has no git credential, no ssh agent and no `gh` login, and every",
    "  push url is rewritten to a host that does not resolve. Said here anyway,",
    "  because a fence you did not know about reads as a broken tool. Fetching",
    "  works; publishing does not. This repository has a great",
    "  deal of local work that has never gone to a remote, and pushing is not",
    "  yours to decide.",
    "- do not comment on anything, anywhere, and never write to the task tracker.",
    "- do not touch any repository other than this worktree.",
    "",
    "A person reviews this before any of that happens. If you cannot finish it",
    "honestly, stop and say why — leaving it half done and reporting it finished",
    "is the one unforgivable move here.",
  ].join("\n");
}

/* ── the run ────────────────────────────────────────────────────────────── */

const startRun = db.query<{ id: number }, [number | null, string, string, string, string, string, string, number]>(
  `INSERT INTO understudy_work (shift_id, source, item_id, title, repo, worktree, branch, started_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
);
const endRun = db.query<never, [string, string, number, number]>(
  "UPDATE understudy_work SET state = ?, outcome = ?, finished_at = ? WHERE id = ?",
);

export function beginRun(p: {
  shiftId: number | null; item: WorkItem; repo: string; worktree: string; branch: string;
}): number | null {
  /*
   * The source is told first, and told even if the insert below fails.
   *
   * `alreadyTaken` reads this table, so a run that got as far as cutting a
   * worktree is enough to stop the item coming round again — but only the
   * source knows how to stop SHOWING it. Without this the hand-filled queue
   * never drained: an item worked to completion stayed listed as pending and
   * the loop reported nothing to do, which is a contradiction anybody looking
   * at the two lists would have to resolve by guessing.
   */
  try { SOURCES.get(p.item.source)?.taken?.(p.item.id); } catch { /* a source that cannot forget is not a reason to skip the work */ }
  try {
    return startRun.get(
      p.shiftId, p.item.source, p.item.id, p.item.title.slice(0, 300),
      p.repo, p.worktree, p.branch, Date.now(),
    )?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Close runs this process cannot possibly be working on.
 *
 * A run is `running` for as long as something is awaiting it, and the thing
 * awaiting it lives in the server process. Restart the server — an install, a
 * crash — and those rows stay `running` for ever: nobody will ever write their
 * result, the tab shows work in flight that is not, and `runsSoFar` counts them
 * as neither finished nor broken, so a shift's stop rules cannot see them.
 *
 * Measured: two rows sat at `running` for 75 and 41 minutes with no agent
 * alive and no tmux window to look at.
 *
 * `abandoned` rather than `failed`, because those are different facts. Failed
 * means the work was done and judged; abandoned means nobody was left to judge
 * it. The worktree is untouched either way — whatever it managed is still
 * there, which is the whole reason a run keeps its directory.
 *
 * Called once at startup. Anything running at that moment predates this
 * process by definition.
 */
/**
 * What a row says the moment it is orphaned, before anything has looked at
 * its branch. `settleAbandoned` treats this exact sentence as "nothing is
 * known yet" — a placeholder to build a real verdict on, not a cause to keep
 * — so any OTHER text a row already carries (a stall, a stalled agent, a
 * missing tool) survives being settled instead of being talked over by a
 * theory about the branch.
 */
export const RESTART_PLACEHOLDER = "the server restarted while this was running — nobody was left to record how it ended";

export function abandonOrphanedRuns():
  { id: number; source: string; itemId: string; title: string; repo: string; worktree: string; branch: string; tipSha: string }[] {
  try {
    const rows = db.query<
      { id: number; source: string; item_id: string; title: string; repo: string; worktree: string; branch: string; tip_sha: string }, []
    >(
      /* The worktree and the branch come along now: an abandoned run leaves a
         directory behind, and something has to be able to name it — see
         `sweepEmptyWorktrees`. */
      /* `tip_sha` too: a branch that was merged and deleted between the crash
         and the recovery is landed work, and this is the only record of where
         it pointed. */
      "SELECT id, source, item_id, title, repo, worktree, branch, tip_sha FROM understudy_work WHERE state = 'running'",
    ).all();
    for (const r of rows) {
      finishRun(r.id, "abandoned", RESTART_PLACEHOLDER);
    }
    return rows.map((r) => ({
      id: r.id, source: r.source, itemId: r.item_id, title: r.title,
      repo: r.repo ?? "", worktree: r.worktree ?? "", branch: r.branch ?? "", tipSha: r.tip_sha ?? "",
    }));
  } catch {
    return [];
  }
}

/**
 * Worktrees of runs that ended with nothing in them.
 *
 * A run gets a worktree and a branch of its own, and an abandoned one kept both
 * for ever: nothing removed the directory, so a day of interrupted runs left a
 * checkout list nobody could read. Watched happen — "I keep seeing more wt here"
 * — and it is the same shape the code already worries about two files over:
 * "how somebody ends up with fourteen worktrees and no idea which is which".
 *
 * ONLY THE EMPTY ONES. A run that committed something delivered something, and
 * a branch with a commit on it is somebody's work whatever its run said. The
 * emptiness is asked of git rather than inferred from the outcome, because a
 * run marked abandoned can still have committed before it died — which is
 * exactly what one of them did today.
 */
export function endedRunsWithWorktrees(limit = 40):
  { id: number; repo: string; worktree: string; branch: string; state: WorkRun["state"]; outcome: string }[] {
  try {
    return db.query<
      { id: number; repo: string; worktree: string; branch: string; state: string; outcome: string },
      [number]
    >(
      `SELECT id, repo, worktree, branch, state, outcome FROM understudy_work
        WHERE state IN ('abandoned', 'failed') AND worktree <> '' AND branch <> ''
        ORDER BY id DESC LIMIT ?`,
    ).all(limit).map((r) => ({ ...r, state: r.state as WorkRun["state"] }));
  } catch {
    return [];
  }
}

/**
 * Runs that are `running` and have been for longer than they are allowed to be.
 *
 * The startup sweep above only ever runs at startup, which means a run whose
 * agent died silently stayed `running` until the next restart: measured, five
 * sat over 45 minutes and the worst sat for 513, because nothing was looking in
 * between. This is what looks in between.
 *
 * A generous margin over the loop's own 45-minute limit, because the loop kills
 * its own task first when it is alive to do it; this only catches the ones where
 * whatever was supposed to do the killing is itself gone.
 */
export function stalledRuns(olderThanMs: number, now = Date.now()):
  { id: number; source: string; itemId: string; title: string; startedAt: number }[] {
  try {
    return db.query<{ id: number; source: string; item_id: string; title: string; started_at: number }, [number]>(
      "SELECT id, source, item_id, title, started_at FROM understudy_work WHERE state = 'running' AND started_at < ?",
    ).all(now - olderThanMs).map((r) => ({
      id: r.id, source: r.source, itemId: r.item_id, title: r.title, startedAt: r.started_at,
    }));
  } catch {
    return [];
  }
}

/**
 * Correct the verdict on a run that already ended, WITHOUT moving its date.
 *
 * A register entry's date is the day the work happened; rewriting it because
 * somebody later worked out what became of the branch turns the history into
 * a list of when it was last looked at. `finishRun` stamps `finished_at`,
 * which is right when the run ends and wrong every time after.
 */
const restamp = db.query<never, [string, string, number]>(
  "UPDATE understudy_work SET state = ?, outcome = ? WHERE id = ?",
);
const stampTip = db.query<never, [string, number]>("UPDATE understudy_work SET tip_sha = ? WHERE id = ?");
const stampPane = db.query<never, [string, number]>("UPDATE understudy_work SET pane_id = ? WHERE id = ?");

/** Which tmux pane the run's agent is in, so aliveness can be asked of an
 *  identity rather than of a window name the program inside is free to change. */
export function rememberPane(id: number, paneId: string): void {
  if (!id || !paneId.startsWith("%")) return;
  try { stampPane.run(paneId, id); } catch { /* the row may be gone */ }
}

/** Remember where a run's branch was pointing, every time anything reads it.
 *  This is what lets a branch that is later merged and deleted be told apart
 *  from one nobody ever committed on. */
export function rememberTip(id: number, sha: string): void {
  if (!id || !sha) return;
  try { stampTip.run(sha, id); } catch { /* the row may be gone; nothing depends on this */ }
}

const reopenQ = db.query<never, [number]>(
  "UPDATE understudy_work SET state = 'running', outcome = '', finished_at = NULL WHERE id = ?",
);

/**
 * Put a row back to `running`, for the run that outlived this process.
 *
 * A run is an agent in a tmux window, and that window survives a restart of
 * the server perfectly well — measured: the recovery sweep closed the row
 * ("nobody was left to record how it ended") while the agent went on running
 * the suite, and the loop then started a SECOND attempt at the same task
 * beside it. The row is the only thing that was lost, so the row is what is
 * put back.
 */
export function reopenRun(id: number): void {
  try { reopenQ.run(id); } catch { /* the row may be gone */ }
}

export function restampRun(id: number, state: WorkRun["state"], outcome: string): void {
  try { restamp.run(state, outcome.slice(0, 4000), id); } catch { /* the run happened regardless */ }
}

export function finishRun(id: number, state: WorkRun["state"], outcome: string): void {
  try { endRun.run(state, outcome.slice(0, 4000), Date.now(), id); } catch { /* the run happened regardless */ }
}

/**
 * Six hex characters that stand for one item and nothing else.
 *
 * The source goes in with the id because an id is only promised to be unique
 * WITHIN its source — the same pair the ledger uses to decide a card has
 * already been taken. Hashed rather than used raw: an id is a card number or a
 * pull request URL, and neither of those belongs in a branch name.
 */
function tagFor(item: WorkItem): string {
  return createHash("sha1").update(`${item.source}:${item.id}`).digest("hex").slice(0, 6);
}

/**
 * A branch name in his shape, from a task title.
 *
 * The title alone was not enough. Truncating the slug to 40 characters means
 * two cards that open with the same long phrase — "Make the settings dialog …"
 * and any sibling of it — produced the SAME branch, and the second run died on
 * "worktree already exists" without ever starting. So the tag is appended: the
 * title is still what a person reads, and the six characters after it are what
 * keep two tasks apart.
 */
export function branchFor(item: WorkItem): string {
  const slug = item.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    // Again after the cut: slicing mid-word leaves a trailing dash, and
    // `feat/tidy-the--a1b2c3` reads like a typo.
    .replace(/-+$/, "") || "task";
  return `feat/${slug}-${tagFor(item)}`;
}

/**
 * The run that owns this worktree, or null — the answer to "may this be
 * deleted".
 *
 * `discardRun` ends in `rm -rf`, and its path arrived in a request body with
 * nothing checking it. That is an arbitrary recursive delete over HTTP: the
 * route asked git to remove a worktree and then removed the directory itself
 * whether or not git had recognised it, so any path on the machine was a valid
 * argument to a route whose entire job is deleting one.
 *
 * A run's worktree is the only thing this feature ever created and the only
 * thing it may destroy. Compared as an EXACT STRING against the value this
 * server wrote when it cut the worktree — not a prefix test, which `..` walks
 * straight out of, and not a realpath check, which a symlink answers for.
 */
/**
 * Is a run using this directory RIGHT NOW.
 *
 * Worktree paths are derived from the branch, which is derived from the task —
 * so the same task cut twice gets the same path, and the ENDED row of the
 * first attempt points at the directory the second attempt is working in.
 * Measured today: the sweep read that old row, found the directory (freshly
 * cut, seconds old), removed it, and the live run died of
 * `ENOENT … posix_spawn 'bun'` sixty-five seconds in, blaming a program that
 * was there all along. Twice, on the same task, on two different days.
 */
export function liveRunIn(worktree: string): WorkRun | null {
  const path = worktree.trim();
  if (!path) return null;
  try { return runs(200).find((r) => r.worktree === path && r.state === "running") ?? null; } catch { return null; }
}

export function runOwning(worktree: string): WorkRun | null {
  const path = worktree.trim();
  if (!path) return null;
  try {
    return runs(200).find((r) => r.worktree === path) ?? null;
  } catch {
    return null;
  }
}
