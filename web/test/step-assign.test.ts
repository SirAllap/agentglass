/*
 * "Also assign": a step that moves a card also makes sure somebody ends up on it.
 *
 * The decision is pure, so it is asserted here for every choice against every
 * take-off setting and the author who cannot be told from the members; then the
 * saved shape (a step saved before the row existed reads as "leave as is"), the
 * words the map and the preview use, and the places that press it: one write
 * for the card, and a member read only when the choice is the author.
 * People are invented (Ada Test, Sam Rivera); nothing here reaches a tracker.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ClickUpPrefs, ListMember } from "../../shared/providers.ts";
import { WorkflowMap } from "../src/components/WorkflowMap.tsx";
import { CLICKUP, clickupRemove, clickupSteps } from "../src/lib/clickupWorkflow.ts";
import { partitionUnits } from "../src/lib/workflowLayout.ts";
import type { MapSpace } from "../src/lib/workflowMap.ts";
import {
  assignLabel, assignWords, authorMember, ensureId, pressSentence, resolveEnsure, stepChanges, type Assign, type Ensure,
} from "../src/lib/stepAssign.ts";

const member = (id: number, name: string, extra: Partial<ListMember> = {}): ListMember => ({ id, name, initials: name.slice(0, 2), ...extra });
const MEMBERS: ListMember[] = [
  member(1, "Ada Test", { email: "ada@orbit.example", me: true }),
  member(2, "Sam Rivera", { email: "sam@orbit.example" }),
  member(3, "Zoë Okafor"),
  member(4, "Lee Wong"), member(5, "lee  wong"),
  member(6, "Kim One", { email: "shared@orbit.example" }), member(7, "Kim Two", { email: "shared@orbit.example" }),
];

describe("which member the pull request's author is", () => {
  test("the public email is the strongest evidence", () => {
    expect(authorMember({ login: "ada-t", email: "Ada@Orbit.example" }, MEMBERS)?.id).toBe(1);
  });
  test("else the full profile name, whatever its case, spacing or accents", () => {
    expect(authorMember({ login: "zokafor", name: "ZOE OKAFOR" }, MEMBERS)?.id).toBe(3);
    expect(authorMember({ login: "sr", name: "sam   rivera" }, MEMBERS)?.id).toBe(2);
  });
  test("a login, a single word or a partial name is not evidence", () => {
    expect(authorMember({ login: "sam" }, MEMBERS)).toBeNull();
    expect(authorMember({ login: "x", name: "Sam" }, MEMBERS)).toBeNull();
    expect(authorMember({ login: "x", name: "Sam Riv" }, MEMBERS)).toBeNull();
  });
  test("two members who match are nobody, not the first of them", () => {
    expect(authorMember({ login: "lw", name: "Lee Wong" }, MEMBERS)).toBeNull();
  });
  test("an email two members share is nobody, even when the name would have been unique", () => {
    expect(authorMember({ login: "x", email: "shared@orbit.example", name: "Sam Rivera" }, MEMBERS)).toBeNull();
  });
  test("a wrong email does not fall through to a lucky name; no members is nobody", () => {
    expect(authorMember({ login: "x", email: "nobody@orbit.example", name: "Sam Rivera" }, MEMBERS)?.id).toBe(2);
    expect(authorMember({ login: "x", name: "Sam Rivera" }, [])).toBeNull();
    expect(authorMember({ login: "x", name: "Sam Rivera" }, null)).toBeNull();
    expect(authorMember(null, MEMBERS)).toBeNull();
  });
});

describe("who the choice means", () => {
  test("leave as is, me and a named person need no lookup", () => {
    expect(resolveEnsure({ who: "none" }, {})).toEqual({ kind: "none" });
    expect(resolveEnsure(undefined, {})).toEqual({ kind: "none" });
    expect(resolveEnsure({ who: "me" }, {})).toEqual({ kind: "me" });
    expect(resolveEnsure({ who: "person", person: { id: 2, name: "Sam Rivera" } }, {})).toEqual({ kind: "person", id: 2, name: "Sam Rivera" });
  });
  test("the author is the member they map to", () => {
    expect(resolveEnsure({ who: "author" }, { author: { login: "sr", name: "Sam Rivera" }, members: MEMBERS })).toEqual({ kind: "person", id: 2, name: "Sam Rivera" });
  });
  test("an author who cannot be told says so and assigns nobody", () => {
    const e = resolveEnsure({ who: "author" }, { author: { login: "octo-bot" }, members: MEMBERS });
    expect(e.kind).toBe("unmapped");
    expect((e as { why: string }).why).toBe("No ClickUp member matches “octo-bot”, so nobody was assigned.");
    expect(resolveEnsure({ who: "author" }, { author: { login: "sr", name: "Sam Rivera" }, members: null }).kind).toBe("unmapped");
  });
  test("for a form that already holds the members, the id is read without a request", () => {
    expect(ensureId({ kind: "me" }, MEMBERS)).toBe(1);
    expect(ensureId({ kind: "me" }, null)).toBeNull();
    expect(ensureId({ kind: "person", id: 9, name: "x" }, null)).toBe(9);
    expect(ensureId({ kind: "unmapped", why: "x" }, MEMBERS)).toBeNull();
  });
});

describe("what the one write carries", () => {
  const on = [{ id: 1, me: true }, { id: 2 }, { id: 4 }];
  const sam: Ensure = { kind: "person", id: 2, name: "Sam Rivera" };
  const lee: Ensure = { kind: "person", id: 6, name: "Lee Park" };
  const final = (people: { id?: number }[], w: { add?: number[]; rem?: number[] }) =>
    [...new Set([...people.map((p) => p.id!).filter((id) => !(w.rem ?? []).includes(id)), ...(w.add ?? [])])].sort();

  test("leave as is is the write it always was", () => {
    expect(stepChanges({ status: "qa", people: on, unassign: "none", ensure: { kind: "none" } }).write).toEqual({ status: "qa" });
    expect(stepChanges({ status: "qa", people: on, unassign: "all", ensure: { kind: "none" } }).write).toEqual({ status: "qa", rem: [1, 2, 4] });
    expect(stepChanges({ status: "qa", people: on, unassign: "me", ensure: { kind: "none" } }).write).toEqual({ status: "qa", rem: [1] });
  });
  test("a person who is missing is added and the others stay", () => {
    const r = stepChanges({ status: "qa", people: on, unassign: "none", ensure: lee });
    expect(r.write).toEqual({ status: "qa", add: [6] });
    expect(r.named).toBe("Lee Park");
  });
  test("take off everyone, then ensure: the ensured person is the only one left", () => {
    expect(stepChanges({ status: "qa", people: on, unassign: "all", ensure: lee }).write).toEqual({ status: "qa", add: [6], rem: [1, 2, 4] });
  });
  test("never removes the person just ensured, whoever the take-off names", () => {
    const all = stepChanges({ status: "qa", people: on, unassign: "all", ensure: sam });
    expect(all.write).toEqual({ status: "qa", rem: [1, 4] });
    expect(all.named).toBeNull();
    expect(all.stays).toBe(true);
    expect(stepChanges({ status: "qa", people: on, unassign: "me", ensure: { kind: "me" } }).write).toEqual({ status: "qa" });
  });
  test("me, when not on the card, is added by the server from the connected account", () => {
    const r = stepChanges({ status: "qa", people: [{ id: 2 }], unassign: "me", ensure: { kind: "me" } });
    expect(r.write).toEqual({ status: "qa", addMe: true });
    expect(r.named).toBe("you");
  });
  test("an author who could not be mapped adds nobody and still does the rest", () => {
    const e: Ensure = { kind: "unmapped", why: "x" };
    expect(stepChanges({ status: "qa", people: on, unassign: "none", ensure: e }).write).toEqual({ status: "qa" });
    expect(stepChanges({ status: "qa", people: on, unassign: "all", ensure: e }).write).toEqual({ status: "qa", rem: [1, 2, 4] });
  });
  test("every choice against every take-off against every card: the ensured person is always left on it", () => {
    const cards = [[], [{ id: 1, me: true }], [{ id: 2 }], on, [{ id: 6 }]];
    for (const people of cards) for (const unassign of ["none", "me", "all"] as const) {
      for (const [ensure, id] of [[sam, 2], [lee, 6]] as const) {
        const { write } = stepChanges({ status: "qa", people, unassign, ensure });
        expect(final(people, write), JSON.stringify({ people, unassign, id })).toContain(id);
        expect(write.rem ?? []).not.toContain(id);
        if (people.some((p) => p.id === id)) expect(write.add).toBeUndefined();
      }
      const me = stepChanges({ status: "qa", people, unassign, ensure: { kind: "me" } });
      const mine = people.find((p) => "me" in p && p.me);
      if (mine) expect(me.write.rem ?? []).not.toContain(mine.id!); else expect(me.write.addMe).toBe(true);
    }
  });
});

describe("the words", () => {
  test("the control says what it does", () => {
    expect(assignLabel({ who: "none" })).toBe("leave as is");
    expect(assignLabel({ who: "me" })).toBe("me — whoever presses it");
    expect(assignLabel({ who: "author" })).toBe("the pull request’s author");
    expect(assignLabel({ who: "person", person: { id: 2, name: "Sam Rivera" } })).toBe("Sam Rivera");
    expect(assignWords({ who: "none" })).toBeNull();
  });
  test("the press sentence says exactly what will happen", () => {
    const a: Assign = { who: "author" };
    expect(pressSentence({ lead: "Press it:", status: "ready for deployment", item: "card", assign: a })).toBe("Press it: moves the card to ready for deployment and assigns the pull request’s author.");
    expect(pressSentence({ lead: "Press it:", status: "qa", item: "card", unassign: "all", assign: { who: "me" } })).toBe("Press it: moves the card to qa, takes everyone off and assigns whoever presses it.");
    expect(pressSentence({ lead: "Press it:", status: "qa", item: "card", unassign: "me", assign: { who: "none" } })).toBe("Press it: moves the card to qa and takes only you off.");
    expect(pressSentence({ lead: "Press it:", status: "qa", item: "card", assign: { who: "person", person: { id: 2, name: "Sam Rivera" } } })).toBe("Press it: moves the card to qa and assigns Sam Rivera.");
    expect(pressSentence({ lead: "Confirm the merge:", status: null, item: "card" })).toBe("Confirm the merge: leaves the card where it is.");
  });
});

describe("what is saved", () => {
  const base = (over: Partial<ClickUpPrefs>) => ({
    handoff: { enabled: false, statusNames: [], unassign: "none" }, review: { enabled: false, statusNames: [], assignReviewer: false },
    merge: { enabled: false, statusNames: [] }, flows: { noteOnCard: false }, ...over,
  }) as unknown as ClickUpPrefs;
  test("a step saved before the row existed leaves everyone as they are", () => {
    const steps = clickupSteps(base({
      handoff: { enabled: true, statusNames: ["qa"], unassign: "all" }, review: { enabled: true, statusNames: ["review"], assignReviewer: true },
      merge: { enabled: true, statusNames: ["done"] }, flows: { noteOnCard: true },
    } as never));
    expect(steps.map((s) => s.assign)).toEqual(Array(5).fill({ who: "none" }));
  });
  test("a step carries what was saved on it, and only the steps that move a status", () => {
    const pick = { who: "person", person: { id: 2, name: "Sam Rivera" } } as const;
    const steps = clickupSteps(base({
      handoff: { enabled: true, statusNames: ["qa"], unassign: "none", assign: { who: "me" } }, review: { enabled: true, statusNames: ["review"], assignReviewer: false, assign: { who: "author" } },
      merge: { enabled: true, statusNames: ["done"], assign: pick },
    } as never));
    expect(steps.map((s) => [s.kind, s.assign.who])).toEqual([["move", "me"], ["menu", "author"], ["merge", "person"]]);
  });
  test("removing a step takes its assignment with it", () => {
    for (const k of ["move", "menu", "merge"] as const) {
      const patch = clickupRemove(k) as Record<string, { blocks?: unknown[] }>;
      expect(Object.values(patch)[0]!.blocks).toEqual([]);
    }
  });
});

describe("the map", () => {
  const st = (status: string, type = "custom") => ({ status, type });
  const SPACES: MapSpace[] = [{ id: "1", name: "Engineering", statuses: [st("to do", "open"), st("code review"), st("ready for deployment"), st("done", "done")] }];
  const draw = (p: unknown) => renderToStaticMarkup(React.createElement(WorkflowMap, {
    adapter: CLICKUP, part: partitionUnits(SPACES), panel: { kind: "ok" }, steps: clickupSteps(p as ClickUpPrefs), changesOn: true,
    onAdd: () => {}, onBlocks: () => {}, onRemove: () => {}, onRetry: () => {},
  })).replace(/<style>[\s\S]*?<\/style>/g, "");
  const p = {
    handoff: { enabled: true, statusNames: ["ready for deployment"], unassign: "all", assign: { who: "author" } },
    review: { enabled: true, statusNames: ["code review"], assignReviewer: true, assign: { who: "none" } },
    merge: { enabled: true, statusNames: ["done"], assign: { who: "person", person: { id: 2, name: "Sam Rivera" } } },
    flows: { noteOnCard: true },
  };
  const html = draw(p);
  const card = (kind: string) => html.slice(html.indexOf(`data-step="${kind}"`), html.indexOf("</article>", html.indexOf(`data-step="${kind}"`)));
  test("each step built from blocks shows its assign block as a row, and the ones without blocks have none", () => {
    for (const k of ["move", "merge"]) expect(card(k)).toMatch(/data-blk="assign"[^]*?class="wfm-pick"/);
    expect(card("menu")).not.toContain('data-blk="assign"');
    for (const k of ["people", "note"]) expect(card(k)).not.toContain("data-blk=");
  });
  test("the row says the saved choice, and an unassigned step has no assign row at all", () => {
    expect(card("move")).toContain(">the pull request’s author<");
    expect(card("merge")).toContain(">Sam Rivera<");
  });
  test("the sentence reads what will happen, in the order of the blocks", () => {
    expect(card("move")).toContain("Press it: move the card to ready for deployment, take everyone off the card, then assign it to the pull request’s author.");
    expect(card("menu")).toContain("Pick it: move the card to code review.");
    expect(card("merge")).toContain("Confirm the merge: preselect done, then assign it to Sam Rivera.");
  });
  test("a step still waiting for a status says so in its sentence and its badge", () => {
    const h = draw({ ...p, handoff: { ...p.handoff, blocks: [{ type: "move", statusNames: [] }] } });
    expect(h).toContain("Needs a status");
    expect(h).toContain("move the card to (pick a status).");
  });
});

describe("the places that press it", () => {
  const read = (f: string) => Bun.file(new URL(`../src/${f}`, import.meta.url).pathname).text();
  const fn = (src: string, head: string) => {
    const at = src.indexOf(head);
    expect(at).toBeGreaterThan(-1);
    const next = src.indexOf("\nfunction ", at + head.length);
    return src.slice(at, next < 0 ? undefined : next);
  };
  const code = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("/*") && !l.trim().startsWith("//")).join("\n");

  test("the hand-off button writes once, and reads the team only for the author", async () => {
    const body = code(fn(await read("components/PrPanel.tsx"), "function CardReadyForQaButton("));
    expect(body.match(/api\.clickupCard\(/g)?.length).toBe(1);
    expect(body.match(/api\.clickupMembers\(/g)?.length).toBe(1);
    expect(body).toContain('plan.assign.who === "author"');
  });
  test("the merge dialog reads the team only for the author, and sends the person in the card's own write", async () => {
    const dialog = code(await read("components/MergeDialog.tsx"));
    expect(dialog.match(/api\.clickupMembers\(/g)?.length).toBe(1);
    expect(dialog).toContain('mergeAssign?.who === "author"');
    const panel = await read("components/PrPanel.tsx");
    const run = panel.slice(panel.indexOf("const runMerge = async"), panel.indexOf("const doAutoMerge"));
    expect(run).toContain("move.write ? api.clickupCard(move.id, move.write, move.updated) : api.clickupStatus(move.id, move.to, move.updated)");
    expect(run.match(/api\.clickup(Card|Status)\(/g)?.length).toBe(2);
  });
  test("the assignment rides on the move: with no move, the dialog sends no card at all", async () => {
    const dialog = await read("components/MergeDialog.tsx");
    expect(dialog).toContain("card: on && moves");
    expect(dialog).toContain("const plan = moves ? stepChanges(");
  });
  test("the review menu adds nobody when the status is left where it is", async () => {
    const panel = await read("components/PrPanel.tsx");
    expect(panel).toContain("const ensured = stepOn && (!moveOn || movesStatus) ? ensureId(ensure, members) : null;");
  });
});
