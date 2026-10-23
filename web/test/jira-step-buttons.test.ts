/*
 * The steps on a pull request for a Jira card: which buttons a card gets from
 * the saved steps, what each asks before it runs, the sentence that stands where
 * the buttons would be while writes are off, and the merge dialog's use of the
 * merge step. Statuses here are invented; the code names none.
 */
import { describe, expect, test } from "bun:test";
import { globalStubs } from "./stubGlobal";
// The libraries below read the window's storage when they load, so they load under a stub that goes back when the file ends.
globalStubs()("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
const { STEPS_OFF, hasQuestions, stepOffers } = await import("../src/lib/jiraStepUi.ts");
const { jiraMergeMove, movesOffered, stepOption, stepReaches } = await import("../src/lib/mergeJira.ts");
const { LEAVE_ALONE } = await import("../src/lib/cardMove.ts");
import type { JiraMergeCard } from "../src/lib/mergeJira.ts";
import type { JiraSteps } from "../../shared/providers.ts";

const off = { enabled: false, blocks: [] };
const steps = (o: Partial<JiraSteps>): JiraSteps => ({ handoff: off, review: off, merge: off, ...o });
const card = { status: "Building" };

describe("which buttons a card gets", () => {
  test("no saved steps, or steps that are off, give no button", () => {
    expect(stepOffers(null, card)).toEqual([]);
    expect(stepOffers(steps({}), card)).toEqual([]);
    expect(stepOffers(steps({ handoff: { enabled: true, blocks: [] } }), card)).toEqual([]);
  });

  test("a fixed move is a button that says where it goes, in the site's word", () => {
    const o = stepOffers(steps({ handoff: { enabled: true, blocks: [{ type: "move", statusNames: ["Peer check"] }] } }), card);
    expect(o.map((x) => [x.key, x.label, x.to])).toEqual([["handoff", "Transition to Peer check", "Peer check"]]);
    expect(hasQuestions(o[0]!)).toBe(false);
  });

  test("a card already where a move-only step would take it is offered nothing", () => {
    const s = steps({ handoff: { enabled: true, blocks: [{ type: "move", statusNames: ["peer check"] }] } });
    expect(stepOffers(s, { status: "Peer check" })).toEqual([]);
    // With a comment to post as well, the step still has something to do.
    const more = steps({ handoff: { enabled: true, blocks: [{ type: "move", statusNames: ["peer check"] }, { type: "comment", text: "Ready" }] } });
    expect(stepOffers(more, { status: "Peer check" }).length).toBe(1);
  });

  test("blocks that ask make the press a question: the status, the assignee, the people, the comment", () => {
    const s = steps({ review: { enabled: true, blocks: [{ type: "move", statusNames: ["Peer check"], ask: true }, { type: "unassign", who: "all", ask: true }, { type: "assign", who: "me", ask: true }, { type: "comment", text: "{pr_url}", ask: true }] } });
    const o = stepOffers(s, card)[0]!;
    expect(o).toMatchObject({ key: "review", label: "Review…", asksStatus: true, asksClear: true, asksAssign: true, asksComment: true, to: null, comment: "{pr_url}" });
    expect(hasQuestions(o)).toBe(true);
  });

  test("the merge step is not a button: it runs from the merge dialog", () => {
    expect(stepOffers(steps({ merge: { enabled: true, blocks: [{ type: "move", statusNames: ["Shipped"] }] } }), card)).toEqual([]);
  });

  test("with writes off, one sentence says why, and it does not name a status", () => {
    expect(STEPS_OFF).toBe("Changes in Jira are off, so a step does not run. Turn them on in Settings.");
  });
});

describe("a project whose older hand-off rule still wins", () => {
  // The site-wide hand-off names the first project's status; the second project keeps its own rule, and the server uses that.
  const global = steps({ handoff: { enabled: true, blocks: [{ type: "move", statusNames: ["Peer check", "Docs review"] }] } });
  const rule = (o: object) => ({ to: null, askTo: false, clear: false, askClear: false, ...o });
  const ctx = (project: string, rules: Record<string, ReturnType<typeof rule>>) => ({ project, overrides: ["DOCS"], rules });

  test("the button names the status the server will use, not the site-wide one", () => {
    const o = stepOffers(global, card, ctx("DOCS", { DOCS: rule({ to: { id: "7", name: "Docs review" } }) }));
    expect(o[0]).toMatchObject({ label: "Transition to Docs review", to: "Docs review", asksStatus: false, byRule: true });
    // A project with no override still reads the step.
    expect(stepOffers(global, card, ctx("ORBIT", {}))[0]).toMatchObject({ label: "Transition to Peer check" });
  });

  test("a rule that asks the status makes the press a question, though the step does not", () => {
    const o = stepOffers(global, card, ctx("DOCS", { DOCS: rule({ to: { id: "7", name: "Docs review" }, askTo: true, askClear: true }) }))[0]!;
    expect(o).toMatchObject({ label: "Hand off…", to: null, asksStatus: true, asksClear: true });
    expect(hasQuestions(o)).toBe(true);
  });

  test("a card already where the rule would take it is offered nothing", () => {
    expect(stepOffers(global, { status: "docs review" }, ctx("DOCS", { DOCS: rule({ to: { id: "7", name: "Docs review" } }) }))).toEqual([]);
  });

  test("an override with no rule to read falls back to the step, never to a guess", () => {
    expect(stepOffers(global, card, ctx("DOCS", {}))[0]).toMatchObject({ label: "Transition to Peer check" });
  });
});

describe("the merge step in the merge dialog", () => {
  const opt = (key: string, toStatus: string, needs?: string[]) => ({ key, label: toStatus, toStatus, toKind: "open" as const, ...(needs ? { needs } : null) });
  const base: JiraMergeCard = { key: "ORBIT-1042", label: "ORBIT-1042", query: "ORBIT-1042", title: "t", status: "Building", updated: 5, writes: true, options: [opt("11", "Peer check"), opt("21", "Shipped"), opt("31", "Parked", ["Reason"])] };

  test("the option the step's names point at is the one preselected, by the site's own word", () => {
    expect(stepOption({ ...base, step: { names: ["shipped"], ask: false, hasMove: true, extras: false } })?.key).toBe("21");
    expect(stepOption({ ...base, step: { names: ["Gone", "Peer check"], ask: false, hasMove: true, extras: false } })?.key).toBe("11");
    expect(stepOption({ ...base, step: { names: ["Gone"], ask: false, hasMove: true, extras: false } })).toBeUndefined();
    expect(stepOption(base)).toBeUndefined();
  });

  test("a move that needs a field is never preselected", () => {
    expect(stepOption({ ...base, step: { names: ["Parked"], ask: false, hasMove: true, extras: false } })).toBeUndefined();
  });

  test("the status sent for a pick is the status's name, not the label that tells two moves apart", () => {
    const two: JiraMergeCard = { ...base, step: { names: ["Peer check"], ask: true, hasMove: true, extras: false }, options: [{ ...opt("11", "Peer check"), label: "Peer check (Back to Peer check)" }] };
    expect(jiraMergeMove(two, "11")).toMatchObject({ step: true, toStatus: "Peer check", toLabel: "Peer check (Back to Peer check)" });
  });

  test("leaving the card where it is still runs a step that does more than move, and only then", () => {
    const more: JiraMergeCard = { ...base, step: { names: ["Shipped"], ask: false, hasMove: true, extras: true } };
    expect(jiraMergeMove(more, LEAVE_ALONE)).toMatchObject({ step: true, stay: true, id: "ORBIT-1042" });
    expect(jiraMergeMove({ ...base, step: { names: ["Shipped"], ask: false, hasMove: true, extras: false } }, LEAVE_ALONE)).toBeUndefined();
    expect(jiraMergeMove(base, LEAVE_ALONE)).toBeUndefined();
  });

  test("a step with no move still runs when the card is left, and offers no move of its own", () => {
    const note: JiraMergeCard = { ...base, step: { names: [], ask: false, hasMove: false, extras: true } };
    expect(jiraMergeMove(note, LEAVE_ALONE)).toMatchObject({ step: true, stay: true });
    expect(movesOffered(note).length).toBe(0);
  });

  test("a fixed step whose status this card cannot reach leaves every move on offer, and a pick of one is made on its own", () => {
    const lost: JiraMergeCard = { ...base, step: { names: ["Gone"], ask: false, hasMove: true, extras: true } };
    expect(movesOffered(lost).length).toBe(3);
    expect(stepReaches(lost)).toBe(false);
    expect(jiraMergeMove(lost, "21")).not.toHaveProperty("step");
    const fixed: JiraMergeCard = { ...base, step: { names: ["Shipped"], ask: false, hasMove: true, extras: true } };
    expect(movesOffered(fixed).map((o) => o.key)).toEqual(["21"]);
    expect(stepReaches(fixed)).toBe(true);
  });

  test("a pick under a step is marked as the step's, and a plain pick is not", () => {
    expect(jiraMergeMove({ ...base, step: { names: ["Shipped"], ask: false, hasMove: true, extras: false } }, "21")).toMatchObject({ tracker: "jira", step: true, toLabel: "Shipped" });
    expect(jiraMergeMove(base, "21")).not.toHaveProperty("step");
  });
});

describe("the panel is wired to the routes", () => {
  const code = async (p: string) => (await Bun.file(new URL(`../src/${p}`, import.meta.url)).text()).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  test("a Jira card on a pull request gets the step buttons with the pull request's own address", async () => {
    const s = await code("components/PrPanel.tsx");
    expect(s).toContain("<JiraStepButtons task={task} query={query}");
    expect(s).toContain("pr={{ url: d.url, title: d.title, number: d.number, author: d.author }}");
    expect(s).toContain('api.jiraRunStep(move.id, move.updated, "merge"');
  });

  test("a merge sends the status's name, can say to stay, and a landing in part is not read as success", async () => {
    const s = await code("components/PrPanel.tsx");
    expect(s).toContain("move.stay ? { stay: true } : { to: move.toStatus ?? move.toLabel ?? move.to }");
    expect(s).toContain('const part = "partial" in r && r.partial ? `but ${r.partial}` : "";');
    expect(s).toContain("flash(r.ok && !part && (!ex || ex.ok)");
  });

  test("the buttons run through the one step route and never the older hand-off one", async () => {
    const s = await code("components/jira/JiraStepButtons.tsx");
    expect(s).toContain("api.jiraRunStep(");
    expect(s).not.toMatch(/api\.jira(HandOff|Transition|SetAssignee)\(/);
    // Nothing runs while writes are off, whatever was pressed.
    expect(s).toContain("if (busy || !writes) return;");
    // The switch's sentence waits for the settings: while they load, writes may be on and the line would be false.
    expect(s).toContain("{settings && !writes && (");
    // No made-up status when the answer carries none.
    expect(s).not.toContain('"now done"');
    expect(s).not.toContain("|| \"done\"");
  });
});
