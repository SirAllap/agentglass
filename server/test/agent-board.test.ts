/*
 * WHO IS WORKING ON WHAT.
 *
 * "suddenly they are doing what looks like a lot of tasks but I don't even know
 * which, since there is no list I can look at." The deputy has a screen; the agents in
 * the terminals do not. Most of that list can be assembled from what this app
 * already reads, but what an agent is working ON only the agent knows, so it
 * says so — and these are the promises that line has to keep.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import * as Board from "../src/agentboard.ts";
import * as Pane from "../src/panewt.ts";
import { db } from "../src/db.ts";

beforeEach(() => { db.query("DELETE FROM agent_status").run(); });

describe("what an agent says about itself", () => {
  test("is a status, not a log: saying it again replaces the line", () => {
    Board.saidBy({ name: "review", doing: "reading the diff" });
    Board.saidBy({ name: "review", doing: "writing the fix" });
    const rows = Board.board().filter((r) => r.name === "review");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.doing).toBe("writing the fix");
  });

  test("carries where it is working, which is what tells two agents apart", () => {
    Board.saidBy({ name: "mobile", doing: "the tab strip", worktree: "/code/app-mobile", branch: "fix/tabs" });
    const [row] = Board.board().filter((r) => r.name === "mobile");
    expect(row?.worktree).toBe("/code/app-mobile");
    expect(row?.branch).toBe("fix/tabs");
  });

  test("and what it last left, which is what turns \"busy\" into \"done\"", () => {
    Board.saidBy({ name: "clone", doing: "next task", left: "a1b2c3d · merged" });
    expect(Board.board().find((r) => r.name === "clone")?.left).toBe("a1b2c3d · merged");
  });

  test("an agent with no name is not a row", () => {
    expect(Board.saidBy({ name: "   ", doing: "something" })).toBe(false);
    expect(Board.board()).toEqual([]);
  });

  test("finishing clears the line rather than leaving a claim behind", () => {
    Board.saidBy({ name: "peer", doing: "still going", session: "peer-session" });
    expect(Board.forgetAgent("peer", "peer-session")).toBe(true);
    expect(Board.board().some((r) => r.name === "peer")).toBe(false);
  });

  test("but only the session that wrote the line can clear it", () => {
    /*
     * The route is tokenless on loopback: a hooked session has nothing to
     * authenticate with, and this is the one thing it is asked to post. Keyed
     * on the name alone, `{name, done: true}` from any local process erased a
     * line that was not its own, and the board said "gone" about an agent
     * still working. The session id is the only thing the writer has that a
     * bystander reading the board does not.
     */
    Board.saidBy({ name: "peer", doing: "still going", session: "peer-session" });
    expect(Board.forgetAgent("peer", "somebody-else")).toBe(false);
    expect(Board.forgetAgent("peer", "")).toBe(false);
    expect(Board.board().some((r) => r.name === "peer")).toBe(true);
    /* A line posted with no session belongs to nobody in particular, and
       nobody in particular may clear it: it is replaced by the next status
       under that name, or it ages. */
    Board.saidBy({ name: "anon", doing: "no session" });
    expect(Board.forgetAgent("anon", "")).toBe(false);
    expect(Board.board().some((r) => r.name === "anon")).toBe(true);
  });

  test("a path or a branch is stored at 512 characters, whatever was sent", () => {
    /* `doing` and `left` were capped from the start; these two were not, on a
       route that is tokenless on loopback under a 32 MB body limit. */
    Board.saidBy({ name: "wide", doing: "x", worktree: "/w/" + "a".repeat(5000), branch: "b".repeat(5000) });
    const row = Board.board().find((r) => r.name === "wide")!;
    expect(row.worktree!.length).toBe(512);
    expect(row.branch!.length).toBe(512);
  });

  test("a stale line is kept and dated, never hidden", () => {
    const anHourAgo = Date.now() - 3_600_000;
    Board.saidBy({ name: "quiet", doing: "reading", at: anHourAgo });
    const [row] = Board.board().filter((r) => r.name === "quiet");
    expect(row, "hiding it turns \"nobody is on this\" into \"nothing to know\"").toBeDefined();
    expect(row!.saidAt).toBe(anHourAgo);
  });

  test("every row says whether it is a claim or an observation", () => {
    Board.saidBy({ name: "someone", doing: "x" });
    expect(Board.board()[0]!.from).toBe("said");
  });
});

