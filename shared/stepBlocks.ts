/*
 * The blocks a ClickUp step is built from.
 *
 * A step is WHERE it shows (a button on a pull request, an item in the review
 * menu, a choice in the merge dialog) plus a list of blocks the person adds,
 * removes and reorders: move the card, take people off it, assign it. The list
 * is the whole of what the step does, so nothing is preconfigured by code per
 * place: a place only says which blocks it can take.
 *
 * Stored beside the three keys it replaced (`statusNames`, `unassign`, `assign`),
 * which stay readable and stay in step with the blocks. A file from before
 * blocks has no list, so the list is read from those keys: the move first, then
 * the take-off, then the assign, the order the step always ran in.
 *
 * Order is how the step reads. It is sent to the tracker as one write whatever
 * the order, because a take-off never removes the person an assign just ensured
 * (see web/src/lib/stepAssign.ts), so the result is the same either way.
 * Ceiling: one block of each kind per step; a second move or a second assign has
 * no meaning yet, and the registry below says so rather than the screen.
 */
import type { HandoffUnassign, StepAssign, StepBlock } from "./providers.ts";

/** Where a step shows: the hand-off button, the review menu's item, the merge dialog's choice. */
export type StepTrigger = "move" | "menu" | "merge";
export type BlockType = StepBlock["type"];

export const NO_ASSIGN: StepAssign = { who: "none" };

/** What the block list can hold, for the screen, the docs and an agent. `built` false is a kind the list is open for. */
export const BLOCK_INFO: readonly { type: string; name: string; blurb: string; built: boolean }[] = [
  { type: "move", name: "Move the card", blurb: "Send the card to one of your statuses.", built: true },
  { type: "unassign", name: "Take people off the card", blurb: "Unassign nobody, only you, or everyone.", built: true },
  { type: "assign", name: "Assign the card", blurb: "Make sure you, the author, or a person ends up on it.", built: true },
  { type: "comment", name: "Comment on the card", blurb: "Write a note on the card.", built: false },
  { type: "field", name: "Set a field", blurb: "Fill a field on the card.", built: false },
];
export const BLOCK_TYPES: readonly BlockType[] = ["move", "unassign", "assign"];
/** Kept small so a settings file is never a form that grows without bound. */
export const MAX_BLOCKS = 8;

/** The places a block can go. Taking people off needs the hand-off button, as it always did. */
const ONLY_ON: Partial<Record<BlockType, readonly StepTrigger[]>> = { unassign: ["move"] };
const WHERE: Record<StepTrigger, string> = { move: "a button on a pull request", menu: "a review menu item", merge: "the merge dialog" };
const CAN: Record<StepTrigger, string> = { move: "move, take people off or assign", menu: "move or assign", merge: "preselect a move or assign" };

/** Why a block cannot be added to a step, or null when it can. `type` may be a kind the list is only open for. */
export function blockRefusal(trigger: StepTrigger, blocks: readonly StepBlock[], type: string): string | null {
  const info = BLOCK_INFO.find((b) => b.type === type);
  if (!info) return `“${type}” is not a block.`;
  if (!info.built) return "Not built yet. The list is open for it.";
  if (blocks.some((b) => b.type === type)) return "Already in this step. Remove it to add it again.";
  const only = ONLY_ON[type as BlockType];
  if (only && !only.includes(trigger)) return `Not on ${WHERE[trigger]}: it can only ${CAN[trigger]}.`;
  return null;
}

/** What is wrong with a whole list, or null. The one rule the screen's disabled rows and the server's refusal share. */
export function blocksProblem(trigger: StepTrigger, blocks: readonly StepBlock[]): string | null {
  if (blocks.length > MAX_BLOCKS) return `has more than ${MAX_BLOCKS} blocks`;
  for (let i = 0; i < blocks.length; i++) {
    const why = blockRefusal(trigger, blocks.slice(0, i), blocks[i]!.type);
    if (why) return `block ${i + 1} (${blocks[i]!.type}): ${why}`;
  }
  return null;
}

/** The three keys a step used to be, which the blocks are read from and written back to. */
export interface LegacyStep { enabled: boolean; statusNames: string[]; unassign?: HandoffUnassign; assign: StepAssign }

/**
 * A file from before blocks: the move, then the take-off, then the assign. `enabled`
 * is not read: it says whether the step exists, and a step that is off keeps what
 * it had chosen, as it always did, so turning it on again finds it.
 */
export function blocksFromLegacy(trigger: StepTrigger, g: LegacyStep): StepBlock[] {
  const out: StepBlock[] = [];
  /* The merge choice with no names is "Leave it there": no move to show. The others with no names ran the built-in guess. */
  if (g.statusNames.length || trigger !== "merge") out.push({ type: "move", statusNames: [...g.statusNames], ...(g.statusNames.length ? null : { fallback: true }) });
  if (trigger === "move" && g.unassign && g.unassign !== "none") out.push({ type: "unassign", who: g.unassign });
  const as = g.assign ?? NO_ASSIGN; /* a file from before the row existed has none */
  if (as.who !== "none") out.push({ type: "assign", ...as });
  return out;
}

/** The three keys the blocks mean, so an older reader of the file still sees the same step. */
export function legacyFromBlocks(blocks: readonly StepBlock[]): { statusNames: string[]; unassign: HandoffUnassign; assign: StepAssign } {
  const mv = blocks.find((b): b is Extract<StepBlock, { type: "move" }> => b.type === "move");
  const un = blocks.find((b): b is Extract<StepBlock, { type: "unassign" }> => b.type === "unassign");
  const as = blocks.find((b): b is Extract<StepBlock, { type: "assign" }> => b.type === "assign");
  const assign: StepAssign = as ? (as.who === "person" && as.person ? { who: "person", person: as.person } : { who: as.who }) : NO_ASSIGN;
  return { statusNames: mv ? [...mv.statusNames] : [], unassign: un?.who ?? "none", assign };
}

/** The step's blocks: its own list, or the one its old keys mean. */
export const blocksOf = (trigger: StepTrigger, g: LegacyStep & { blocks?: StepBlock[] }): StepBlock[] => g.blocks ?? blocksFromLegacy(trigger, g);

/** What a step does, flattened for the places that run it. */
export interface StepPlan {
  /** Null: no move block, so the card's status is left where it is. */
  move: { names: string[]; fallback: boolean } | null;
  unassign: HandoffUnassign;
  assign: StepAssign;
}
export function planOf(trigger: StepTrigger, g: LegacyStep & { blocks?: StepBlock[] }): StepPlan {
  const blocks = blocksOf(trigger, g);
  const mv = blocks.find((b): b is Extract<StepBlock, { type: "move" }> => b.type === "move");
  const l = legacyFromBlocks(blocks);
  return { move: mv ? { names: [...mv.statusNames], fallback: mv.fallback === true } : null, unassign: l.unassign, assign: l.assign };
}

/** A move the step has chosen, or is allowed to guess: false while the person still has to pick one. */
export const moveChosen = (p: StepPlan): boolean => !!p.move && (p.move.names.length > 0 || p.move.fallback);
/** Does pressing the step change anything about the people? */
export const touchesPeople = (p: StepPlan): boolean => p.unassign !== "none" || p.assign.who !== "none";
