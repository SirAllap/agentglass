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

const ROOT = "/home/a/code/orbit";
beforeEach(() => { db.query("DELETE FROM seat_report").run(); });

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
