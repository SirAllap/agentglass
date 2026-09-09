/*
 * THE INBOX.
 *
 * Asked for first, and in these words: a tray where each agent's report
 * arrives in the fixed format without the orchestrator having to paste them
 * five times. The cost it is fixing is real and was measured on this machine —
 * the first round of statuses came back forty lines per agent, into the one
 * context that re-reads everything each turn.
 *
 * The parser's rule is the interesting one: it never refuses. A report that
 * does not use the labels is still a report, and a parser that turns a status
 * into an argument about formatting has lost the thing that mattered.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-report-"));
process.env.AGENTGLASS_DOCTRINE = join(dir, "data");

const R = await import("../src/seatreport.ts");
const { db } = await import("../src/db.ts");
const Board = await import("../src/agentboard.ts");

const ROOT = "/home/a/code/orbit";
beforeEach(() => { db.query("DELETE FROM seat_report").run(); db.query("DELETE FROM agent_status").run(); });

describe("reading what an agent sent", () => {
  test("the four labels land in the four fields", () => {
    const f = R.parseReport([
      "STATE the retry drops the last page, reproduced",
      "BLOCKED nothing",
      "NEED a go on the fix",
      "COST 40 minutes, one worktree",
    ].join("\n"));
    expect(f.state).toBe("the retry drops the last page, reproduced");
    expect(f.blocked).toBe("nothing");
    expect(f.need).toBe("a go on the fix");
    expect(f.cost).toBe("40 minutes, one worktree");
  });

  test("with a colon, in bold, or in Spanish", () => {
    const f = R.parseReport("**ESTADO:** hecho\nBLOQUEO — ninguno\nNECESITO: nada\nCOSTE: 3 min");
    expect(f.state).toBe("hecho");
    expect(f.blocked).toBe("ninguno");
    expect(f.need).toBe("nada");
    expect(f.cost).toBe("3 min");
  });

  test("a paragraph with no labels is a state, not a rejection", () => {
    /* A parser that refuses a report turns a status into an argument about
       formatting, and the report is the thing that matters. */
    const f = R.parseReport("I could not reproduce it on master and I think the card is stale.");
    expect(f.state).toContain("could not reproduce");
    expect(f.blocked).toBe("");
  });

  test("a sentence before the first label is kept", () => {
    const f = R.parseReport("Reproduced it.\nBLOCKED nothing");
    expect(f.state).toBe("Reproduced it.");
    expect(f.blocked).toBe("nothing");
  });

  test("a multi-line field stays one field", () => {
    const f = R.parseReport("STATE first line\nsecond line\nCOST 2 min");
    expect(f.state).toBe("first line second line");
    expect(f.cost).toBe("2 min");
  });
});

describe("the tray", () => {
  const add = (agent: string, text: string) => R.addReport({ root: ROOT, agent, text });

  test("a report needs a sender and something to say", () => {
    expect(R.addReport({ root: ROOT, agent: "", text: "hi" }).ok).toBe(false);
    expect(R.addReport({ root: ROOT, agent: "a", text: "   " }).ok).toBe(false);
  });

  test("draining hands over everything unread, once", () => {
    /* The whole ask, in one assertion: five reports, one call. */
    for (const n of ["a", "b", "c", "d", "e"]) add(n, `STATE ${n} is fine`);
    expect(R.unreadCount(ROOT)).toBe(5);
    expect(R.drainReports(ROOT)).toHaveLength(5);
    expect(R.unreadCount(ROOT)).toBe(0);
    expect(R.drainReports(ROOT)).toHaveLength(0);
  });

  test("read is not deleted: what an agent said is the record", () => {
    add("a", "STATE done");
    R.drainReports(ROOT);
    expect(R.recentReports(ROOT)).toHaveLength(1);
  });

  test("each project has its own tray", () => {
    add("a", "STATE mine");
    R.addReport({ root: "/home/a/code/other", agent: "b", text: "STATE theirs" });
    expect(R.unreadCount(ROOT)).toBe(1);
    expect(R.unreadCount("/home/a/code/other")).toBe(1);
  });
});

describe("what the seat is told about its tray", () => {
  test("nothing waiting says so, rather than drawing a heading over nothing", () => {
    expect(R.inboxReadout(ROOT)).toBe("No unread reports.");
  });

  test("anybody blocked or needing something comes first", () => {
    R.addReport({ root: ROOT, agent: "quiet-one", text: "STATE still going" });
    R.addReport({ root: ROOT, agent: "stuck-one", text: "STATE waiting\nBLOCKED the container is somebody else's" });
    const text = R.inboxReadout(ROOT);
    expect(text).toContain("1 of them are stopped or need something");
    expect(text.indexOf("stuck-one")).toBeLessThan(text.indexOf("quiet-one"));
    expect(text).toContain("blocked: the container is somebody else's");
  });

  test("an agent that said nothing about its state is named, not hidden", () => {
    R.addReport({ root: ROOT, agent: "terse", text: "COST 1 min" });
    expect(R.inboxReadout(ROOT)).toContain("said nothing about its state");
  });
});

/*
 * WHAT IS WORTH A TURN, AND WHAT IS WORTH A LINE.
 *
 * The line is the seat's own: "reporte con ESTADO y nada más" is on its list of
 * things that should NOT wake it. Waking spends a whole turn of the most
 * expensive context on the machine, and spending one to learn that work is
 * proceeding is the cost this arrangement exists to avoid.
 */
