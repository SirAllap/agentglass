/*
 * A step is a place plus blocks the person adds, removes and reorders.
 *
 * What is pinned here is what has consequences: which blocks a place may take
 * (the screen greys the rest and the server refuses them), that the order is
 * the order the sentence reads in, that a file from before blocks reads as the
 * same step and writes back as the same keys, and that however many blocks a
 * step has it is still ONE write to the tracker.
 */
import { describe, expect, test } from "bun:test";
import type { StepBlock } from "../../shared/providers.ts";
import { BLOCK_INFO, blockRefusal, blocksFromLegacy, blocksOf, blocksProblem, legacyFromBlocks, MAX_BLOCKS, planOf, touchesPeople, type StepTrigger } from "../../shared/stepBlocks.ts";
import { blocksSentence, moveBlock, peopleButtonLabel } from "../src/lib/stepBlocksView.ts";
import { stepChanges, resolveEnsure } from "../src/lib/stepAssign.ts";
import { clickupSteps } from "../src/lib/clickupWorkflow.ts";
import { movesNothing, needsStatus, isActive, moments } from "../src/lib/workflowMap.ts";
import { CLICKUP } from "../src/lib/clickupWorkflow.ts";
import { readyForQaStatus } from "../src/lib/cardMove.ts";
import type { ClickUpPrefs } from "../../shared/providers.ts";

const move = (...names: string[]): StepBlock => ({ type: "move", statusNames: names });
const off = (who: "none" | "me" | "all"): StepBlock => ({ type: "unassign", who });
const assign = (who: "me" | "author"): StepBlock => ({ type: "assign", who });

describe("which blocks a place can take", () => {
  test("move and assign go anywhere; taking people off needs the button, as it always did", () => {
    for (const t of ["move", "menu", "merge"] as StepTrigger[]) {
      expect(blockRefusal(t, [], "move")).toBeNull();
      expect(blockRefusal(t, [], "assign")).toBeNull();
    }
    expect(blockRefusal("move", [], "unassign")).toBeNull();
    expect(blockRefusal("menu", [], "unassign")).toMatch(/review menu item/);
    expect(blockRefusal("merge", [], "unassign")).toMatch(/merge dialog/);
  });
  test("one of each kind: a second is refused with the way out", () => {
    expect(blockRefusal("move", [move("qa")], "move")).toMatch(/Already in this step. Remove it/);
    expect(blockRefusal("move", [assign("me")], "assign")).toMatch(/Already in this step/);
  });
  test("the kinds the list is only open for are listed, and refused, until they are built", () => {
    const later = BLOCK_INFO.filter((b) => !b.built).map((b) => b.type);
    expect(later.length).toBeGreaterThan(0);
    for (const t of later) expect(blockRefusal("move", [], t)).toMatch(/Not built yet/);
    expect(blockRefusal("move", [], "teleport")).toMatch(/not a block/);
  });
  test("a whole list is judged block by block, so the first bad one is named", () => {
    expect(blocksProblem("move", [move("qa"), off("all"), assign("me")])).toBeNull();
    expect(blocksProblem("menu", [move("qa"), off("all")])).toMatch(/^block 2 \(unassign\)/);
    expect(blocksProblem("move", [assign("me"), assign("author")])).toMatch(/^block 2 \(assign\)/);
    expect(blocksProblem("move", Array(MAX_BLOCKS + 1).fill(move("a")))).toMatch(/more than/);
  });
});

