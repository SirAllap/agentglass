/*
 * The board's bulk "Request review…": which pull request gets which writes, the line said before Apply, the run
 * (GitHub first, then the tasks, with fake writers only) and the per-row results. States 8-12 of the approved mockup.
 */
import { describe, expect, it } from "bun:test";
import {
  bulkPlan, bulkRows, bulkSummary, canSend, countParts, failedParts, moveOffer, partsOf, resultLine, rowCounts, runBulk, startParts,
  toolDefaults, toolsOf, writesTo, runBusy, ghSkipNote, type BulkOut, type BulkPr, type CardJob, type Part, type ToolPick, type Who,
} from "../src/lib/prBulkAsk.ts";

const sam: Who = { login: "sam-acme", name: "Sam Acme" };
const J = (id: string, status: string, moves: string[] | null = ["In review", "Code review", "Done"]) => ({ kind: "jira" as const, id, status, moves });
const CU = (id: string, status: string) => ({ kind: "clickup" as const, id, status, moves: ["to do", "in progress", "in review", "done"] });
const pr = (number: number, task: BulkPr["task"], o: Partial<BulkPr> = {}): BulkPr => ({ number, title: `PR ${number}`, author: "ana", asked: [], task, ...o });

const on: ToolPick = { assign: true, move: true, to: "Code review" };
const linked = { linked: "Sam Acme", blocked: null };

describe("bulkPlan", () => {
  it("skips GitHub where the reviewer is already asked or opened it, and asks everywhere else", () => {
    const items = bulkPlan({ prs: [pr(1, null), pr(2, null, { asked: ["Sam-Acme"] }), pr(3, null, { author: "sam-acme" })], who: sam, picks: {}, tools: {} });
    expect(items.map((x) => x.gh)).toEqual([
      { send: true, skip: null },
      { send: false, skip: "Sam Acme is already asked" },
      { send: false, skip: "Sam Acme opened it, so cannot review it" },
    ]);
  });

  it("writes nothing to a task without a link, and nothing before a reviewer is picked", () => {
    const items = bulkPlan({ prs: [pr(1, null), pr(2, J("ORBIT-1", "To do"))], who: null, picks: { jira: on }, tools: { jira: linked } });
    expect(items[0]!.task).toBeNull();
    expect(items[1]!.gh.send).toBe(false);
    expect(items[1]!.task!.assign).toBe(false);
    expect(canSend(items, null)).toBe(false);
  });

  it("mixed tools: each task follows its own tool's switches", () => {
    const items = bulkPlan({
      prs: [pr(1, J("ORBIT-1", "To do")), pr(2, CU("CU-1", "in progress"))], who: sam,
      picks: { jira: { assign: false, move: true, to: "Code review" }, clickup: { assign: true, move: false, to: "in review" } },
      tools: { jira: linked, clickup: linked },
    });
    expect(items.map((x) => [x.task!.assign, x.task!.to])).toEqual([[false, "Code review"], [true, null]]);
  });

  it("no assign while the login is not linked in that tool; the move still goes", () => {
    const [x] = bulkPlan({ prs: [pr(1, J("ORBIT-1", "To do"))], who: sam, picks: { jira: on }, tools: { jira: { linked: null, blocked: null } } });
    expect(x!.task).toMatchObject({ assign: false, to: "Code review", skip: null });
  });

  it("a task that cannot make the move is left where it is and says why", () => {
    const [a, b] = bulkPlan({
      prs: [pr(1, J("ORBIT-1", "Blocked", ["To do"])), pr(2, J("ORBIT-2", "Blocked", ["To do"]))], who: sam,
      picks: { jira: on }, tools: { jira: linked },
    });
    expect(a!.task).toMatchObject({ assign: true, to: null, cant: "Code review is not a move this card can make from here", skip: null });
    void b;
    const [c] = bulkPlan({ prs: [pr(1, J("ORBIT-1", "Blocked", ["To do"]))], who: sam, picks: { jira: { ...on, assign: false } }, tools: { jira: linked } });
    expect(c!.task!.skip).toBe("Code review is not a move this card can make from here");
  });

  it("a tool with writes off writes nothing and says the lock line", () => {
    const [x] = bulkPlan({ prs: [pr(1, J("ORBIT-1", "To do"))], who: sam, picks: { jira: on }, tools: { jira: { linked: "Sam Acme", blocked: "Changes to Jira are off. Turn them on in Tasks." } } });
    expect(x!.task).toMatchObject({ assign: false, to: null, skip: "Changes to Jira are off. Turn them on in Tasks." });
  });

  it("nothing chosen, or already there", () => {
    const [a] = bulkPlan({ prs: [pr(1, J("ORBIT-1", "To do"))], who: sam, picks: { jira: { assign: false, move: false, to: "Code review" } }, tools: { jira: linked } });
    expect(a!.task!.skip).toBe("Nothing chosen for Jira");
    const [b] = bulkPlan({ prs: [pr(1, J("ORBIT-1", "Code review"))], who: sam, picks: { jira: { assign: false, move: true, to: "Code review" } }, tools: { jira: linked } });
    expect(b!.task!.skip).toBe("Already in Code review");
  });
});