describe("which reports are worth waking for", () => {
  test("a report that is only a state does not ring the bell — but it is still in the tray", () => {
    R.addReport({ root: ROOT, agent: "steady", text: "STATE still on the retry, halfway" });
    expect(R.unreadCount(ROOT)).toBe(1);
    expect(R.unreadWorthWaking(ROOT)).toBe(0);
    expect(R.inboxReadout(ROOT)).toContain("steady");
  });

  test("blocked or needing something does", () => {
    R.addReport({ root: ROOT, agent: "stuck", text: "STATE waiting\nBLOCKED the container is somebody else's" });
    expect(R.unreadWorthWaking(ROOT)).toBe(1);
    R.addReport({ root: ROOT, agent: "asking", text: "STATE ready\nNEED a go on the push" });
    expect(R.unreadWorthWaking(ROOT)).toBe(2);
  });

  test("and draining clears both counts, because it is the same tray", () => {
    R.addReport({ root: ROOT, agent: "a", text: "STATE fine\nNEED nothing much, but: a decision" });
    R.drainReports(ROOT);
    expect(R.unreadCount(ROOT)).toBe(0);
    expect(R.unreadWorthWaking(ROOT)).toBe(0);
  });
});

/*
 * THE BOARD'S LINE GOES STALE; A REPORT IS THE SAME AGENT SAYING THE SAME KIND
 * OF THING, MINUTES AGO.
 *
 * Measured on this machine: a row read "waiting to push" while three pushes had
 * already happened, because `doing` is the last line the agent posted to the
 * Lantern and nobody posts twice.
 */
describe("a report refreshes what the board says", () => {
  test("an agent the board knows gets its line updated", () => {
    Board.saidBy({ name: "porter", doing: "waiting to push", worktree: "/code/app", branch: "feat/x" });
    R.addReport({ root: ROOT, agent: "porter", text: "STATE pushed, and the checks are green" });
    const [row] = Board.board().filter((r) => r.name === "porter");
    expect(row?.doing).toBe("pushed, and the checks are green");
    /* And nothing else about the row was invented or lost. */
    expect(row?.worktree).toBe("/code/app");
    expect(row?.branch).toBe("feat/x");
  });

  test("a name the board has never seen does NOT become an agent", () => {
    /* The reporting name is whatever the worker's environment called it — a
       checkout basename, a tmux window. Writing a row for it would draw a
       second agent that does not exist. */
    const before = Board.board().length;
    R.addReport({ root: ROOT, agent: "nobody-has-seen-this", text: "STATE hello" });
    expect(Board.board().length).toBe(before);
  });
});

/*
 * THE SHAPE IT ACTUALLY ARRIVES IN.
 *
 * The four fields were written one per line, and the orchestrator this was
 * built for writes them in a row — that is the shape its own brief taught its
 * agents. Measured against the real thing: every field but the first landed in
 * `state`, and it noticed because `blocked/need/cost` came back empty.
 */
describe("a report on one line", () => {
  test("slash-separated labels are four fields, not one sentence", () => {
    const f = R.parseReport("ESTADO: PR lista y en verde / BLOQUEO: ninguno / NECESITO: revisor / COSTE: 0");
    expect(f.state).toBe("PR lista y en verde");
    expect(f.blocked).toBe("ninguno");
    expect(f.need).toBe("revisor");
    expect(f.cost).toBe("0");
  });

  test("in English, and mixed with newlines", () => {
    const f = R.parseReport("STATE done / BLOCKED nothing\nNEED a go on the push / COST 12 min");
    expect(f.state).toBe("done");
    expect(f.blocked).toBe("nothing");
    expect(f.need).toBe("a go on the push");
    expect(f.cost).toBe("12 min");
  });

  test("a slash that is not a label keeps its sentence whole", () => {
    /* `src/api / src/web` is one thought. Splitting on every slash would cut a
       state in half and file the second half under nothing. */
    const f = R.parseReport("STATE touched src/api / src/web and the tests pass");
    expect(f.state).toBe("touched src/api / src/web and the tests pass");
    expect(f.blocked).toBe("");
  });

  test("and one of these wakes the seat only if it is stopped or asking", () => {
    R.addReport({ root: ROOT, agent: "one-liner", text: "ESTADO: siguiendo / BLOQUEO: ninguno / NECESITO: nada / COSTE: 2 min" });
    /* "ninguno" and "nada" are answers, not blanks: the agent said it is not
       blocked, which is exactly the report that must NOT spend a turn. */
    expect(R.unreadWorthWaking(ROOT)).toBe(0);
  });
});

describe("what counts as blocked", () => {
  test("the words that mean nothing do not ring the bell", () => {
    /* The brief tells every worker to write "nothing" rather than leave the
       field blank, so the ordinary report has both fields filled in with a word
       that means empty. Counting those would be the rule not existing. */
    for (const word of ["nothing", "none", "nada", "ninguno", "N/A", "-", "no"]) {
      db.query("DELETE FROM seat_report").run();
      R.addReport({ root: ROOT, agent: "a", text: `STATE fine\nBLOCKED ${word}\nNEED ${word}` });
      expect(R.unreadWorthWaking(ROOT), `"${word}" was read as a blocker`).toBe(0);
    }
  });

  test("but a sentence that merely contains one does", () => {
    db.query("DELETE FROM seat_report").run();
    R.addReport({ root: ROOT, agent: "a", text: "STATE stuck\nBLOCKED nothing except the container, which is somebody else's" });
    expect(R.unreadWorthWaking(ROOT)).toBe(1);
  });
});
