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
import { askModel, filterAsk, pickName, pickToEnsure, startingPick } from "../src/lib/askAtRun.ts";
import { blocksSentence } from "../src/lib/stepBlocksView.ts";
import { AssignPicker, useAskAssign } from "../src/components/AssignPicker.tsx";

const m = (id: number, name: string, over: Partial<ListMember> = {}): ListMember => ({ id, name, initials: name.slice(0, 2), ...over });
const TEAM = [m(1, "Zoe Okafor"), m(2, "Ada Test", { me: true, email: "ada@example.test" }), m(3, "Sam Rivera", { email: "sam@example.test" }), m(4, "Priya Nair"), m(5, "Leo Marsh")];
const AUTHOR = { login: "srivera", name: "Sam Rivera", email: "sam@example.test" };

describe("who is offered, in the order the question asks", () => {
  const ids = (o: Parameters<typeof askModel>[0]) => askModel(o).rows.map((r) => r.member.id);
  test("the author first, then who is on the card, then me, then everybody else by name", () => {
    expect(ids({ members: TEAM, author: AUTHOR, onCard: [{ id: 5 }, { id: 1 }] })).toEqual([3, 5, 1, 2, 4]);
  });
  test("each person once, with every reason that applies", () => {
    const rows = askModel({ members: TEAM, author: AUTHOR, onCard: [{ id: 3 }, { id: 2 }] }).rows;
    expect(rows.map((r) => r.member.id)).toEqual([3, 2, 5, 4, 1]);
    expect(rows[0]!.tags).toEqual(["pull request author", "on the card"]);
    expect(rows[1]!.tags).toEqual(["on the card", "you"]);
    expect(rows[2]!.tags).toEqual([]);
  });
  test("an author who maps to nobody is said once and is not guessed at", () => {
    const model = askModel({ members: TEAM, author: { login: "ghost", name: "Ghost" }, onCard: [{ id: 5 }] });
    expect(model.authorUnmapped).toBe("ghost");
    expect(model.rows.map((r) => r.member.id)).toEqual([5, 2, 4, 3, 1]);
    expect(askModel({ members: TEAM, author: AUTHOR }).authorUnmapped).toBeNull();
    expect(askModel({ members: TEAM }).authorUnmapped).toBeNull();
  });
  test("people on the card who are not members of the list are not invented; no members is no rows", () => {
    expect(ids({ members: TEAM, onCard: [{ id: 99 }, { id: 4 }] })).toEqual([4, 2, 5, 3, 1]);
    expect(askModel({ members: null, author: AUTHOR }).rows).toEqual([]);
  });
  test("a search keeps names and emails that contain it, case aside", () => {
    const rows = askModel({ members: TEAM }).rows;
    expect(filterAsk(rows, "RIV").map((r) => r.member.id)).toEqual([3]);
    expect(filterAsk(rows, "ada@").map((r) => r.member.id)).toEqual([2]);
    expect(filterAsk(rows, "  ").length).toBe(5);
  });
});

describe("where the picker starts", () => {
  test("me is the default, and the person pressing once the members are known", () => {
    expect(startingPick(undefined, { members: TEAM }).pick).toEqual({ kind: "person", id: 2, name: "Ada Test" });
    expect(startingPick({ who: "me" }, { members: null }).pick).toEqual({ kind: "me" });
  });
  test("the author when the members can say who that is", () => {
    expect(startingPick({ who: "author" }, { members: TEAM, author: AUTHOR }).pick).toEqual({ kind: "person", id: 3, name: "Sam Rivera" });
  });
  test("an author who maps to nobody starts at nobody and says why, rather than at somebody else", () => {
    const s = startingPick({ who: "author" }, { members: TEAM, author: { login: "ghost" } });
    expect(s.pick).toEqual({ kind: "nobody" });
    expect(s.note).toMatch(/ghost/);
  });
  test("a named person, and nobody", () => {
    expect(startingPick({ who: "person", person: { id: 4, name: "Priya Nair" } }, { members: TEAM }).pick).toEqual({ kind: "person", id: 4, name: "Priya Nair" });
    expect(startingPick({ who: "none" }, { members: TEAM }).pick).toEqual({ kind: "nobody" });
  });
  test("a pick means the same thing to the write as the fixed choices do", () => {
    expect(pickToEnsure({ kind: "nobody" })).toEqual({ kind: "none" });
    expect(pickToEnsure({ kind: "me" })).toEqual({ kind: "me" });
    expect(pickToEnsure({ kind: "person", id: 3, name: "Sam Rivera" })).toEqual({ kind: "person", id: 3, name: "Sam Rivera" });
    expect(pickName({ kind: "me" })).toBe("you");
  });
});

describe("the picker holds its starting choice", () => {
  const Probe = ({ start, members }: { start: { who: "me" | "author" | "none" }; members: ListMember[] }) => {
    const s = useAskAssign({ on: true, start, author: AUTHOR, onCard: [{ id: 5 }], members });
    return React.createElement(AssignPicker, { state: s });
  };
  test("it opens on the default, and on nobody when the default is nobody: the card is not given to the person merging", () => {
    expect(renderToStaticMarkup(React.createElement(Probe, { start: { who: "me" }, members: TEAM }))).toContain('aria-label="Assign to: Ada Test"');
    expect(renderToStaticMarkup(React.createElement(Probe, { start: { who: "author" }, members: TEAM }))).toContain('aria-label="Assign to: Sam Rivera"');
    expect(renderToStaticMarkup(React.createElement(Probe, { start: { who: "none" }, members: TEAM }))).toContain('aria-label="Assign to: nobody"');
  });
  test("what the person chose is not moved by a later answer from the server", async () => {
    const src = await Bun.file(new URL("../src/components/AssignPicker.tsx", import.meta.url).pathname).text();
    expect(src).toContain("const pick = chosen ?? begin.pick;");
  });
});

describe("the block, as it is saved", () => {
  const ask = (who: "me" | "author" | "none"): StepBlock => ({ type: "assign", ask: true, who });
  test("the plan carries where the question starts and fixes nobody", () => {
    const p = planOf("merge", { enabled: true, statusNames: [], assign: { who: "none" }, blocks: [{ type: "move", statusNames: ["done"] }, ask("author")] });
    expect(p.askAssign).toEqual({ who: "author" });
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
    expect(body).toContain("if (askStatus || askAssign) { await runAsked(); return; }");
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
