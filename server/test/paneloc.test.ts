// Finding the tmux pane an agent is waiting in.
//
// The fixtures are a real `list-panes -a` from a working machine, because the
// bug this guards is a plausible-looking wrong answer rather than a crash: the
// obvious key, `pane_current_path`, is the SHELL's directory, and here three
// panes report the same one while the agent worth pointing at is in a worktree
// none of them names. Matching on it would have offered the wrong pane three
// times over and the right one never.
//
// The /proc walk is injected, so these run the same on a machine with no tmux
// and no agents — the walk itself is the one part that cannot be tested without
// a process tree, and it is deliberately small.
import { describe, expect, test } from "bun:test";
import { parsePanes, paneForCwd, panesForCwd, withAgentSessions, paneForAgentSession, PANE_FORMAT } from "../src/paneloc.ts";

const APP = "/home/dev/code/orbit";
const WT = "/home/dev/code/orbit-WEB-1042";

// session_name, session_id, window_id, window_index, window_name, pane_id,
// pane_current_path, pane_pid — as PANE_FORMAT asks for them.
const OUT = [
  ["0", "$0", "@0", "1", "Editor", "%1", APP, "10811"],
  ["0", "$0", "@1", "2", "AI00", "%2", APP, "10858"],
  ["0", "$0", "@2", "3", "AI01", "%3", APP, "10892"],
  ["scratch", "$1", "@5", "1", "AI", "%10", APP, "155873"],
  ["scratch", "$1", "@6", "2", "lazygit", "%8", APP, "11246"],
].map((r) => r.join("\t")).join("\n");

/** Only %10 has agents, and the one that matters is in the worktree — not in
 *  the directory its own shell reports. Two of them, nested, because that is
 *  what the machine this was written against actually had: taking the shallow
 *  one named the project and missed the session doing the asking. */
const agents: Record<number, string[]> = { 155873: [APP, WT] };
const walk = (pid: number) => agents[pid] ?? [];

describe("reading the pane list", () => {
  test("the format and the parser agree on the field order", () => {
    // If someone adds a field to one and not the other, this is where it shows
    // up rather than as a mysteriously empty window name in the UI.
    expect(PANE_FORMAT.split("\t")).toEqual([
      "#{session_name}", "#{session_id}", "#{window_id}", "#{window_index}",
      "#{window_name}", "#{pane_id}", "#{pane_current_path}", "#{pane_pid}",
    ]);
  });

  test("every pane comes back, with its ids intact", () => {
    const rows = parsePanes(OUT, walk);
    expect(rows.length).toBe(5);
    expect(rows[3]).toMatchObject({
      session: "scratch", sessionId: "$1", windowId: "@5", windowIndex: "1",
      windowName: "AI", paneId: "%10", path: APP, agentCwds: [APP, WT],
    });
  });

  test("a pane with no agent under it says so rather than guessing", () => {
    expect(parsePanes(OUT, walk)[0]!.agentCwds).toEqual([]);
  });

  test("a nested agent is not hidden by the one above it", () => {
    // The regression that made this a list: the outermost agent was in the
    // project and the session asking for attention was in a worktree beneath
    // it, so the shallow answer pointed at the wrong directory every time.
    expect(parsePanes(OUT, walk)[3]!.agentCwds).toContain(WT);
  });

  test("a path containing a tab cannot shift the fields around it", () => {
    // Split from both ends: the pid is last and the path is everything between
    // the pane id and it. A naive index would have read the pid as part of the
    // path and dropped the row.
    const weird = ["0", "$0", "@9", "9", "w", "%99", "/home/dev/od\td", "4242"].join("\t");
    const [row] = parsePanes(weird, () => []);
    expect(row!.paneId).toBe("%99");
    expect(row!.path).toBe("/home/dev/od\td");
  });

  test("a truncated or empty answer yields nothing, not a half-row", () => {
    expect(parsePanes("", walk)).toEqual([]);
    expect(parsePanes("0\t$0\t@0", walk)).toEqual([]);
    expect(parsePanes(["0", "$0", "@0", "1", "w", "%1", APP, "not-a-pid"].join("\t"), walk)).toEqual([]);
  });
});

