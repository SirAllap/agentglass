/*
 * ClickUp's side of the workflow map: how its saved settings read as steps, and
 * what saving a change to a step sends.
 *
 * The settings were here before the map was: the QA hand-off, the review menu,
 * the merge choice, the reviewer list and the note are five keys of
 * `ClickUpPrefs`. A person who already had them set opens the map and finds them
 * as steps; nothing is migrated on disk, because nothing needs to be.
 */
import type { ClickUpPrefs } from "../../../shared/providers.ts";
import type { TrackerAdapter, Step, StepKind, Unassign } from "./workflowMap.ts";
import { STEP_ORDER } from "./workflowMap.ts";
import { NO_ASSIGN, type Assign } from "./stepAssign.ts";

export const CLICKUP: TrackerAdapter = {
  nouns: { name: "ClickUp", workspace: "workspace", space: "space", spaces: "spaces", list: "list", lists: "lists", item: "card", items: "cards", move: "Move to", verb: "Move" },
  kinds: STEP_ORDER,
  suggest: { move: /qa|test/i, menu: /review/i, merge: /^(done|complete|completed|released|approved|closed)$/i },
  fallback: {
    /* What readyForQaStatus does with no names: the one status called "ready for qa", whatever its case. */
    move: (all) => all.find((s) => s.name.trim().toLowerCase() === "ready for qa")?.name ?? "Ready for QA",
    /* What reviewStatus does with no names: an open status with "review" in it. */
    menu: (all) => all.find((s) => s.type !== "done" && s.type !== "closed" && /review/i.test(s.name))?.name ?? null,
  },
  sample: { id: "ORBIT-1042", title: "Retry the webhook when the queue is full", status: "code review", who: "Ada Test", others: "Sam Rivera" },
};

/** A settings patch, in the shape the server's save takes. */
export type PrefsPatch = {
  handoff?: Partial<ClickUpPrefs["handoff"]>;
  review?: Partial<ClickUpPrefs["review"]>;
  merge?: Partial<ClickUpPrefs["merge"]>;
  flows?: Partial<ClickUpPrefs["flows"]>;
  statusSpaces?: Partial<ClickUpPrefs["statusSpaces"]>;
};

const named = (names: string[]) => ({ status: names[0] ?? null, also: names.slice(1), implicit: names.length === 0 });

/** The steps this workspace has, in the order the map lists them. */
export function clickupSteps(p: ClickUpPrefs): Step[] {
  const out: Step[] = [];
  const un = p.handoff.unassign;
  if (p.handoff.enabled) out.push({ kind: "move", ...named(p.handoff.statusNames), unassign: un, assign: p.handoff.assign ?? NO_ASSIGN });
  if (p.review.enabled) out.push({ kind: "menu", ...named(p.review.statusNames), unassign: "none", assign: p.review.assign ?? NO_ASSIGN });
  if (p.merge.enabled) out.push({ kind: "merge", status: p.merge.statusNames[0] ?? null, also: p.merge.statusNames.slice(1), unassign: "none", assign: p.merge.assign ?? NO_ASSIGN });
  if (p.review.assignReviewer) out.push({ kind: "people", status: null, also: [], unassign: "none", assign: NO_ASSIGN });
  if (p.flows.noteOnCard) out.push({ kind: "note", status: null, also: [], unassign: "none", assign: NO_ASSIGN });
  return out;
}

const list = (status: string | null) => (status ? [status] : []);

/** Add a step. A status is what a picker handed back; null for the ones without. */
export function clickupAdd(kind: StepKind, status: string | null): PrefsPatch {
  switch (kind) {
    case "move": return { handoff: { enabled: true, statusNames: list(status), unassign: "none" } };
    case "menu": return { review: { enabled: true, statusNames: list(status) } };
    case "merge": return { merge: { enabled: true, statusNames: list(status) } };
    case "people": return { review: { assignReviewer: true } };
    case "note": return { flows: { noteOnCard: true } };
  }
}

/** Point a step at another status; any further names it also tried are dropped,
 *  because the picker chose one and the line says one. */
export function clickupSetStatus(kind: StepKind, status: string | null): PrefsPatch {
  switch (kind) {
    case "move": return { handoff: { statusNames: list(status) } };
    case "menu": return { review: { statusNames: list(status) } };
    case "merge": return { merge: { statusNames: list(status) } };
    default: return {};
  }
}

/** Take a step away, and whatever it had chosen with it. */
export function clickupRemove(kind: StepKind): PrefsPatch {
  switch (kind) {
    case "move": return { handoff: { enabled: false, statusNames: [], unassign: "none", assign: NO_ASSIGN } };
    case "menu": return { review: { enabled: false, statusNames: [], assign: NO_ASSIGN } };
    case "merge": return { merge: { enabled: false, statusNames: [], assign: NO_ASSIGN } };
    case "people": return { review: { assignReviewer: false } };
    case "note": return { flows: { noteOnCard: false } };
  }
}

/** Set a step's "also assign". The row exists on the steps that move a status, and only on those. */
export function clickupAssign(kind: StepKind, a: Assign): PrefsPatch {
  switch (kind) {
    case "move": return { handoff: { assign: a } };
    case "menu": return { review: { assign: a } };
    case "merge": return { merge: { assign: a } };
    default: return {};
  }
}

export const clickupUnassign = (v: Unassign): PrefsPatch => ({ handoff: { unassign: v } });

/**
 * Does adding this step also switch changes on? Only the first one, and only
 * while they are off: someone who turned them off with steps in place has said
 * something, and a second step must not undo it.
 */
export const addTurnsWritesOn = (writesOn: boolean, stepCount: number): boolean => !writesOn && stepCount === 0;