/*
 * THE JOIN.
 *
 * Each source knows a different part of the machine — tmux the panes, git the
 * worktrees, the deputy its own runs — and the row a person reads is all of
 * them at once. What is worth pinning is who wins when they disagree and what
 * a row says when only one of them knows anything at all.
 */
describe("one row per agent, from every source", () => {
  const now = 1_000_000_000;
  const fresh = now - 60_000;
  const old = now - 3 * 60 * 60_000;

  test("a pane is matched by its working directory, not by its window name", () => {
    /* tmux renames a window when the program inside sets a title — the bug
       that cost a morning of the deputy's runs. The cwd cannot be renamed. */
    const [row] = Board.merged({
      said: [{ name: "mobile", doing: "tabs", worktree: "/code/app-mobile", saidAt: fresh, from: "said" }],
      panes: [
        { paneId: "%9", name: "something else entirely", cwd: "/code/app-mobile/mobile" },
        { paneId: "%1", name: "mobile", cwd: "/code/other" },
      ],
      now,
    });
    expect(row?.paneId).toBe("%9");
  });

  test("the branch comes from git when the agent did not say one", () => {
    const [row] = Board.merged({
      said: [{ name: "web", doing: "the panel", worktree: "/code/app-web", saidAt: fresh, from: "said" }],
      trees: [{ path: "/code/app-web", branch: "fix/panel" }],
      now,
    });
    expect(row?.branch).toBe("fix/panel");
  });

  test("but what the agent said wins over what git guessed", () => {
    const [row] = Board.merged({
      said: [{ name: "web", branch: "feat/mine", worktree: "/code/app-web", saidAt: fresh, from: "said" }],
      trees: [{ path: "/code/app-web", branch: "fix/panel" }],
      now,
    });
    expect(row?.branch).toBe("feat/mine");
  });

  test("a run in flight outranks anything anybody said", () => {
    const rows = Board.merged({
      said: [{ name: "the deputy", doing: "idle for hours", saidAt: old, from: "said" }],
      runs: [{ title: "a task", worktree: "/code/wt", branch: "feat/x", startedAt: fresh }],
      now,
    });
    const deputy = rows.filter((r) => r.name === "the deputy");
    expect(deputy).toHaveLength(1);
    expect(deputy[0]!.doing).toBe("a task");
    expect(deputy[0]!.state).toBe("working");
    expect(deputy[0]!.from, "a run is an observation, not a claim").toBe("seen");
  });

  test("a line said hours ago reads as idle, and still says when", () => {
    const [row] = Board.merged({ said: [{ name: "quiet", doing: "reading", saidAt: old, from: "said" }], now });
    expect(row?.state).toBe("idle");
    expect(row?.saidAt).toBe(old);
  });

  test("newest first, because the question is what is happening now", () => {
    const rows = Board.merged({
      said: [
        { name: "older", saidAt: old, from: "said" },
        { name: "newer", saidAt: fresh, from: "said" },
      ],
      now,
    });
    expect(rows.map((r) => r.name)).toEqual(["newer", "older"]);
  });
});

/*
 * THE FOUR THINGS THE SCREEN MUST NOT GET WRONG.
 *
 * Every one of these is a way the board could go on drawing a confident row
 * about something that is not true any more — which is worse than no board,
 * because a wrong answer is read once and believed.
 */
