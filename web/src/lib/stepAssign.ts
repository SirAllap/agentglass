/*
 * "Also assign": a step that moves a card can also make sure somebody ends up on it.
 *
 * The decisions live here, away from the screens that press the controls, because
 * they are the part that writes to somebody's board: who is meant, whether the
 * author can be told from the people the tracker knows, and what the one write
 * carries when a take-off and an assignment meet.
 *
 * Ensured, not replaced. The person is added when missing; everybody else stays
 * unless the step's own "take off" row says otherwise, and that row never takes
 * off the person this one just ensured (take off first, then ensure, so the
 * result is the same as if the order were the other way round).
 *
 * Who the pull request's author is in the tracker: nothing in the app linked a
 * GitHub login to a tracker member before this, and a login says nothing about a
 * person. The only evidence GitHub gives is the profile's public email and its
 * name, so the author is the one member whose email is that email, else the one
 * member whose full name (two words or more) is that name, accents and case
 * aside. Zero or two matches is "nobody", and the press says so rather than guess.
 * Ceiling: a profile with a nickname and no public email is not mapped; the
 * "a person…" choice is the way out.
 */
import type { HandoffUnassign, ListMember } from "../../../shared/providers.ts";
import { handoffRemovals } from "./cardMove.ts";

export type AssignWho = "none" | "me" | "author" | "person";
export interface Assign { who: AssignWho; person?: { id: number; name: string } }
export const NO_ASSIGN: Assign = { who: "none" };

export const ASSIGN_LABEL: Record<AssignWho, string> = {
  none: "leave as is",
  me: "me — whoever presses it",
  author: "the pull request’s author",
  person: "a person…",
};
export const ASSIGN_WHO: readonly AssignWho[] = ["none", "me", "author", "person"];

/** What the control row's button says: the person's own name once one is chosen. */
export const assignLabel = (a: Assign): string => (a.who === "person" && a.person ? a.person.name : ASSIGN_LABEL[a.who]);

export interface PrAuthor { login: string; name?: string; email?: string }
type Person = { id?: number | null; me?: boolean; name?: string };

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();

/** The one member this author is, or null. See the file's note for why it is this strict. */
export function authorMember(author: PrAuthor | null | undefined, members: readonly ListMember[] | null | undefined): ListMember | null {
  if (!author || !members?.length) return null;
  const email = author.email?.trim().toLowerCase();
  if (email) {
    const hit = members.filter((m) => m.email?.trim().toLowerCase() === email);
    if (hit.length === 1) return hit[0]!;
    if (hit.length > 1) return null;
  }
  const name = fold(author.name ?? "");
  if (name.split(" ").length < 2) return null;
  const hit = members.filter((m) => fold(m.name) === name);
  return hit.length === 1 ? hit[0]! : null;
}

/** Who the step means, once the people it needs to look at are known. */
export type Ensure =
  | { kind: "none" }
  | { kind: "me" }
  | { kind: "person"; id: number; name: string }
  | { kind: "unmapped"; why: string };

export function resolveEnsure(
  assign: Assign | undefined,
  o: { author?: PrAuthor | null; members?: readonly ListMember[] | null; tracker?: string },
): Ensure {
  switch (assign?.who) {
    case "me": return { kind: "me" };
    case "person": return assign.person ? { kind: "person", id: assign.person.id, name: assign.person.name } : { kind: "none" };
    case "author": {
      const m = authorMember(o.author, o.members);
      if (m) return { kind: "person", id: m.id, name: m.name };
      const who = o.author?.login ? `“${o.author.login}”` : "the author";
      return { kind: "unmapped", why: `No ${o.tracker ?? "ClickUp"} member matches ${who}, so nobody was assigned.` };
    }
    default: return { kind: "none" };
  }
}

export interface CardWrite { status?: string; add?: number[]; rem?: number[]; addMe?: boolean }

/**
 * The one write: the status (when the step moves one), who comes off, who goes on. `named` is the name to
 * say afterwards ("you" for the account that pressed); null when nobody is added.
 */
export function stepChanges(o: {
  /** Absent for a step with no move block: the card stays where it is and only its people change. */
  status?: string;
  people: readonly Person[] | undefined;
  unassign: HandoffUnassign;
  ensure: Ensure;
}): { write: CardWrite; named: string | null; stays: boolean } {
  const people = o.people ?? [];
  let rem = handoffRemovals([...people] as { id?: number | null; me?: boolean }[], o.unassign);
  const write: CardWrite = o.status ? { status: o.status } : {};
  let named: string | null = null;
  let stays = false;
  const e = o.ensure;
  if (e.kind === "me") {
    const mine = people.find((p) => p.me && p.id != null);
    if (mine) { rem = rem.filter((id) => id !== mine.id); stays = true; }
    else { write.addMe = true; named = "you"; }
  } else if (e.kind === "person") {
    rem = rem.filter((id) => id !== e.id);
    if (people.some((p) => p.id === e.id)) stays = true;
    else { write.add = [e.id]; named = e.name; }
  }
  if (rem.length) write.rem = rem;
  return { write, named, stays };
}

/** Who "also assign" means, in a sentence; null when it assigns nobody. */
export function assignWords(a: Assign | undefined): string | null {
  if (!a || a.who === "none") return null;
  return a.who === "me" ? "whoever presses it" : a.who === "author" ? "the pull request’s author" : (a.person?.name ?? "a person");
}

/** The words a step's saved choices make, for the map's "Press it:" line. */
export function pressSentence(o: {
  lead: string; status: string | null; item: string; unassign?: HandoffUnassign; assign?: Assign;
}): string {
  const parts: string[] = [];
  if (o.status) parts.push(`moves the ${o.item} to ${o.status}`);
  else parts.push(`leaves the ${o.item} where it is`);
  if (o.unassign === "all") parts.push("takes everyone off");
  else if (o.unassign === "me") parts.push("takes only you off");
  const who = assignWords(o.assign);
  if (who) parts.push(`assigns ${who}`);
  const body = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0]!;
  return `${o.lead} ${body}.`;
}

/** What the press said it did about the assignment, for the line after it. */
export const assignedNote = (named: string | null): string => (named ? ` · assigned ${named}` : "");

/** The tracker id an ensure means, for a form that already holds the members (no request). */
export function ensureId(e: Ensure, members: readonly ListMember[] | null | undefined): number | null {
  if (e.kind === "person") return e.id;
  if (e.kind === "me") return members?.find((m) => m.me)?.id ?? null;
  return null;
}

/** The pull request's author as this module reads it. */
export const authorOf = (d: { author?: string; authorName?: string; authorEmail?: string } | null | undefined): PrAuthor | null =>
  d?.author ? { login: d.author, ...(d.authorName ? { name: d.authorName } : null), ...(d.authorEmail ? { email: d.authorEmail } : null) } : null;