describe("defaults and offers", () => {
  it("ClickUp follows its review step; Jira starts off", () => {
    expect(toolDefaults("clickup", { assignReviewer: true, reviewTo: "in review", offer: ["in qa"] })).toEqual({ assign: true, move: true, to: "in review" });
    expect(toolDefaults("clickup", { offer: ["in review"] })).toEqual({ assign: false, move: false, to: "in review" });
    expect(toolDefaults("jira", { assignReviewer: true, reviewTo: "In review", offer: ["Code review", "Done"] })).toEqual({ assign: false, move: false, to: "Code review" });
  });
  it("the move offer joins the tasks', review first", () => {
    expect(moveOffer([["Done", "In progress"], ["Code review", "done"]])).toEqual(["Code review", "Done", "In progress"]);
  });
  it("tools in the order they first appear; none for GitHub only", () => {
    expect(toolsOf([pr(1, null), pr(2, CU("CU-1", "x")), pr(3, J("O-1", "x"))])).toEqual(["clickup", "jira"]);
    expect(toolsOf([pr(1, null)])).toEqual([]);
  });
});

describe("summary", () => {
  it("state 9: Jira tasks assigned and moved", () => {
    const prs = [pr(1, J("O-1", "To do")), pr(2, J("O-2", "To do")), pr(3, null)];
    const items = bulkPlan({ prs, who: sam, picks: { jira: on }, tools: { jira: linked } });
    expect(bulkSummary(items, sam)).toBe("3 pull requests · reviewer Sam Acme · 2 Jira tasks assigned and moved to Code review");
    expect(writesTo(items)).toBe("GitHub and Jira");
  });
  it("state 10: GitHub only", () => {
    const items = bulkPlan({ prs: [pr(1, null), pr(2, null)], who: sam, picks: {}, tools: {} });
    expect(bulkSummary(items, sam)).toBe("2 pull requests · reviewer Sam Acme");
    expect(writesTo(items)).toBe("GitHub");
  });
  it("state 11: split counts when one cannot move and the login is not linked", () => {
    const items = bulkPlan({
      prs: [pr(1, J("O-1", "In progress")), pr(2, J("O-2", "Blocked", ["To do"])), pr(3, CU("CU-1", "in progress")), pr(4, null)], who: sam,
      picks: { jira: { assign: true, move: true, to: "Code review" }, clickup: { assign: true, move: true, to: "in review" } },
      tools: { jira: { linked: null, blocked: null }, clickup: linked },
    });
    expect(bulkSummary(items, sam)).toBe("4 pull requests · reviewer Sam Acme · 1 Jira task moved to Code review · 1 ClickUp task assigned and moved to in review");
    expect(writesTo(items)).toBe("GitHub, Jira and ClickUp");
  });
  it("null before a reviewer", () => {
    expect(bulkSummary([], null)).toBeNull();
  });
});