describe("the board tells the truth about what it can see", () => {
  const now = 1_000_000_000;
  const fresh = now - 60_000;

  test("an agent that never said what it is doing still gets its row", () => {
    /* Some agents write a status the moment they start and only fill in the
       task later; some only ever publish where they are. Dropping the row for
       a missing sentence hides the checkout, the branch and the pane too —
       six columns thrown away because one is blank. */
    const [row] = Board.merged({
      said: [{ name: "quiet", worktree: "/code/app-x", branch: "feat/x", left: "3 commits", saidAt: fresh, from: "said" }],
      panes: [{ paneId: "%4", name: "x", cwd: "/code/app-x" }],
      trees: [{ path: "/code/app-x", branch: "feat/x" }],
      now,
    });
    expect(row?.name).toBe("quiet");
    expect(row?.doing ?? "").toBe("");
    expect(row?.worktree).toBe("/code/app-x");
    expect(row?.branch).toBe("feat/x");
    expect(row?.left).toBe("3 commits");
    expect(row?.paneId).toBe("%4");
    expect(row?.state).toBe("working");
  });

  test("a checkout this machine can no longer see is not working, however fresh the word", () => {
    /* The claim is a minute old. The worktree it named was removed and the
       pane went with it — the exact shape of the deputy dying while its row
       stayed green. */
    const [row] = Board.merged({
      said: [{ name: "ghost", doing: "a task", worktree: "/code/app-gone", saidAt: fresh, from: "said" }],
      panes: [{ paneId: "%1", name: "other", cwd: "/code/app-live" }],
      trees: [{ path: "/code/app-live", branch: "feat/live" }],
      now,
    });
    expect(row?.state).toBe("idle");
  });

  test("with nothing read from the machine, a fresh word is still believed", () => {
    /* No panes and no trees is not evidence of absence: it is a tmux that did
       not answer. Manufacturing a contradiction out of an empty list would
       grey out every row the first time the socket hiccups. */
    const [row] = Board.merged({
      said: [{ name: "ghost", doing: "a task", worktree: "/code/app-gone", saidAt: fresh, from: "said" }],
      now,
    });
    expect(row?.state).toBe("working");
  });

  test("a merged branch is told apart from one nobody merged", () => {
    const rows = Board.merged({
      said: [
        { name: "landed", doing: "done", worktree: "/code/a", branch: "feat/in", saidAt: fresh, from: "said" },
        { name: "orphan", doing: "done", worktree: "/code/b", branch: "feat/out", saidAt: fresh, from: "said" },
      ],
      trees: [{ path: "/code/a", branch: "feat/in" }, { path: "/code/b", branch: "feat/out" }],
      landedBy: { "feat/in": { landed: true, into: "main" }, "feat/out": { landed: false, into: "main" } },
      now,
    });
    expect(rows.find((r) => r.name === "landed")?.landed).toBe(true);
    expect(rows.find((r) => r.name === "orphan")?.landed).toBe(false);
  });

  test("when nobody asked git, the row says nothing rather than \"not merged\"", () => {
    const [row] = Board.merged({
      said: [{ name: "unknown", doing: "x", worktree: "/code/a", branch: "feat/in", saidAt: fresh, from: "said" }],
      trees: [{ path: "/code/a", branch: "feat/in" }],
      now,
    });
    expect(row?.landed).toBeUndefined();
  });

  test("a deputy run in flight carries the merged answer too", () => {
    const [row] = Board.merged({
      runs: [{ title: "a task", worktree: "/code/d", branch: "feat/d", startedAt: fresh }],
      landedBy: { "feat/d": { landed: false, into: "main" } },
      now,
    });
    expect(row?.landed).toBe(false);
    expect(row?.state).toBe("working");
  });
});

describe("the route that draws it", () => {
  test("reads panes, worktrees and the run table — never a transcript", async () => {
    /*
     * A BOARD REFRESHED EVERY FIVE SECONDS MUST NOT OPEN A TRANSCRIPT.
     *
     * The tab's green dot already costs a file read per pane; a session
     * transcript is megabytes and there is one per agent, so a screen that
     * polls them would read hundreds of megabytes a minute to print a
     * sentence each agent already published. The cheap sources are the whole
     * design, and this is what stops the expensive one being added later "just
     * for the last line".
     */
    const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    const at = src.indexOf('pathname === "/agents/board"');
    expect(at).toBeGreaterThan(0);
    /* To the next route, whatever the handler grows to — no fixed slice. */
    const rest = src.slice(at);
    const end = rest.indexOf('pathname === "/agents/status"');
    expect(end).toBeGreaterThan(0);
    const handler = rest.slice(0, end);
    for (const reader of ["transcript", "sessionFile", "readSession", "jsonl"]) {
      expect(handler.toLowerCase()).not.toContain(reader.toLowerCase());
    }
  });
});

