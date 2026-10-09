/*
 * The card's Assignees row, decided away from the screen.
 *
 * Who is on a card is what a team plans its week around, and a change notifies
 * the people it names. So the sheet stages a set of changes, says them in one
 * line, and writes them once when the button is pressed: the line and the
 * button are the confirmation, with no dialog on top of them. These are the
 * rules the screen only draws:
 *
 *   - what the row says, and who may open the sheet;
 *   - who the sheet lists, and in which order (you first);
 *   - what is staged, what the footer says about it, and what the button says;
 *   - what a refused write means, and what "Undo" sends back.
 *
 * People are compared by ClickUp's id, never by name: a board can hold two
 * people with the same name, and a picker that toggled by name would one day
 * remove the wrong one.
 *
 * The smaller thing this cannot do: an assignee without an id (a card the
 * server could not resolve people for) is shown on the row and cannot be
 * staged, because nothing could be sent for them.
 */
import type { ProviderTask } from "../../../shared/providers.ts";
import type { DeviceScope } from "../../../shared/types.ts";
import { ago, fieldAccess, type StatusAccess } from "./cardStatus.ts";

/** Somebody who may be put on a card. `email` is drawn when the server sends it. */
export interface Person {
  id: number;
  name: string;
  initials: string;
  color?: string;
  avatar?: string;
  email?: string;
  me?: boolean;
}

export interface Diff { add: number[]; rem: number[] }

type CardPeople = NonNullable<ProviderTask["people"]>;

/** May this phone edit assignees? Needs a list to read the members of, too. */
export function assigneeAccess(
  scope: DeviceScope | null | undefined, writeEnabled: boolean | null | undefined, list: string | null | undefined,
): StatusAccess {
  const a = fieldAccess(scope, writeEnabled, "edit assignees");
  return a.can && !list ? { can: false, why: null } : a;
}

/** What the row says: "ada (you), bob", you first, or who the board names when it gave no ids. */
export function assigneeLine(card: Pick<ProviderTask, "people" | "assignees">): string {
  if (card.people?.length) {
    return [...card.people]
      .sort((a, b) => Number(!!b.me) - Number(!!a.me))
      .map((p) => (p.me ? `${p.name} (you)` : p.name))
      .join(", ");
  }
  return card.assignees.length ? card.assignees.join(", ") : "Nobody";
}

/** The ids on the card that can be staged. */
export function currentIds(people: CardPeople | undefined): number[] {
  return (people ?? []).flatMap((p) => (p.id == null ? [] : [p.id]));
}

/** Who is on the card as one comparable value: a refreshed card with the same people is the same key. */
export const peopleKey = (people: CardPeople | undefined): string => currentIds(people).join(",");

/**
 * Who the sheet lists: the list's members, you first, then anybody already on
 * the card the list did not name (so they can still be taken off), narrowed by
 * what was typed into the search. Name and email both match.
 */
export function assigneeOptions(members: readonly Person[], current: CardPeople | undefined, query: string): Person[] {
  const seen = new Set(members.map((m) => m.id));
  const extra: Person[] = (current ?? []).flatMap((p) => (p.id == null || seen.has(p.id) ? [] : [{ ...p, id: p.id }]));
  const q = query.trim().toLowerCase();
  return [...members, ...extra]
    .filter((p) => !q || p.name.toLowerCase().includes(q) || (p.email ?? "").toLowerCase().includes(q))
    .sort((a, b) => Number(!!b.me) - Number(!!a.me));
}

/** What the picked set changes against what the card has. */
export function stagedDiff(current: readonly number[], picked: readonly number[]): Diff {
  return {
    add: picked.filter((id) => !current.includes(id)),
    rem: current.filter((id) => !picked.includes(id)),
  };
}

export const isEmpty = (d: Diff): boolean => !d.add.length && !d.rem.length;