describe("runBulk with fake writers", () => {
  const prs = [pr(1, J("O-1", "To do")), pr(2, null, { asked: ["sam-acme"] }), pr(3, J("O-3", "To do")), pr(4, null)];
  const items = bulkPlan({ prs, who: sam, picks: { jira: on }, tools: { jira: linked } });

  it("sends every GitHub request before any task write, and reports what failed", async () => {
    const log: string[] = [];
    let out: BulkOut = startParts({}, partsOf(items));
    await runBulk(items, partsOf(items), {
      github: async (n) => { log.push(`gh ${n}`); return n === 4 ? { ok: false, error: "Validation failed." } : { ok: true }; },
      card: async (j: CardJob) => {
        log.push(`card ${j.id}`);
        if (j.id === "O-3") return { assign: { state: "ok" }, move: { state: "fail", error: "somebody changed this card while you had it open" } };
        return { assign: { state: "ok" }, move: { state: "ok" } };
      },
    }, (n, o) => { out = { ...out, [n]: { ...out[n], ...o } }; });
    const firstCard = log.findIndex((l) => l.startsWith("card"));
    expect(log.slice(0, firstCard).sort()).toEqual(["gh 1", "gh 3", "gh 4"]);
    expect(log.slice(firstCard).sort()).toEqual(["card O-1", "card O-3"]);

    const rows = bulkRows(items, out, sam);
    expect(rows[1]!.gh).toEqual({ st: "skipped", head: "GitHub", text: "Sam Acme is already asked" });
    expect(rows[1]!.task.text).toBe("No linked task");
    expect(rows[3]!.gh).toEqual({ st: "failed", head: "GitHub", text: "GitHub said: Validation failed." });
    expect(rows[0]!.task).toEqual({ st: "done", head: "Jira O-1", text: "assigned Sam Acme · moved to Code review" });
    expect(rows[2]!.task).toEqual({ st: "failed", head: "Jira O-3", text: "Jira said: somebody changed this card while you had it open. Already done: assign Sam Acme." });
    expect(rowCounts(rows)).toEqual({ done: 3, failed: 2, skipped: 3, busy: 0 });
    expect(resultLine(rows, items)).toBe("2 failed. Done steps stay done. Retry sends only the failed step. No undo for writes to GitHub and Jira.");

    /* Retry sends only the failed parts. */
    const again = failedParts(out);
    expect(again).toEqual({ 3: ["move"], 4: ["gh"] } as Record<number, Part[]>);
    expect(countParts(again)).toBe(2);
    const sent: string[] = [];
    out = startParts(out, again);
    expect(out[1]!.gh).toEqual({ state: "ok" });
    await runBulk(items, again, {
      github: async (n) => { sent.push(`gh ${n}`); return { ok: true }; },
      card: async (j) => { sent.push(`card ${j.id} assign=${j.assign} to=${j.to}`); return { move: { state: "ok" } }; },
    }, (n, o) => { out = { ...out, [n]: { ...out[n], ...o } }; });
    expect(sent).toEqual(["gh 4", "card O-3 assign=false to=Code review"]);
    expect(rowCounts(bulkRows(items, out, sam)).failed).toBe(0);
  });

  it("a writer that throws or leaves a part unanswered is a failure, not a spinner", async () => {
    let out: BulkOut = {};
    await runBulk(items, partsOf(items), {
      github: async () => { throw new Error("down"); },
      card: async () => ({ assign: { state: "ok" } }),
    }, (n, o) => { out = { ...out, [n]: { ...out[n], ...o } }; });
    const rows = bulkRows(items, out, sam);
    expect(rows[0]!.gh.text).toBe("GitHub did not answer.");
    expect(rows[0]!.task.st).toBe("failed");
    expect(rows[0]!.task.text).toBe("Jira did not answer. Already done: assign Sam Acme.");
  });

  it("while it runs the cells say Working…", () => {
    const rows = bulkRows(items, startParts({}, partsOf(items)), sam);
    expect(rows[0]!.gh.st).toBe("busy");
    expect(rows[0]!.task.st).toBe("busy");
    expect(resultLine(rows, items)).toBe("Working… No undo for writes to GitHub and Jira.");
  });
});

describe("review fixes", () => {
  const src = (f: string) => Bun.file(new URL(`../src/${f}`, import.meta.url).pathname).text();

  it("one press on the trigger does not close and reopen: the picker's outside press skips the trigger", async () => {
    const picker = await src("components/workspace/PeoplePicker.tsx");
    const bulk = await src("components/PrBulkAsk.tsx");
    expect(picker).toContain("if (trigger?.current?.contains(t as Node)) return;");
    expect(bulk).toContain("trigger={btn}");
  });

  it("while a write is busy nothing closes it, and a late answer from an old run is dropped", async () => {
    expect(runBusy(startParts({}, { 1: ["gh"] }))).toBe(true);
    expect(runBusy({ 1: { gh: { state: "ok" } } })).toBe(false);
    expect(runBusy(null)).toBe(false);
    const bulk = await src("components/PrBulkAsk.tsx");
    expect(bulk).toContain("const close = () => { if (busy) return;");
    expect(bulk).toContain("if (run.current === id)");
    expect(bulk).toContain("useDismiss(open && !!out && !busy, box, () => close());");
  });

  it("a linked task not read yet is skipped and says so; a write never sent never reads 'did not answer'", () => {
    const items = bulkPlan({ prs: [pr(1, { ...J("ORBIT-9", ""), unread: true })], who: sam, picks: { jira: on }, tools: { jira: linked } });
    expect(items[0]!.task).toMatchObject({ assign: false, to: null, skip: "Jira ORBIT-9 is not read yet. Nothing is written to it." });
    expect(partsOf(items)[1]).toEqual(["gh"]);
    const two = bulkPlan({ prs: [pr(2, J("ORBIT-2", "To do"))], who: sam, picks: { jira: on }, tools: { jira: linked } });
    const rows = bulkRows(two, { 2: { gh: { state: "ok" }, assign: { state: "fail", notSent: true }, move: { state: "fail", notSent: true } } }, sam);
    expect(rows[0]!.task.text).toBe("Not sent: the task was not read yet. Nothing was changed on the card.");
  });

  it("the author skip shows before Apply, beside 'already asked'", () => {
    const items = bulkPlan({ prs: [pr(1, null, { asked: ["sam-acme"] }), pr(2, null, { author: "sam-acme" }), pr(3, null, { author: "sam-acme" })], who: sam, picks: {}, tools: {} });
    expect(ghSkipNote(items, sam)).toBe("#1 already asks Sam Acme. #2, #3 opened by Sam Acme, so cannot be reviewed by them. GitHub skips them there.");
    expect(ghSkipNote(items.slice(1, 2), sam)).toBe("#2 opened by Sam Acme, so cannot be reviewed by them. GitHub skips it there.");
    expect(ghSkipNote(items, null)).toBeNull();
  });
});