describe("the order is the sentence", () => {
  const say = (trigger: StepTrigger, blocks: StepBlock[], status: string | null = "ready for qa") => blocksSentence({ lead: "Press it:", trigger, blocks, item: "card", status });
  test("the same blocks read in the order they are in", () => {
    expect(say("move", [move("ready for qa"), off("all"), assign("me")])).toBe("Press it: move the card to ready for qa, take everyone off the card, then assign it to you.");
    expect(say("move", [assign("me"), off("all"), move("ready for qa")])).toBe("Press it: assign it to you, take everyone off the card, then move the card to ready for qa.");
  });
  test("one block is one clause; none says so, and the merge dialog with none preselects nothing", () => {
    expect(say("move", [off("me")])).toBe("Press it: take only you off the card.");
    expect(say("move", [])).toBe("Press it: nothing happens yet. Add a block.");
    expect(say("merge", [])).toBe("Press it: nothing is preselected.");
  });
  test("a step with no move block still reads, and a move waiting for a status says so", () => {
    expect(say("menu", [assign("author")], null)).toBe("Press it: assign it to the pull request’s author.");
    expect(say("move", [move()], null)).toBe("Press it: move the card to (pick a status).");
    expect(say("merge", [move("done")], "done")).toBe("Press it: preselect done.");
  });
  test("moveBlock is what both arrow keys and a drop do; out of range changes nothing", () => {
    expect(moveBlock(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveBlock(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(moveBlock(["a", "b", "c"], 1, 1)).toEqual(["a", "b", "c"]);
    expect(moveBlock(["a", "b", "c"], 0, 3)).toEqual(["a", "b", "c"]);
    expect(moveBlock(["a", "b", "c"], -1, 0)).toEqual(["a", "b", "c"]);
  });
});

describe("a file from before blocks is the same step", () => {
  const legacy = (over: Record<string, unknown>) => ({ enabled: true, statusNames: [] as string[], unassign: "none" as const, assign: { who: "none" as const }, ...over });
  test("move, then take-off, then assign: the order the step always ran in; no-ops are not blocks", () => {
    expect(blocksFromLegacy("move", legacy({ statusNames: ["qa"], unassign: "all", assign: { who: "me" } }))).toEqual([move("qa"), off("all"), assign("me")]);
    expect(blocksFromLegacy("move", legacy({ statusNames: ["qa"] }))).toEqual([move("qa")]);
  });
  test("a step with no names was the built-in guess, and stays so; the merge choice with none was Leave it there", () => {
    expect(blocksFromLegacy("move", legacy({}))).toEqual([{ type: "move", statusNames: [], fallback: true }]);
    expect(blocksFromLegacy("merge", legacy({}))).toEqual([]);
  });
  test("a step that is off keeps what it had chosen, so turning it on finds it", () => {
    expect(blocksFromLegacy("move", legacy({ enabled: false, statusNames: ["qa"], unassign: "me" }))).toEqual([move("qa"), off("me")]);
  });
  test("round trip: blocks to the three keys and back lose nothing, for every combination the page can build", () => {
    const person = { who: "person" as const, person: { id: 7, name: "Sam Rivera" } };
    for (const names of [[], ["qa"], ["qa", "testing"]]) for (const un of ["none", "me", "all"] as const) for (const as of [{ who: "none" as const }, { who: "me" as const }, person]) {
      const g = legacy({ statusNames: names, unassign: un, assign: as });
      const blocks = blocksFromLegacy("move", g);
      const back = legacyFromBlocks(blocks);
      expect(back).toEqual({ statusNames: names, unassign: un, assign: as });
      expect(blocksFromLegacy("move", { ...g, ...back })).toEqual(blocks);
    }
  });
  test("a settings object with no blocks key is read through its old keys; one with blocks is read as written", () => {
    expect(blocksOf("move", legacy({ statusNames: ["qa"] }))).toEqual([move("qa")]);
    expect(blocksOf("move", { ...legacy({ statusNames: ["qa"] }), blocks: [assign("me")] })).toEqual([assign("me")]);
    expect(planOf("move", { ...legacy({}), blocks: [assign("me")] }).move).toBeNull();
  });
  test("the map reads a legacy workspace as steps with blocks and the fields the lines use", () => {
    const p = { handoff: legacy({ statusNames: ["Ready for QA"], unassign: "all" }), review: legacy({ statusNames: ["code review"] }), merge: legacy({ statusNames: ["done"] }), flows: { noteOnCard: false } } as unknown as ClickUpPrefs;
    const s = clickupSteps(p);
    expect(s.map((x) => x.kind)).toEqual(["move", "menu", "merge"]);
    expect(s[0]).toMatchObject({ status: "Ready for QA", unassign: "all", blocks: [move("Ready for QA"), off("all")] });
  });
});

describe("a step with no move block", () => {
  const step = (blocks: StepBlock[]) => clickupSteps({ handoff: { enabled: true, statusNames: [], unassign: "none", assign: { who: "none" }, blocks }, review: { enabled: false }, merge: { enabled: false }, flows: { noteOnCard: false } } as unknown as ClickUpPrefs)[0]!;
  const m = moments(CLICKUP.nouns);
  test("is valid: it needs no status, is active, and the button finds no status to move to", () => {
    const s = step([assign("me")]);
    expect(movesNothing(s)).toBe(true);
    expect(needsStatus(s, m.move)).toBe(false);
    expect(isActive(s, m.move)).toBe(true);
    expect(readyForQaStatus([{ status: "ready for qa", type: "custom", orderindex: 1 }], "in progress", { enabled: true, statusNames: [], unassign: "none", assign: { who: "me" }, blocks: [assign("me")] })).toBeUndefined();
  });
  test("an empty step is not active, and a move still waiting for a status needs one and moves nothing", () => {
    expect(isActive(step([]), m.move)).toBe(false);
    const w = step([move()]);
    expect(needsStatus(w, m.move)).toBe(true);
    expect(readyForQaStatus([{ status: "ready for qa", type: "custom", orderindex: 1 }], "in progress", { enabled: true, statusNames: [], unassign: "none", assign: { who: "none" }, blocks: [move()] })).toBeUndefined();
  });
  test("the button says what it does to the people", () => {
    expect(peopleButtonLabel(planOf("move", { enabled: true, statusNames: [], assign: { who: "none" }, blocks: [assign("me")] }))).toBe("Assign to me");
    expect(peopleButtonLabel(planOf("move", { enabled: true, statusNames: [], assign: { who: "none" }, blocks: [off("all")] }))).toBe("Take everyone off");
    expect(touchesPeople(planOf("move", { enabled: true, statusNames: [], assign: { who: "none" }, blocks: [move("qa")] }))).toBe(false);
  });
});

describe("however many blocks, one write", () => {
  const people = [{ id: 1, me: true, name: "Me" }, { id: 2, name: "Sam Rivera" }];
  const orders = (xs: StepBlock[]): StepBlock[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => orders([...xs.slice(0, i), ...xs.slice(i + 1)]).map((r) => [x, ...r])));
  test("every order of the same blocks makes the same single write", () => {
    const blocks = [move("qa"), off("all"), assign("me")];
    const writes = orders(blocks).map((o) => { const p = planOf("move", { enabled: true, statusNames: [], assign: { who: "none" }, blocks: o }); return stepChanges({ ...(p.move ? { status: "qa" } : null), people, unassign: p.unassign, ensure: resolveEnsure(p.assign, {}) }).write; });
    expect(writes.length).toBe(6);
    for (const w of writes) expect(w).toEqual(writes[0]!);
    expect(writes[0]).toEqual({ status: "qa", rem: [2] });
  });
  test("no move block: the write has no status; no block changes anything: it has nothing at all", () => {
    expect(stepChanges({ people, unassign: "none", ensure: { kind: "person", id: 3, name: "Priya Nair" } }).write).toEqual({ add: [3] });
    expect(stepChanges({ people, unassign: "all", ensure: { kind: "none" } }).write).toEqual({ rem: [1, 2] });
    expect(stepChanges({ people, unassign: "none", ensure: { kind: "none" } }).write).toEqual({});
  });
  test("the button and the review menu make a single card write each, however the step is built", async () => {
    const src = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url).pathname).text();
    const at = src.indexOf("function CardReadyForQaButton(");
    const body = src.slice(at, src.indexOf("\nfunction ", at + 10));
    expect(body.match(/api\.clickupCard\(/g)?.length).toBe(1);
  });
});