/** The tag on a row: what pressing Apply would do for this person. */
export function rowTag(id: number, current: readonly number[], picked: readonly number[]): "Add" | "Remove" | null {
  const was = current.includes(id), is = picked.includes(id);
  return was === is ? null : is ? "Add" : "Remove";
}

/** The footer button. */
export function applyLabel(d: Diff): { label: string; enabled: boolean } {
  const n = d.add.length + d.rem.length;
  return n ? { label: `Apply ${n} change${n === 1 ? "" : "s"}`, enabled: true } : { label: "Nothing to apply", enabled: false };
}

/** The footer's line, in pieces the screen can colour: ["+ cy", "− bob"]. */
export function summaryParts(d: Diff, nameOf: (id: number) => string): string[] {
  return [
    d.add.length ? `+ ${d.add.map(nameOf).join(", ")}` : "",
    d.rem.length ? `− ${d.rem.map(nameOf).join(", ")}` : "",
  ].filter(Boolean);
}

/** The same line as one string: "+ cy − bob", and empty when nothing is staged. */
export const summaryText = (d: Diff, nameOf: (id: number) => string): string => summaryParts(d, nameOf).join(" ");

/** Somebody's name from whoever the screen knows, never an id in a sentence. */
export function nameIn(known: readonly { id?: number; name: string }[], id: number): string {
  return known.find((p) => p.id === id)?.name ?? "someone";
}

/** The same change, as a dialog says it: "add cy and remove bob". */
function sentence(d: Diff, nameOf: (id: number) => string): string {
  const list = (ids: number[]): string => ids.map(nameOf).join(", ");
  return [d.add.length ? `add ${list(d.add)}` : "", d.rem.length ? `remove ${list(d.rem)}` : ""].filter(Boolean).join(" and ");
}

/** What the change would still do to a card as somebody else left it. */
export function remaining(d: Diff, theirs: readonly number[]): Diff {
  return { add: d.add.filter((id) => !theirs.includes(id)), rem: d.rem.filter((id) => theirs.includes(id)) };
}

/**
 * What a write actually changed, for "Undo" to reverse. After a refusal and an
 * "Apply anyway" the card was re-read, so the people a colleague already added
 * are not this write's doing and Undo must not remove them. `theirs` is the
 * card as it was before the write; a write with no re-read changed what it asked.
 */
export function appliedDiff(asked: Diff, theirs: CardPeople | undefined): Diff {
  return theirs ? remaining(asked, currentIds(theirs)) : asked;
}

export interface AssigneeConflict { text: string; keep: string; overwrite: string | null }

/**
 * What to say when the card changed between opening it and applying.
 *
 * `theirs` is the card re-read after the refusal. A change that already leaves
 * the card as wanted (somebody added cy first) has nothing left to overwrite,
 * so only "keep" is offered; any other change is named a change, not guessed
 * to be about assignees.
 */
export function assigneeConflict(a: { theirs: ProviderTask; diff: Diff; nameOf: (id: number) => string; now: number }): AssigneeConflict {
  const when = ago(a.theirs.updated, a.now);
  const left = remaining(a.diff, currentIds(a.theirs.people));
  if (isEmpty(left)) {
    return { text: `Somebody already made this change ${when}.`, keep: "Keep theirs", overwrite: null };
  }
  return {
    text: `Somebody changed this card ${when}. Applying now would ${sentence(left, a.nameOf)}.`,
    keep: "Keep theirs",
    overwrite: "Apply anyway",
  };
}

/**
 * Where "Undo" sends the card: the opposite of what was applied, but only for
 * the people still as the change left them. Somebody who was taken off again
 * by a colleague is not put back over that.
 */
export function undoDiff(applied: Diff | null, now: readonly number[]): Diff | null {
  if (!applied) return null;
  const back: Diff = { add: applied.rem.filter((id) => !now.includes(id)), rem: applied.add.filter((id) => now.includes(id)) };
  return isEmpty(back) ? null : back;
}