describe("the merged answer comes from the right repository", () => {
  const now = 1_000_000_000;
  const fresh = now - 60_000;

  test("a branch nobody asked about says nothing", () => {
    /* The route asks per repository, and a repository that will not answer
       contributes no entry — which must read as "unknown", never as "no". */
    const [row] = Board.merged({
      said: [{ name: "a", doing: "x", worktree: "/code/a", branch: "feat/a", saidAt: fresh, from: "said" }],
      landedBy: { "feat/other": { landed: true, into: "main" } },
      now,
    });
    expect(row?.landed).toBeUndefined();
    expect(row?.landedInto).toBeUndefined();
  });

  test("two repositories can give different refs in the same board", () => {
    /*
     * The whole reason this is keyed by branch. The employer's checkout is on
     * `master` and ours is on a working branch, and asking one repository
     * about the other's branches answered "not in master" for every row on
     * this machine — true, meaningless, and the shape of an answer that sends
     * somebody looking for work that is already in.
     */
    const rows = Board.merged({
      said: [
        { name: "here", doing: "x", worktree: "/code/app", branch: "feat/here", saidAt: fresh, from: "said" },
        { name: "there", doing: "y", worktree: "/code/other", branch: "fix/there", saidAt: fresh, from: "said" },
      ],
      landedBy: {
        "feat/here": { landed: true, into: "feat/working" },
        "fix/there": { landed: false, into: "trunk" },
      },
      now,
    });
    expect(rows.find((r) => r.name === "here")?.landedInto).toBe("feat/working");
    expect(rows.find((r) => r.name === "there")?.landedInto).toBe("trunk");
  });
});

describe("the route does not ask the configured workspace root", () => {
  test("it resolves each row's own checkout to its repository", async () => {
    /*
     * `workspaceRoot()` is whatever `config().root` says, and on this machine
     * that is the employer's repository — read-only, on `master`, and not
     * where any of this work lives. Reading it for this answer is how every
     * row came back "not in master".
     */
    // The assembly lives in lantern.ts now — one board for the route and the
    // terminal chat — and the route only calls it.
    const src = await Bun.file(new URL("../src/lantern.ts", import.meta.url)).text();
    const at = src.indexOf("export async function boardNow(");
    const handler = src.slice(at, src.indexOf("export function fieldReadout(", at));
    expect(handler).not.toContain("workspaceRoot()");
    expect(handler).toContain('"rev-parse", "--git-common-dir"');
    const route = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    const r = route.indexOf('pathname === "/agents/board"');
    expect(route.slice(r, r + 400)).toContain("await boardNow()");
  });
});

/*
 * THE AGENTS THAT NEVER SAY ANYTHING, which until now was all of them.
 *
 * `merged()` built its rows from two places: `agent_status`, written by
 * `POST /agents/status`, and the deputy's runs. Nothing else. And nothing on
 * this machine calls that route — `grep -rn -E 'agents/(say|status|board)' bin
 * hooks skills README.md docs` returns zero, so no agent surface knows it
 * exists. The Lantern showed the deputy and an empty list beside it, which reads
 * as "nobody is working" on a machine with six agents in tmux.
 *
 * The data was already there and already being written. `send_event.py` posts
 * `session_id`, `tmux_pane` and `cwd` to `/ingest` on every hook, and
 * `notePaneFromHook` persists them in `pane_agent` — 296 rows on this machine
 * the day this was written, while the board drew none of them.
 *
 * So a hook that reported a pane is a row. It is a `seen` row and says so:
 * nobody claimed to be doing anything, and the board must never print a guess
 * in the column where a claim goes. What it can honestly say is that something
 * with a transcript is alive in that pane, in that checkout, on that branch.
 */
