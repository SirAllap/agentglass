/*
 * WHAT THE SEAT ASKS OF THE PERSON.
 *
 * The tray is workers saying what THEY need. This is the other direction, and
 * the orchestrator running a real project here named the gap after a day of it
 * living nowhere but a chat: "pushed, re-upload gif-4", "the bot is clean, ask
 * for a reviewer", "three branches with no conflict, push?" — each one
 * finished, each one waiting on a single action only a person can take, each
 * one lost the moment the conversation moved on.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTGLASS_DOCTRINE = join(mkdtempSync(join(tmpdir(), "agx-need-")), "data");
const N = await import("../src/seatneed.ts");
const { db } = await import("../src/db.ts");

const ROOT = "/home/a/code/orbit";
beforeEach(() => { db.query("DELETE FROM seat_need").run(); });

describe("asking", () => {
  test("carries what it costs, what the seat would do, and what settles it", () => {
    const r = N.addNeed({ root: ROOT, text: "ask for a reviewer on 1042", cost: "one click", recommend: "Ale, she reviewed the last one", proof: "a reviewer requested" });
    expect(r.ok).toBe(true);
    const [n] = N.openNeeds(ROOT);
    expect(n?.text).toBe("ask for a reviewer on 1042");
    expect(n?.cost).toBe("one click");
    expect(n?.recommend).toContain("Ale");
    expect(n?.proof).toBe("a reviewer requested");
  });

  test("an empty ask is not an ask", () => {
    expect(N.addNeed({ root: ROOT, text: "   " }).ok).toBe(false);
  });

  test("no opinion is allowed: a seat that has none says nothing rather than inventing one", () => {
    N.addNeed({ root: ROOT, text: "push or wait for Monday?" });
    expect(N.openNeeds(ROOT)[0]?.recommend).toBe("");
  });

  test("twenty waiting is where the seat should be closing, not adding", () => {
    /* Its own rule for the queue it hands a person is one at a time, cheapest
       first. Twenty is where that has stopped being true. */
    for (let i = 0; i < N.MAX_OPEN; i++) expect(N.addNeed({ root: ROOT, text: `thing ${i}` }).ok).toBe(true);
    const over = N.addNeed({ root: ROOT, text: "one more" });
    expect(over.ok).toBe(false);
    expect(over.ok === false && over.error).toContain("close some");
  });

  test("settling one makes room and keeps it as record", () => {
    const r = N.addNeed({ root: ROOT, text: "re-upload the GIF" });
    const id = r.ok ? r.need.id : "";
    expect(N.finishNeed(id, "done, it is in the body")).toBe(true);
    expect(N.openNeeds(ROOT)).toHaveLength(0);
    expect(N.needsFor(ROOT)).toHaveLength(1);
    expect(N.needById(id)?.outcome).toContain("in the body");
    /* Twice is not an error, it is an answer that arrived late. */
    expect(N.finishNeed(id, "again")).toBe(false);
  });

  test("each project asks on its own behalf", () => {
    N.addNeed({ root: ROOT, text: "mine" });
    N.addNeed({ root: "/home/a/code/other", text: "theirs" });
    expect(N.openNeeds(ROOT)).toHaveLength(1);
    expect(N.openNeeds("/home/a/code/other")).toHaveLength(1);
  });
});

describe("what the seat reads back", () => {
  test("nothing waiting says so, rather than drawing a heading over nothing", () => {
    expect(N.needReadout(ROOT)).toContain("asked for nothing");
  });

  test("the oldest is first, because it has cost the most", () => {
    N.addNeed({ root: ROOT, text: "first thing", now: 1_000 });
    N.addNeed({ root: ROOT, text: "second thing", now: 2_000 });
    const text = N.needReadout(ROOT);
    expect(text.indexOf("first thing")).toBeLessThan(text.indexOf("second thing"));
  });

  test("and it reads back what it said, so a round does not ask twice", () => {
    N.addNeed({ root: ROOT, text: "push 1042?", cost: "a minute", recommend: "yes, the bot is clean" });
    const text = N.needReadout(ROOT);
    expect(text).toContain("push 1042?");
    expect(text).toContain("costs: a minute");
    expect(text).toContain("you said: yes, the bot is clean");
  });
});
