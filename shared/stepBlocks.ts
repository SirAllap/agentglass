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
  { type: "comment", name: "Comment on the card", blurb: "Post a note on the card. {pr}, {pr_url}, {author}, {status} and {me} are filled in.", built: true },
  { type: "field", name: "Set a field", blurb: "Fill one of the card's custom fields.", built: true },
];
export const BLOCK_TYPES: readonly BlockType[] = ["move", "unassign", "assign", "comment", "field"];

/** The longest a comment template, a field's name and a field's value may be: a settings file is not a document. */
export const MAX_COMMENT = 2000;
export const MAX_FIELD_NAME = 200;
export const MAX_FIELD_VALUE = 500;

/** What a comment template may name. Filled in where the step runs, from what that place knows. */
export const PLACEHOLDERS = ["pr", "pr_url", "author", "status", "me"] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];
export const PLACEHOLDER_HELP: Record<Placeholder, string> = {
  pr: "the pull request, as “#318 Retry the webhook”",
  pr_url: "its address",
  author: "who wrote it",
  status: "the status the card is in once the step has run",
  me: "the connected account",
};

/**
 * A template with its placeholders filled in. A placeholder this place cannot fill stays as written and is
 * listed in `missing`, so the screen can say so and the step does not post “{author}” onto somebody's board.
 */
export function fillTemplate(text: string, ctx: Partial<Record<Placeholder, string>>): { text: string; missing: Placeholder[] } {
  const missing: Placeholder[] = [];
  const out = text.replace(/\{([a-z_]+)\}/g, (whole, name: string) => {
    if (!(PLACEHOLDERS as readonly string[]).includes(name)) return whole;
    const v = ctx[name as Placeholder];
    if (v === undefined || v === "") { if (!missing.includes(name as Placeholder)) missing.push(name as Placeholder); return whole; }
    return v;
  });
  return { text: out, missing };
}
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
  /* "The pull request's author" asked a GitHub login to be a ClickUp member; it is asked of the person now. */
  if (as.who === "author") out.push({ type: "assign", ask: true, who: "none" });
  else if (as.who !== "none") out.push({ type: "assign", ...as });
  return out;
}

/** The three keys the blocks mean, so an older reader of the file still sees the same step. */
export function legacyFromBlocks(blocks: readonly StepBlock[]): { statusNames: string[]; unassign: HandoffUnassign; assign: StepAssign } {
  const mv = blocks.find((b): b is Extract<StepBlock, { type: "move" }> => b.type === "move");
  const un = blocks.find((b): b is Extract<StepBlock, { type: "unassign" }> => b.type === "unassign");
  const as = blocks.find((b): b is Extract<StepBlock, { type: "assign" }> => b.type === "assign");
  /* A block that asks when it runs fixes nobody: an older reader of the file sees no assignment, not a guess. */
  const assign: StepAssign = as && !as.ask ? (as.who === "person" && as.person ? { who: "person", person: as.person } : { who: as.who }) : NO_ASSIGN;
  /* What an older reader can hold: none, me or all. Named people, and a question asked when it runs, are not in the old keys. */
  const unassign: HandoffUnassign = un && !un.ask && un.who !== "people" ? un.who : "none";
  return { statusNames: mv ? [...mv.statusNames] : [], unassign, assign };
}

/** The step's blocks: its own list, or the one its old keys mean. */
export const blocksOf = (trigger: StepTrigger, g: LegacyStep & { blocks?: StepBlock[] }): StepBlock[] => g.blocks ?? blocksFromLegacy(trigger, g);

/** What a step does, flattened for the places that run it. */
export interface StepPlan {
  /** Null: no move block, so the card's status is left where it is. `ask`: the person picks it when it runs, starting at `names`. */
  move: { names: string[]; fallback: boolean; ask: boolean } | null;
  unassign: HandoffUnassign;
  /** Who is fixed on the card. `none` when the assign block asks: see `askAssign`. */
  assign: StepAssign;
  /** The assign block asks when it runs; this is where its picker starts. Null when it does not ask, or there is no block. */
  askAssign: (StepAssign & { also?: { id: number; name: string }[] }) | null;
  /** Named people the step takes off the card (a fixed choice). */
  takeOff: { id: number; name: string }[];
  /** The take-off asks when it runs: where its picker starts (`people` for named people). */
  askUnassign: { who: HandoffUnassign | "people"; people: { id: number; name: string }[] } | null;
  /** Comment on the card: the template, and whether the person edits it when it runs. */
  comment: { text: string; ask: boolean } | null;
  /** Set a field: which, to what, and whether the value is asked when it runs. */
  field: { field: string; value: string; ask: boolean } | null;
}
export function planOf(trigger: StepTrigger, g: LegacyStep & { blocks?: StepBlock[] }): StepPlan {
  const blocks = blocksOf(trigger, g);
  const mv = blocks.find((b): b is Extract<StepBlock, { type: "move" }> => b.type === "move");
  const l = legacyFromBlocks(blocks);
  const as = blocks.find((b): b is Extract<StepBlock, { type: "assign" }> => b.type === "assign");
  const askAssign: StepPlan["askAssign"] = as?.ask ? (as.who === "person" && as.person ? { who: "person", person: as.person, ...(as.also?.length ? { also: as.also } : null) } : { who: as.who }) : null;
  const un = blocks.find((b): b is Extract<StepBlock, { type: "unassign" }> => b.type === "unassign");
  const cm = blocks.find((b): b is Extract<StepBlock, { type: "comment" }> => b.type === "comment");
  const fd = blocks.find((b): b is Extract<StepBlock, { type: "field" }> => b.type === "field");
  return {
    move: mv ? { names: [...mv.statusNames], fallback: mv.fallback === true, ask: mv.ask === true } : null, unassign: l.unassign, assign: l.assign, askAssign,
    takeOff: un && !un.ask && un.who === "people" ? [...(un.people ?? [])] : [],
    askUnassign: un?.ask ? { who: un.who, people: [...(un.people ?? [])] } : null,
    comment: cm ? { text: cm.text, ask: cm.ask === true } : null,
    field: fd ? { field: fd.field, value: fd.value, ask: fd.ask === true } : null,
  };
}

/** A move the step has chosen, or is allowed to guess: false while the person still has to pick one. */
export const moveChosen = (p: StepPlan): boolean => !!p.move && (p.move.names.length > 0 || p.move.fallback);
/** Does pressing the step change anything about the people? */
/** Does the step post a comment or set a field? Each is a request of its own: the card's status and people are one write, these are not part of it. */
export const hasExtras = (p: StepPlan): boolean => p.comment !== null || p.field !== null;
export const touchesPeople = (p: StepPlan): boolean => p.unassign !== "none" || p.assign.who !== "none" || p.askAssign !== null || p.takeOff.length > 0 || p.askUnassign !== null;