describe("choosing the pane to jump to", () => {
  const rows = parsePanes(OUT, walk);

  test("the match is on the agent's directory, never on the shell's", () => {
    // The worktree appears in no pane's `path` at all, and is still found.
    expect(rows.every((r) => r.path !== WT)).toBe(true);
    expect(paneForCwd(rows, WT)?.paneId).toBe("%10");

    // And the other direction, which is the one that would have gone wrong
    // quietly: four panes report APP as their shell's directory, and only %10
    // is running an agent there. The three that merely stand in the folder are
    // not answers.
    expect(rows.filter((r) => r.path === APP).length).toBeGreaterThan(1);
    expect(paneForCwd(rows, APP)?.paneId).toBe("%10");
  });

  test("two agents in one directory is a refusal, not a coin toss", () => {
    const two = parsePanes(OUT, (pid) => (pid === 155873 || pid === 11246 ? [WT] : []));
    expect(two.filter((r) => r.agentCwds.includes(WT)).length).toBe(2);
    // Landing you in the wrong conversation with nothing to tell you it was the
    // wrong one is worse than saying nothing.
    expect(paneForCwd(two, WT)).toBe(null);
  });

  test("the ambiguous case still says how many, so the UI can be honest", () => {
    const two = parsePanes(OUT, (pid) => (pid === 155873 || pid === 11246 ? [WT] : []));
    expect(panesForCwd(two, WT).length).toBe(2);
  });

  test("no directory, no pane", () => {
    expect(paneForCwd(rows, null)).toBe(null);
    expect(paneForCwd(rows, "")).toBe(null);
    expect(paneForCwd([], WT)).toBe(null);
  });
});

/*
 * The exact join, which arrived later than the directory one.
 *
 * The whole file above is about a guess made carefully: match the directory an
 * agent is genuinely running in, and decline whenever two of them share it.
 * Declining was right and it was also the common case — five agents in one
 * project directory is a working day here.
 *
 * Claude Code's hooks have been carrying `tmux_pane` all along, and panewt.ts
 * records it per session on every event. That makes "which pane is this session
 * in" an equality test on an id the agent itself reported, rather than an
 * inference from where it happens to be working. These two functions are the
 * read-back; the database is injected, because the failures worth pinning are
 * about the note and the pane list disagreeing.
 */
describe("the pane a session named itself", () => {
  const rows = parsePanes(OUT, walk);
  /** What the hook recorded: the busy pane, and one note left over from a pane
   *  that has since closed. Both are realistic — the table outlives tmux. */
  const notes: Record<string, { sessionId: string; at: number }> = {
    "%10": { sessionId: "sess-worktree", at: 2_000 },
    "%99": { sessionId: "sess-long-gone", at: 1_000 },
  };
  const noteOf = (paneId: string) => notes[paneId] ?? null;

  test("the session id rides along on the pane it was reported from", () => {
    const withNotes = withAgentSessions(rows, noteOf);
    expect(withNotes.find((r) => r.paneId === "%10")?.agentSession).toBe("sess-worktree");
  });

  test("a pane nobody reported carries null rather than an empty string", () => {
    // The web side tests this field for equality against a session id. An empty
    // string would match an alert whose session is unknown, which is every alert
    // from an OTel-only agent.
    const withNotes = withAgentSessions(rows, noteOf);
    expect(withNotes.find((r) => r.paneId === "%1")?.agentSession).toBeNull();
  });

  test("the session is found by its own id, whatever directory it is in", () => {
    // The point of the whole thing: no cwd is consulted, so two agents sharing
    // a worktree are no longer indistinguishable.
    const withNotes = withAgentSessions(rows, noteOf);
    expect(paneForAgentSession(withNotes, "sess-worktree")?.paneId).toBe("%10");
  });

  test("a note pointing at a pane that has closed finds nothing", () => {
    // The reason the intersection happens against the live list. `%99` is in the
    // table and not on the machine; offering it would be a button that moves
    // tmux nowhere and then shows you a terminal on something else.
    const withNotes = withAgentSessions(rows, noteOf);
    expect(paneForAgentSession(withNotes, "sess-long-gone")).toBeNull();
  });

  test("no session id asked about means no pane, not the first one", () => {
    const withNotes = withAgentSessions(rows, noteOf);
    expect(paneForAgentSession(withNotes, "")).toBeNull();
    expect(paneForAgentSession(withNotes, null)).toBeNull();
  });

  test("the rows are otherwise untouched", () => {
    // It decorates; it must not filter. A pane with no note is still a pane, and
    // the directory fallback downstream still needs all of them.
    expect(withAgentSessions(rows, noteOf).length).toBe(rows.length);
    expect(withAgentSessions(rows, noteOf)[3]).toMatchObject({ session: "scratch", agentCwds: [APP, WT] });
  });
});

