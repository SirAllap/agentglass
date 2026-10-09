/*
 * ClickUp's side of the workflow map: how its saved settings read as steps, and
 * what saving a change to a step sends.
 *
 * The settings were here before the map was: the QA hand-off, the review menu,
 * the merge choice, the reviewer list and the note are five keys of
 * `ClickUpPrefs`. A person who already had them set opens the map and finds them
 * as steps; nothing is migrated on disk, because nothing needs to be.
 */
import type { ClickUpPrefs, StepBlock } from "../../../shared/providers.ts";
import { blocksOf, planOf, type StepTrigger } from "../../../shared/stepBlocks.ts";
import type { TrackerAdapter, Step, StepKind } from "./workflowMap.ts";
import { STEP_ORDER } from "./workflowMap.ts";
import { NO_ASSIGN } from "./stepAssign.ts";

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

/** The steps built from blocks, and the settings group each one is saved in. */
const GROUP = { move: "handoff", menu: "review", merge: "merge" } as const;

/** A step with blocks, read once into the fields the lines, pins and coverage use. */
function blockStep(kind: StepTrigger, g: ClickUpPrefs["handoff"] | ClickUpPrefs["review"] | ClickUpPrefs["merge"]): Step {
  const plan = planOf(kind, g);
  const names = plan.move?.names ?? [];
  return { kind, status: names[0] ?? null, also: names.slice(1), unassign: plan.unassign, assign: plan.assign, blocks: blocksOf(kind, g), implicit: plan.move?.fallback === true };
}

/** The steps this workspace has, in the order the map lists them. */
export function clickupSteps(p: ClickUpPrefs): Step[] {
  const out: Step[] = [];
  if (p.handoff.enabled) out.push(blockStep("move", p.handoff));
  if (p.review.enabled) out.push(blockStep("menu", p.review));
  if (p.merge.enabled) out.push(blockStep("merge", p.merge));
  if (p.review.assignReviewer) out.push({ kind: "people", status: null, also: [], unassign: "none", assign: NO_ASSIGN });
  if (p.flows.noteOnCard) out.push({ kind: "note", status: null, also: [], unassign: "none", assign: NO_ASSIGN });
  return out;
}

/** Add a step. The ones built from blocks start empty: nothing is chosen for the person. */
export function clickupAdd(kind: StepKind): PrefsPatch {
  switch (kind) {
    case "move": case "menu": case "merge": return { [GROUP[kind]]: { enabled: true, blocks: [] } };
    case "people": return { review: { assignReviewer: true } };
    case "note": return { flows: { noteOnCard: true } };
  }
}

/** Replace a step's blocks, in the order given. */
export const clickupBlocks = (kind: StepTrigger, blocks: StepBlock[]): PrefsPatch => ({ [GROUP[kind]]: { blocks } });

/** Take a step away, and whatever it had chosen with it. */
export function clickupRemove(kind: StepKind): PrefsPatch {
  switch (kind) {
    case "move": case "menu": case "merge": return { [GROUP[kind]]: { enabled: false, blocks: [] } };
    case "people": return { review: { assignReviewer: false } };
    case "note": return { flows: { noteOnCard: false } };
  }
}

/**
 * Does adding this step also switch changes on? Only the first one, and only
 * while they are off: someone who turned them off with steps in place has said
 * something, and a second step must not undo it.
 */
export const addTurnsWritesOn = (writesOn: boolean, stepCount: number): boolean => !writesOn && stepCount === 0;