describe("an agent nobody asked to announce itself", () => {
  const MIN = 60_000;
  const now = 1_700_000_000_000;
  /* A fictional checkout: the real ones name the employer, and this repository
     is public. */
  const wt = "/home/somebody/code/orbit-feature";
  const trees = [{ path: wt, branch: "feat/orbit-1042" }];

  test("is a row, from the pane its hooks reported", () => {
    const rows = Board.merged({
      hooks: [{ paneId: "%4", sessionId: "s-1", cwd: wt, at: now - 2 * MIN }],
      trees, now,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.paneId).toBe("%4");
    expect(rows[0]!.worktree).toBe(wt);
  });

  /*
   * "what the hell are they, what are they doing": a hook carries a sessionId, and that alone
   * reads as nothing — the pane id it fell back to before this. The name was
   * already sitting in `sessions` (see `sessionNames` in db.ts); this is the
   * other half, joining it in when the caller has one to offer.
   */
  test("is named for its session, when this machine knows the name", () => {
    const rows = Board.merged({
      hooks: [{ paneId: "%4", sessionId: "s-1", cwd: wt, at: now - MIN }],
      trees, now,
      names: new Map([["s-1", "race-condition-fix-measurement"]]),
    });
    expect(rows[0]!.name).toBe("race-condition-fix-measurement");
    // Still itself underneath the name — the pane is not lost, just not the
    // headline any more.
    expect(rows[0]!.paneId).toBe("%4");
  });

  test("falls back to the bare pane id for a session nobody has named", () => {
    const rows = Board.merged({
      hooks: [{ paneId: "%4", sessionId: "s-1", cwd: wt, at: now - MIN }],
      trees, now,
      names: new Map([["some-other-session", "not this one"]]),
    });
    expect(rows[0]!.name).toBe("%4");
  });

  test("and without a names map at all — the shape before this existed", () => {
    const rows = Board.merged({
      hooks: [{ paneId: "%4", sessionId: "s-1", cwd: wt, at: now - MIN }],
      trees, now,
    });
    expect(rows[0]!.name).toBe("%4");
  });

  test("is `seen`, and claims nothing about what it is doing", () => {
    /* The whole reason this is safe to add. `from` is the column that separates
       a claim from an observation, and a hook is an observation. */
    const [row] = Board.merged({ hooks: [{ paneId: "%4", sessionId: "s-1", cwd: wt, at: now - MIN }], trees, now });
    expect(row!.from).toBe("seen");
    expect(row!.doing ?? "").toBe("");
  });

  test("carries the branch of the checkout it is sitting in", () => {
    // The same lookup the said-rows get, for the same reason: a branch is a
    // fact about the directory, not something anybody has to report.
    const [row] = Board.merged({ hooks: [{ paneId: "%4", sessionId: "s-1", cwd: `${wt}/server/src`, at: now - MIN }], trees, now });
    expect(row!.branch).toBe("feat/orbit-1042");
  });

  test("is working while its hooks are fresh, and idle once they stop", () => {
    const hook = (ago: number) => [{ paneId: "%4", sessionId: "s-1", cwd: wt, at: now - ago }];
    expect(Board.merged({ hooks: hook(2 * MIN), trees, now })[0]!.state).toBe("working");
    expect(Board.merged({ hooks: hook(90 * MIN), trees, now })[0]!.state).toBe("idle");
  });

  test("does not overwrite an agent that DID say something", () => {
    /* A claim outranks an observation. The hook knows the pane; only the agent
       knows the task, and a row that lost `doing` to a merge would be the
       board getting quieter the more it knows. */
    Board.saidBy({ name: "review", doing: "reading the diff", worktree: wt, at: now - MIN });
    const rows = Board.merged({
      said: Board.board(),
      hooks: [{ paneId: "%4", sessionId: "s-1", cwd: wt, at: now - MIN }],
      trees, now,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.doing).toBe("reading the diff");
    expect(rows[0]!.from).toBe("said");
    // And it gains the pane, which is the half the hook knew and it did not.
    expect(rows[0]!.paneId).toBe("%4");
  });

  test("one row per pane, however many hooks that pane fired", () => {
    const rows = Board.merged({
      hooks: [
        { paneId: "%4", sessionId: "s-1", cwd: wt, at: now - 9 * MIN },
        { paneId: "%4", sessionId: "s-1", cwd: wt, at: now - MIN },
        { paneId: "%7", sessionId: "s-2", cwd: wt, at: now - MIN },
      ],
      trees, now,
    });
    expect(rows).toHaveLength(2);
    // The newest sighting wins: it is the one that decides working vs idle.
    expect(rows.find((r) => r.paneId === "%4")!.state).toBe("working");
  });
});

/*
 * The reader between the hooks' table and the board.
 *
 * Windowed on purpose: `pane_agent` keeps a row per pane for as long as that
 * pane id is not reused, so without a window a laptop opened after a weekend
 * would come back claiming a crowd of agents that are not there.
 */
describe("which panes the hooks have been heard from", () => {
  const MIN = 60_000;
  const now = 1_700_000_000_000;
  beforeEach(() => { db.query("DELETE FROM pane_agent").run(); });

  const note = (pane: string, ago: number, cwd = "/home/somebody/code/orbit") =>
    Pane.notePaneAgent({ pane, sessionId: `s${pane}`, transcriptPath: `/t/${pane}.jsonl`, cwd, at: now - ago });

  test("returns the recent ones, newest first", () => {
    note("%4", 30 * MIN);
    note("%7", 2 * MIN);
    const rows = Pane.recentPaneAgents({ now });
    expect(rows.map((r) => r.paneId)).toEqual(["%7", "%4"]);
  });

  test("and drops the ones older than the window", () => {
    note("%4", 40 * 60 * MIN); // 40 hours
    note("%7", MIN);
    expect(Pane.recentPaneAgents({ now }).map((r) => r.paneId)).toEqual(["%7"]);
  });

  test("the window is askable, because the board and a probe want different ones", () => {
    note("%4", 30 * MIN);
    expect(Pane.recentPaneAgents({ now, sinceMs: 10 * MIN })).toHaveLength(0);
    expect(Pane.recentPaneAgents({ now, sinceMs: 60 * MIN })).toHaveLength(1);
  });
});

/*
 * WHO NEEDS YOU — Lantern's first sentence, translated.
 *
 * Lantern reads "your approval", "may I merge", "waiting on you" off the pane
 * text. This app has the fact: Claude Code's own Notification hook, and the
 * gate. What is pinned here is what `merged()` does with the answer — the
 * word, the order, and that a session which moved on is not still waiting.
 */
describe("who needs you", () => {
  const MIN = 60_000;
  const now = 1_700_000_000_000;
  const wt = "/home/somebody/code/orbit-feature";
  const trees = [{ path: wt, branch: "feat/orbit-1042" }];
  const hook = (pane: string, session: string, ago: number) => ({ paneId: pane, sessionId: session, cwd: wt, at: now - ago });

  test("a seen row stopped on a permission is `waiting`, and says why", () => {
    const rows = Board.merged({
      hooks: [hook("%4", "s-1", 20_000)],
      trees, now,
      waiting: new Map([["s-1", { kind: "permission", why: "Claude needs your permission to use Bash", since: now - 20_000 }]]),
    });
    expect(rows[0]!.state).toBe("waiting");
    expect(rows[0]!.needsYou).toEqual({ kind: "permission", why: "Claude needs your permission to use Bash", since: now - 20_000 });
  });

  test("waiting outranks working, whatever the hook clock says", () => {
    // A hook that fired seconds ago is exactly what a permission prompt looks
    // like from here; "working" would be the one wrong word for it.
    const rows = Board.merged({
      hooks: [hook("%4", "s-1", 1_000)],
      trees, now,
      waiting: new Map([["s-1", { kind: "input", why: "Claude is waiting for your input", since: now - 1_000 }]]),
    });
    expect(rows[0]!.state).toBe("waiting");
  });

  test("a said row picks the wait up through the hook in its checkout", () => {
    Board.saidBy({ name: "orbit-1042", doing: "the migration", worktree: wt });
    const rows = Board.merged({
      hooks: [hook("%4", "s-1", MIN)],
      trees, now,
      waiting: new Map([["s-1", { kind: "gate", why: "held at the gate: Bash", since: now - MIN }]]),
    });
    const row = rows.find((r) => r.name === "orbit-1042")!;
    expect(row.state).toBe("waiting");
    expect(row.needsYou?.kind).toBe("gate");
    expect(row.session).toBe("s-1");
  });

  test("a said row that named its session is matched by it, no hook needed", () => {
    Board.saidBy({ name: "orbit-1042", doing: "the migration", session: "s-9" });
    const rows = Board.merged({
      trees, now,
      waiting: new Map([["s-9", { kind: "input", why: "waiting for your input", since: now - MIN }]]),
    });
    expect(rows.find((r) => r.name === "orbit-1042")?.state).toBe("waiting");
  });

  test("the order is: stopped on you, then moving, then quiet — oldest wait first", () => {
    const rows = Board.merged({
      hooks: [
        hook("%1", "idle-one", 90 * MIN),
        hook("%2", "working-one", MIN),
        hook("%3", "waits-short", 2 * MIN),
        hook("%4", "waits-long", 30 * MIN),
      ],
      trees, now,
      waiting: new Map([
        ["waits-short", { kind: "input", why: "waiting", since: now - 2 * MIN }],
        ["waits-long", { kind: "permission", why: "permission", since: now - 30 * MIN }],
      ]),
    });
    expect(rows.map((r) => r.paneId)).toEqual(["%4", "%3", "%2", "%1"]);
  });

  test("a session that moved on is not waiting, whatever it said earlier", () => {
    // `waiting` is the caller's fact; a session absent from it is drawn by its
    // clock alone. What this pins is that nothing in here invents a wait.
    const rows = Board.merged({ hooks: [hook("%4", "s-1", MIN)], trees, now, waiting: new Map() });
    expect(rows[0]!.state).toBe("working");
    expect(rows[0]!.needsYou).toBeUndefined();
  });
});

/*
 * THE ASK, and when it is made.
 *
 * Herdr's Lantern hands every agent it seats a rule to narrate `Goal: …`; here
 * the ask rides the hook's own answer on a prompt. Two clocks decide whether
 * to ask a session: has it answered already, and was it asked already.
 */
describe("the lantern reminder", () => {
  beforeEach(() => Board.__resetNudges());

  test("names the session, the endpoint, and how to say it is done", () => {
    const text = Board.lanternReminder({ session: "s-42", server: "http://127.0.0.1:4000" });
    expect(text).toContain('"session":"s-42"');
    expect(text).toContain("/agents/status");
    expect(text).toContain("http://127.0.0.1:4000");
    expect(text).toContain('"done":true');
    // The shell fills in where it is; the server does not guess.
    expect(text).toContain("$PWD");
  });

  test("is due once, then not again inside the interval", () => {
    const now = 1_700_000_000_000;
    expect(Board.nudgeDue("s-1", 20 * 60_000, now)).toBe(true);
    expect(Board.nudgeDue("s-1", 20 * 60_000, now + 60_000)).toBe(false);
    expect(Board.nudgeDue("s-1", 20 * 60_000, now + 21 * 60_000)).toBe(true);
  });

  test("a session that has answered is left alone for the whole interval", () => {
    const now = 1_700_000_000_000;
    Board.saidBy({ name: "orbit-1042", doing: "the migration", session: "s-2", at: now - 5 * 60_000 });
    expect(Board.nudgeDue("s-2", 20 * 60_000, now)).toBe(false);
    // …and asked again once the answer is old enough to be stale.
    expect(Board.nudgeDue("s-2", 20 * 60_000, now + 16 * 60_000)).toBe(true);
  });

  test("an unknown session is never asked — there is nothing to tie the answer to", () => {
    expect(Board.nudgeDue("", 60_000)).toBe(false);
    expect(Board.nudgeDue("unknown", 60_000)).toBe(false);
  });

  test("the session survives a rewrite of the same name that carries none", () => {
    // A hand-written status update with no session must not erase the one the
    // reminder tied to the row: that link is what stops the asking.
    Board.saidBy({ name: "orbit-1042", doing: "step one", session: "s-3" });
    Board.saidBy({ name: "orbit-1042", doing: "step two" });
    expect(Board.board().find((r) => r.name === "orbit-1042")?.session).toBe("s-3");
  });
});