/*
 * A pane id is not a name — tmux hands it out again.
 *
 * Found in the notes on the machine this runs on, before it could be found by
 * anyone using it:
 *
 *   session 4d419542 → %12, a minute ago
 *   session 4d419542 → %3,  twenty-one hours ago
 *
 * Both rows are honest. The agent really was in %3 yesterday; that pane closed,
 * tmux reused the id, and today %3 holds a shell with nothing to do with the
 * alert. Worse, %3 sorted ahead of %12 in the live list, so taking the first
 * match would have sent the user to that shell — a button that works, moves
 * tmux, and arrives at the wrong place, which is the failure mode this whole
 * feature was written to stop.
 */
describe("two panes claiming one session", () => {
  const rows = parsePanes(OUT, walk);

  test("the newest note wins", () => {
    const withNotes = withAgentSessions(rows, (id) => ({
      "%3": { sessionId: "sess-moved", at: 1_000 },   // yesterday, id since reused
      "%10": { sessionId: "sess-moved", at: 9_000 },  // where it is now
    } as Record<string, { sessionId: string; at: number }>)[id] ?? null);

    expect(paneForAgentSession(withNotes, "sess-moved")?.paneId).toBe("%10");
    // And the stale one is not merely outranked, it is cleared: anything else
    // reading this field would otherwise see a pane running a session that left
    // it a day ago.
    expect(withNotes.find((r) => r.paneId === "%3")?.agentSession).toBeNull();
  });

  test("list order does not decide it", () => {
    // The bug was invisible until the stale row happened to sort first. Same
    // notes, reversed rows, same answer.
    const noteOf = (id: string) => ({
      "%3": { sessionId: "sess-moved", at: 1_000 },
      "%10": { sessionId: "sess-moved", at: 9_000 },
    } as Record<string, { sessionId: string; at: number }>)[id] ?? null;

    expect(paneForAgentSession(withAgentSessions([...rows].reverse(), noteOf), "sess-moved")?.paneId).toBe("%10");
  });

  test("one pane listed twice is one pane, and the user's own row wins", () => {
    /*
     * Not two candidates. A paired phone joins as a grouped session, which
     * shares the original's windows, so `list-panes -a` reports each of those
     * panes once under `orbit` and once under `agx-phone-12-x5rsja`.
     *
     * This was written the other way first — an equal timestamp meant "cannot
     * tell", so both rows were blanked — and the live server then answered with
     * two exact panes where it had had nine. Five of the seven interesting ones
     * were the phone's doing. Declining is only honest when there really are
     * two answers.
     *
     * The user's own session is the one addressed: moving the mirror moves what
     * the phone is looking at, not what is on the desk.
     */
    const mirrored = [
      { paneId: "%12", session: "agx-phone-12-x5rsja", sessionId: "$9", windowId: "@40", windowIndex: "2", windowName: "AI01", path: APP, agentCwds: [WT] },
      { paneId: "%12", session: "orbit", sessionId: "$0", windowId: "@4", windowIndex: "2", windowName: "AI01", path: APP, agentCwds: [WT] },
    ];
    const withNotes = withAgentSessions(mirrored, () => ({ sessionId: "sess-mirrored", at: 5_000 }));
    expect(paneForAgentSession(withNotes, "sess-mirrored")?.session).toBe("orbit");
    // And exactly one row carries it, so nothing downstream sees the pane twice.
    expect(withNotes.filter((r) => r.agentSession).length).toBe(1);
  });

  test("two different panes with the same timestamp are declined", () => {
    // The case the tie rule is actually for: two notes, two panes, no way to
    // rank them. The directory fallback beats a coin flip.
    const two = [
      { paneId: "%0", session: "a", sessionId: "$0", windowId: "@0", windowIndex: "1", windowName: "sh", path: APP, agentCwds: [] },
      { paneId: "%7", session: "b", sessionId: "$1", windowId: "@9", windowIndex: "1", windowName: "sh", path: APP, agentCwds: [] },
    ];
    const withNotes = withAgentSessions(two, () => ({ sessionId: "sess-ambiguous", at: 5_000 }));
    expect(withNotes.every((r) => r.agentSession === null)).toBe(true);
    expect(paneForAgentSession(withNotes, "sess-ambiguous")).toBeNull();
  });
});
