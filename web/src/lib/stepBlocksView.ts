/*
 * A step's blocks as the screens read them: which still need a value, what the
 * list says in words, and the edits the map makes to a list. The rules about
 * what a block is and where it can go are in shared/stepBlocks.ts, where the
 * server reads them too.
 */
import type { StepBlock, HandoffUnassign } from "../../../shared/providers.ts";
import { blockRefusal, type StepTrigger } from "../../../shared/stepBlocks.ts";
import type { StepKind } from "./workflowMap.ts";
import { assignWords } from "./stepAssign.ts";
import { pickSentence } from "./askAtRun.ts";

/** The places that take blocks. The note and the assigned list are single controls and have none. */
export const triggerOf = (k: StepKind): StepTrigger | null => (k === "move" || k === "menu" || k === "merge" ? k : null);

/** A move that names nothing and is not the built-in guess is waiting for a status. The merge choice may name none: "Leave it there". */
export const blockNeedsValue = (trigger: StepTrigger, b: StepBlock): boolean =>
  b.type === "move" && trigger !== "merge" && b.statusNames.length === 0 && !b.fallback;

/** A step with nothing in it does nothing; the merge dialog's choice is still drawn, with nothing preselected. */
export const stepIsEmpty = (trigger: StepTrigger, blocks: readonly StepBlock[]): boolean => trigger !== "merge" && blocks.length === 0;

export const UNASSIGN_WORDS: Record<HandoffUnassign, string> = { none: "leave the assignees alone", me: "take only you off", all: "take everyone off" };

/** One block in the sentence. `status` is the move block's status once the built-in guess is resolved. */
export function blockClause(trigger: StepTrigger, b: StepBlock, o: { item: string; status: string | null }): string {
  if (b.type === "move") {
    if (b.ask) return `ask which status to move the ${o.item} to, starting at ${o.status ?? (trigger === "merge" ? "“Leave it there”" : "(pick a status)")}`;
    if (trigger === "merge") return o.status ? `preselect ${o.status}` : "preselect nothing (“Leave it there”)";
    return `move the ${o.item} to ${o.status ?? "(pick a status)"}`;
  }
  if (b.type === "unassign") {
    const who = b.who === "people" ? ((b.people ?? []).length ? `take ${pickSentence((b.people ?? []).map((x) => ({ kind: "person" as const, id: x.id, name: x.name })))} off the ${o.item}` : `take nobody off the ${o.item}`) : b.who === "none" ? UNASSIGN_WORDS.none : `${UNASSIGN_WORDS[b.who]} the ${o.item}`;
    return b.ask ? `ask who to take off the ${o.item}, starting with: ${who.replace(/^take /, "").replace(` off the ${o.item}`, "")}` : who;
  }
  const w = assignWords(b);
  const who = b.who === "person" && b.also?.length ? pickSentence([b.person!, ...b.also].map((x) => ({ kind: "person" as const, id: x.id, name: x.name }))) : w === "whoever presses it" ? "you" : (w ?? "nobody");
  return b.ask ? `ask who to assign it to, starting at ${who}` : `assign it to ${who}`;
}

/** "Press it: move the card to X, take everyone off the card, then assign it to you." The order of the blocks is the order of the words. */
export function blocksSentence(o: { lead: string; trigger: StepTrigger; blocks: readonly StepBlock[]; item: string; status: string | null }): string {
  const parts = o.blocks.map((b) => blockClause(o.trigger, b, o));
  if (!parts.length) return o.trigger === "merge" ? `${o.lead} nothing is preselected.` : `${o.lead} nothing happens yet. Add a block.`;
  const body = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")}, then ${parts[parts.length - 1]}`;
  return `${o.lead} ${body}.`;
}

/** The blocks a step can still take, each with the reason it cannot (null when it can). */
export const addChoices = (trigger: StepTrigger, blocks: readonly StepBlock[], types: readonly string[]): { type: string; why: string | null }[] =>
  types.map((type) => ({ type, why: blockRefusal(trigger, blocks, type) }));

/** The list with one block moved: arrow keys and a drop both land here. Out of range leaves the list alone. */
export function moveBlock<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return [...list];
  const out = [...list];
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x!);
  return out;
}

/** What a button with no move block says, from what it does to the people. */
export function peopleButtonLabel(plan: { unassign: HandoffUnassign; assign: { who: string; person?: { name: string } } }): string {
  const a = plan.assign;
  if (a.who === "me") return "Assign to me";
  if (a.who === "author") return "Assign to the author";
  if (a.who === "person") return `Assign to ${a.person?.name ?? "a person"}`;
  return plan.unassign === "all" ? "Take everyone off" : "Take me off";
}
