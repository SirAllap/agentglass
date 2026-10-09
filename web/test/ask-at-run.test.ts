/*
 * A block that asks when it runs: merging a colleague's pull request as a favour must not put the card
 * on the person who merged it. The setting is where the question starts; the person answers at the
 * moment of acting. What is pinned: who is offered and in what order, where the picker starts, what
 * happens when the author maps to nobody, that the person's own choice is what is written, and that an
 * older reader of the settings file never sees a guess.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ListMember, StepBlock } from "../../shared/providers.ts";
import { planOf, touchesPeople, legacyFromBlocks } from "../../shared/stepBlocks.ts";
import { askModel, filterAsk, isPicked, pickedIds, pickName, pickSentence, pickToEnsure, shortName, startingPick, startingTakeOff, togglePick, type Picked } from "../src/lib/askAtRun.ts";
import { orderMembers } from "../src/lib/peopleOrder.ts";
import { blocksSentence } from "../src/lib/stepBlocksView.ts";
import { AssignPicker, useAskAssign } from "../src/components/AssignPicker.tsx";
import { stepChanges } from "../src/lib/stepAssign.ts";
import { AUTHOR_IS_MEMBER } from "../../shared/providers.ts";

const m = (id: number, name: string, over: Partial<ListMember> = {}): ListMember => ({ id, name, initials: name.slice(0, 2), ...over });
const TEAM = [m(1, "Zoe Okafor"), m(2, "Ada Test", { me: true }), m(3, "Sam Rivera"), m(4, "Pia Novak"), m(5, "Leo Marsh")];
const person = (id: number): Picked[number] => ({ kind: "person", id, name: TEAM.find((x) => x.id === id)!.name });

describe("a GitHub user is never matched to a ClickUp member", () => {
  test("the tracker states it: ClickUp's accounts are not GitHub's", () => {
    expect(AUTHOR_IS_MEMBER.clickup).toBe(false);
  });
  test("an author given to the model changes nothing: no row is lifted, no tag is drawn", () => {
    const author = { login: "srivera", name: "Sam Rivera", email: "sam@example.test" };
    const withAuthor = askModel({ members: TEAM, author, onCard: [{ id: 5 }] });
    const without = askModel({ members: TEAM, onCard: [{ id: 5 }] });
    expect(withAuthor.rows.map((r) => r.member.id)).toEqual([5, 2, 4, 3, 1]);
    expect(withAuthor).toEqual(without);
  });
  test("the path stays for a tracker that shares identity with GitHub, behind the capability", () => {
    const team = [m(1, "Zoe Okafor"), m(3, "Sam Rivera", { email: "sam@example.test" })];
    const r = askModel({ members: team, author: { login: "srivera", email: "sam@example.test" }, authorIsMember: true }).rows;
    expect(r.map((x) => x.member.id)).toEqual([3, 1]);
    expect(startingPick({ who: "author" }, { members: team, author: { login: "srivera", email: "sam@example.test" }, authorIsMember: true }).pick).toEqual([{ kind: "person", id: 3, name: "Sam Rivera" }]);
  });
  test("the picker ignores the author even when the setting says author", () => {
    const Probe = () => React.createElement(AssignPicker, { state: useAskAssign({ on: true, start: { who: "author" }, author: { login: "srivera", email: "sam@example.test" }, members: TEAM }) });
    expect(renderToStaticMarkup(React.createElement(Probe))).toContain('aria-label="Assign to: nobody"');
  });
  test("the Settings choices do not offer it", async () => {
    const src = await Bun.file(new URL("../src/components/StepBlocks.tsx", import.meta.url).pathname).text();
    expect(src).toContain('(w !== "author" || AUTHOR_IS_MEMBER.clickup)');
  });
});

describe("who is offered: the order of the card's own Assigned picker", () => {
  const ids = (o: Parameters<typeof askModel>[0]) => askModel(o).rows.map((r) => r.member.id);
  test("the card's people first, then you, then everybody else by name: the same order the Tasks card uses", () => {
    expect(ids({ members: TEAM, onCard: [{ id: 5 }, { id: 1 }] })).toEqual([5, 1, 2, 4, 3]);
    expect(ids({ members: TEAM, onCard: [{ id: 5 }, { id: 1 }] })).toEqual(orderMembers(TEAM, new Set([5, 1])).map((x) => x.id));
    expect(ids({ members: TEAM })).toEqual([2, 5, 4, 3, 1]);
  });
  test("it says which rows are the card's, so the picker can draw its rule between the groups", () => {
    const rows = askModel({ members: TEAM, onCard: [{ id: 3 }, { id: 2 }] }).rows;
    expect(rows.map((r) => [r.member.id, r.onCard])).toEqual([[2, true], [3, true], [5, false], [4, false], [1, false]]);
  });
  test("people on the card who are not members of the list are not invented; no members is no rows", () => {
    expect(ids({ members: TEAM, onCard: [{ id: 99 }, { id: 4 }] })).toEqual([4, 2, 5, 3, 1]);
    expect(askModel({ members: null }).rows).toEqual([]);
  });
  test("a search keeps names and emails that contain it, case aside", () => {
    const rows = askModel({ members: [...TEAM.slice(0, 2), m(3, "Sam Rivera", { email: "sam@example.test" })] }).rows;
    expect(filterAsk(rows, "RIV").map((r) => r.member.id)).toEqual([3]);
    expect(filterAsk(rows, "sam@").map((r) => r.member.id)).toEqual([3]);
    expect(filterAsk(rows, "  ").length).toBe(3);
  });
});

describe("where the picker starts", () => {
  test("me is the default, and the person pressing once the members are known", () => {
    expect(startingPick(undefined, { members: TEAM }).pick).toEqual([person(2)]);
    expect(startingPick({ who: "me" }, { members: null }).pick).toEqual([{ kind: "me" }]);
  });
  test("a named person, several people, and nobody", () => {
    expect(startingPick({ who: "person", person: { id: 4, name: "Pia Novak" } }, { members: TEAM }).pick).toEqual([person(4)]);
    expect(startingPick({ who: "person", person: { id: 4, name: "Pia Novak" }, also: [{ id: 5, name: "Leo Marsh" }] }, { members: TEAM }).pick).toEqual([person(4), person(5)]);
    expect(startingPick({ who: "none" }, { members: TEAM }).pick).toEqual([]);
  });
});

describe("several people", () => {
  test("a tick adds a person and takes them off again; the person pressing is the same whichever way they were picked", () => {
    let p: Picked = [];
    p = togglePick(p, TEAM[2]!); p = togglePick(p, TEAM[3]!);
    expect(p).toEqual([person(3), person(4)]);
    expect(isPicked(p, TEAM[2]!)).toBe(true);
    p = togglePick(p, TEAM[2]!);
    expect(p).toEqual([person(4)]);
    expect(isPicked([{ kind: "me" }], TEAM[1]!)).toBe(true);
    expect(togglePick([{ kind: "me" }], TEAM[1]!)).toEqual([]);
  });
  test("the trigger says up to two names and counts the rest; the sentence names them all", () => {
    expect(shortName("Sam Rivera")).toBe("Sam R.");
    expect(shortName("Cher")).toBe("Cher");
    const three: Picked = [{ kind: "person", id: 1, name: "Sam Rivera" }, { kind: "person", id: 2, name: "Ada Lovelace" }, { kind: "person", id: 3, name: "Leo Marsh" }];
    expect(pickName([])).toBe("nobody");
    expect(pickName(three.slice(0, 2))).toBe("Sam R., Ada L.");
    expect(pickName(three)).toBe("Sam R., Ada L. +1");
    expect(pickSentence(three.slice(0, 2))).toBe("Sam R. and Ada L.");
    expect(pickSentence(three)).toBe("Sam R., Ada L. and Leo M.");
    expect(pickSentence([{ kind: "me" }])).toBe("you");
  });
  test("they mean the same one write as a single person does: added when missing, nobody else taken off", () => {
    const people = [{ id: 2, me: true, name: "Ada Test" }, { id: 5, name: "Leo Marsh" }];
    const e = pickToEnsure([person(3), person(2), person(4)]);
    expect(e.kind).toBe("many");
    const { write, named } = stepChanges({ people, unassign: "all", ensure: e });
    expect(write).toEqual({ add: [3, 4], rem: [5] }); // Ada stays (picked and already on), Leo comes off with "everyone"
    expect(named).toBe("Sam Rivera and Pia Novak");
    expect(stepChanges({ people, unassign: "none", ensure: pickToEnsure([{ kind: "me" }, person(3)]) }).write).toEqual({ add: [3] });
    expect(pickToEnsure([])).toEqual({ kind: "none" });
  });
});

describe("the picker holds its starting choice", () => {
  const Probe = ({ start }: { start: Parameters<typeof startingPick>[0] }) => React.createElement(AssignPicker, { state: useAskAssign({ on: true, start, members: TEAM, onCard: [{ id: 5 }] }) });
  test("it opens on the default, on several people, and on nobody when that is the default: the card is not given to the person merging", () => {
    expect(renderToStaticMarkup(React.createElement(Probe, { start: { who: "me" } }))).toContain('aria-label="Assign to: you"'.replace("you", "Ada T."));
    expect(renderToStaticMarkup(React.createElement(Probe, { start: { who: "person", person: { id: 3, name: "Sam Rivera" }, also: [{ id: 4, name: "Pia Novak" }] } }))).toContain('aria-label="Assign to: Sam R., Pia N."');
    expect(renderToStaticMarkup(React.createElement(Probe, { start: { who: "none" } }))).toContain('aria-label="Assign to: nobody"');
  });
  test("what the person chose is not moved by a later answer from the server", async () => {
    const src = await Bun.file(new URL("../src/components/AssignPicker.tsx", import.meta.url).pathname).text();
    expect(src).toContain("const pick = chosen ?? begin.pick;");
  });
});

describe("taking people off", () => {
  const onCard = [TEAM[1]!, TEAM[2]!, TEAM[3]!];
  test("the picker starts where the setting says, among the people on the card", () => {
    expect(startingTakeOff({ who: "none" }, { cardPeople: onCard })).toEqual([]);
    expect(startingTakeOff({ who: "me" }, { cardPeople: onCard })).toEqual([person(2)]);
    expect(startingTakeOff({ who: "all" }, { cardPeople: onCard })).toEqual([person(2), person(3), person(4)]);
    expect(startingTakeOff({ who: "people", people: [{ id: 4, name: "Pia Novak" }, { id: 99, name: "Gone" }] }, { cardPeople: onCard })).toEqual([person(4)]);
  });
  test("a pick means ids, with the person pressing resolved from the members", () => {
    expect(pickedIds([{ kind: "me" }, person(3)], TEAM)).toEqual([2, 3]);
  });
  test("named people come off, and only those on the card; everybody else stays, and an ensured person never does", () => {
    const people = [{ id: 2, me: true, name: "Ada Test" }, { id: 3, name: "Sam Rivera" }, { id: 4, name: "Pia Novak" }];
    expect(stepChanges({ people, unassign: "none", takeOff: [3, 99], ensure: { kind: "none" } }).write).toEqual({ rem: [3] });
    expect(stepChanges({ people, unassign: "all", takeOff: [], ensure: { kind: "none" } }).write).toEqual({});
    expect(stepChanges({ people, unassign: "none", takeOff: [3, 4], ensure: { kind: "person", id: 4, name: "Pia Novak" } }).write).toEqual({ rem: [3] });
  });
  test("the run-time picker is the same component, over the card's people", async () => {
    const src = await Bun.file(new URL("../src/components/AssignPicker.tsx", import.meta.url).pathname).text();
    expect(src).toContain("export function useAskTakeOff(");
    expect(src).toContain("dividerBefore={(m, prev) => onCard.has(m.id) !== onCard.has(prev.id)}");
    const dlg = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url).pathname).text();
    expect(dlg).toContain('<AssignPicker state={off} label="Take off" nobody="take nobody off" />');
  });
});

describe("the block, as it is saved", () => {
  const ask = (who: "me" | "none"): StepBlock => ({ type: "assign", ask: true, who });
  test("the plan carries where the question starts and fixes nobody", () => {
    const p = planOf("merge", { enabled: true, statusNames: [], assign: { who: "none" }, blocks: [{ type: "move", statusNames: ["done"] }, ask("me")] });
    expect(p.askAssign).toEqual({ who: "me" });
    expect(p.assign).toEqual({ who: "none" });
    expect(touchesPeople(planOf("move", { enabled: true, statusNames: [], assign: { who: "none" }, blocks: [ask("me")] }))).toBe(true);
    expect(planOf("move", { enabled: true, statusNames: [], assign: { who: "none" }, blocks: [{ type: "assign", who: "me" }] }).askAssign).toBeNull();
  });
  test("an older reader of the file sees no assignment, not a guess", () => {
    expect(legacyFromBlocks([ask("me")]).assign).toEqual({ who: "none" });
    expect(legacyFromBlocks([{ type: "move", statusNames: ["qa"], ask: true }]).statusNames).toEqual(["qa"]);
  });
  test("the step's sentence says it asks, and where it starts", () => {
    const say = (blocks: StepBlock[]) => blocksSentence({ lead: "Confirm the merge:", trigger: "merge", blocks, item: "card", status: "done" });
    expect(say([{ type: "move", statusNames: ["done"] }, ask("me")])).toBe("Confirm the merge: preselect done, then ask who to assign it to, starting at you.");
    expect(say([ask("none")])).toBe("Confirm the merge: ask who to assign it to, starting at nobody.");
    expect(say([{ type: "move", statusNames: ["done"], ask: true }])).toBe("Confirm the merge: ask which status to move the card to, starting at done.");
  });
});

describe("the three places that ask", () => {
  const read = (f: string) => Bun.file(new URL(`../src/${f}`, import.meta.url).pathname).text();
  test("the merge dialog writes the picked person, and shows the picker only when the card moves", async () => {
    const d = await read("components/MergeDialog.tsx");
    expect(d).toContain("const ensure: Ensure = askAssign ? asked.ensure : fixedEnsure;");
    expect(d).toContain("movesCard(card.card.status, status) && askAssign && (");
  });
  test("the card's button asks in the dialog and still writes once", async () => {
    const src = await read("components/PrPanel.tsx");
    const at = src.indexOf("function CardReadyForQaButton(");
    const body = src.slice(at, src.indexOf("\nfunction ", at + 10));
    expect(body).toContain("if (askStatus || askAssign || askUnassign || extras) { await runAsked(); return; }");
    expect(body.match(/api\.clickupCard\(/g)?.length).toBe(1);
  });
  test("the review menu's item reads the picker's choice, with the members it already holds", async () => {
    const src = await read("components/PrPanel.tsx");
    expect(src).toContain("const ensure: Ensure = askAssign ? asked.ensure : fixedEnsure;");
    expect(src).toContain("useAskAssign({ on: !!askAssign, members,");
  });
  test("the picker is the app's one people picker", async () => {
    const src = await read("components/AssignPicker.tsx");
    expect(src).toContain('import { PeoplePick } from "./PeoplePick.tsx";');
    expect(src).not.toContain("AnchoredMenu");
  });
});
