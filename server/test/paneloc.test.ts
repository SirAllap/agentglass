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
import { parsePanes, paneForCwd, panesForCwd, PANE_FORMAT } from "../src/paneloc.ts";

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
