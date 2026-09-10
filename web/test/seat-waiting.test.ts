/*
 * WHAT IS WAITING ON THE PERSON.
 *
 * The day this was built from, in the orchestrator's own account: the person
 * had to ask "what have we got left?" six times, and each time the answer was
 * reassembled by hand out of a head and a list nobody else could see.
 *
 * Three of the four kinds are obvious. The fourth is the one worth a test: a
 * blocker whose agent has GONE. That work stopped and its owner left, so
 * nobody is coming back for it — it is the only kind here that disappears if
 * nothing says it, and it was asked for by the seat reading its own screen.
 */
import { describe, expect, test } from "bun:test";
import { whatWaits } from "../src/lib/seatWaiting.ts";
import type { SeatFieldRow, SeatNeed, SeatReportRow, SeatTask } from "../src/lib/api.ts";

const NOW = Date.now();
const agent = (name: string, over: Partial<SeatFieldRow> = {}): SeatFieldRow =>
  ({ name, state: "idle", pulse: [], ...over }) as SeatFieldRow;
const report = (agentName: string, over: Partial<SeatReportRow> = {}): SeatReportRow =>
  ({ id: Math.random(), agent: agentName, session: "", state: "", blocked: "", need: "", cost: "", raw: "", at: NOW, readAt: null, ...over });
const task = (over: Partial<SeatTask> = {}): SeatTask =>
  ({ id: "t", root: "/r", title: "a thing", detail: "", proof: "", weight: 0, created: NOW, takenAt: null, takenBy: "", doneAt: null, outcome: "", attempts: 0, ...over });

const need = (over: Partial<SeatNeed> = {}): SeatNeed =>
  ({ id: `n${Math.random()}`, root: "/r", text: "ask for a reviewer", cost: "one click", recommend: "", proof: "", created: NOW, doneAt: null, outcome: "", ...over });

describe("what waits", () => {
  test("nothing waiting is an answer, not an empty list", () => {
    const w = whatWaits([agent("busy", { state: "working" })], [], []);
    expect(w.count).toBe(0);
  });

  test("an agent stopped at a prompt is the cheapest thing to clear", () => {
    const w = whatWaits([agent("stuck", { needsYou: { kind: "input", why: "waiting for your input", since: NOW - 60_000 } })], [], []);
    expect(w.stopped.map((r) => r.name)).toEqual(["stuck"]);
    expect(w.count).toBe(1);
  });

  test("a live agent asking for a decision, in its own words", () => {
    const field = [agent("worker")];
    const w = whatWaits(field, [report("worker", { need: "a go on the push" })], []);
    expect(w.asked).toHaveLength(1);
    expect(w.orphaned).toHaveLength(0);
  });

  test("A BLOCKER WHOSE AGENT IS GONE IS ORPHANED WORK", () => {
    /* The one that vanishes if nothing says it. The agent said it was blocked
       and then went away: the row is not "somebody is waiting", it is "this
       stopped and nobody owns it". */
    const w = whatWaits([agent("still-here")], [report("long-gone", { blocked: "the container is somebody else's" })], []);
    expect(w.orphaned).toHaveLength(1);
    expect(w.asked, "an orphan was counted as somebody waiting").toHaveLength(0);
    expect(w.count).toBe(1);
  });

  test("and a name marked gone counts as gone, not as reachable", () => {
    /* `gone` is the server's rule — no pane here and quiet for hours — and it
       is what tells these two kinds apart. A row still in the list but marked
       gone must not make a blocker read as live. */
    const w = whatWaits([agent("ghost", { gone: true })], [report("ghost", { blocked: "waiting on a person" })], []);
    expect(w.orphaned).toHaveLength(1);
    expect(w.asked).toHaveLength(0);
  });

  test("a task that has beaten two agents wants a person, not a third go", () => {
    const w = whatWaits([], [], [task({ attempts: 2 }), task({ attempts: 1 }), task({ attempts: 3, doneAt: NOW })]);
    expect(w.beaten).toHaveLength(1);
  });

  test("a task somebody is carrying is not waiting on anybody", () => {
    const w = whatWaits([], [], [task({ attempts: 2, takenAt: NOW, takenBy: "someone" })]);
    expect(w.beaten).toHaveLength(0);
  });

  test("a report that says nothing is wrong is not on this list at all", () => {
    const w = whatWaits([agent("fine")], [report("fine", { state: "halfway through" })], []);
    expect(w.count).toBe(0);
  });
});

/*
 * THE FIFTH PILE, AND THE ONE THE SEAT USED MOST.
 *
 * Something finished that needs one action only a person can take: re-upload
 * the GIF, ask for a reviewer, say yes to a push. Before this it lived nowhere
 * but a chat, so it was lost the moment the conversation moved on. Not the
 * same pile as `asked`, and the direction is the difference: `asked` is what
 * the agents want from the person, `ready` is what the seat wants back.
 */
describe("what the seat asks of the person", () => {
  test("an open one waits; a settled one does not", () => {
    const w = whatWaits([], [], [], [need(), need({ doneAt: NOW })]);
    expect(w.ready).toHaveLength(1);
    expect(w.count).toBe(1);
  });

  test("it comes FIRST, because a decision is the only time that cannot be recovered", () => {
    /* The first draft put the stopped agent first — cheapest to clear. The seat
       corrected it: what the person takes time to decide is what holds up the
       day, and an agent parked at a prompt rarely is. */
    const order = Object.keys(whatWaits([], [], [], []));
    expect(order.slice(0, 5)).toEqual(["ready", "asked", "orphaned", "stopped", "beaten"]);
  });

  test("and it carries what it costs and what the seat would do", () => {
    const w = whatWaits([], [], [], [need({ cost: "one click", recommend: "ask Ale", proof: "reviewer requested" })]);
    expect(w.ready[0]?.cost).toBe("one click");
    expect(w.ready[0]?.recommend).toBe("ask Ale");
    expect(w.ready[0]?.proof).toBe("reviewer requested");
  });
});
