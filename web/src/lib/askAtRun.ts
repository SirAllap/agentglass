/*
 * A block that asks when it runs: who the picker offers, in what order, and where it starts.
 *
 * Merging a colleague's pull request as a favour must not put the card on the person who merged
 * it, and a fixed "assign me" in Settings cannot know which merge this is. So the block can ask:
 * the setting is where the picker starts, and the person chooses at the moment of acting.
 *
 * The order is the question's own order. Who the pull request is FROM comes first, when the
 * tracker's members can say who that is with confidence (see authorMember: public email, else a
 * full name that matches one member); then who is already on the card; then the person pressing;
 * then everybody else, by name. Each person is listed once, with every reason that applies.
 * "Nobody" is a choice of its own, not a row.
 *
 * Ceiling: the people are the list's members the server already holds, so a person who is on the
 * workspace but not on that list is not offered. That is the same set "Assign" has always named.
 */
import type { ListMember, StepAssign } from "../../../shared/providers.ts";
import { authorMember, type Ensure, type PrAuthor } from "./stepAssign.ts";

export type AskTag = "pull request author" | "on the card" | "you";
export interface AskRow { member: ListMember; tags: AskTag[] }
export interface AskModel {
  rows: AskRow[];
  /** The pull request has an author the members could not be matched to: said once, so nobody wonders why they are missing. */
  authorUnmapped: string | null;
}

/** What the picker holds: nobody, the person pressing (before the members are known), or one member. */
export type Picked = { kind: "nobody" } | { kind: "me" } | { kind: "person"; id: number; name: string };

export function askModel(o: {
  members: readonly ListMember[] | null | undefined;
  author?: PrAuthor | null;
  onCard?: readonly { id?: number | null }[];
}): AskModel {
  const members = o.members ?? [];
  const author = o.author && members.length ? authorMember(o.author, members) : null;
  const onCard = new Set((o.onCard ?? []).map((p) => p.id).filter((n): n is number => n != null));
  /* The order the question asks in: the author, who is on the card (in the card's order), the person pressing, everybody else by name. */
  const ids: number[] = [];
  const put = (id: number | null | undefined) => { if (id != null && members.some((m) => m.id === id) && !ids.includes(id)) ids.push(id); };
  put(author?.id);
  for (const p of o.onCard ?? []) put(p.id);
  for (const m of members) if (m.me) put(m.id);
  for (const m of [...members].sort((x, y) => x.name.localeCompare(y.name))) put(m.id);
  const rows = ids.map((id) => {
    const member = members.find((m) => m.id === id)!;
    const tags: AskTag[] = [];
    if (author?.id === id) tags.push("pull request author");
    if (onCard.has(id)) tags.push("on the card");
    if (member.me) tags.push("you");
    return { member, tags };
  });
  return { rows, authorUnmapped: o.author?.login && members.length && !author ? o.author.login : null };
}

/** Where the picker starts, from the setting: the block's own value, or the person pressing when none is set. */
export function startingPick(start: StepAssign | undefined, o: { members: readonly ListMember[] | null | undefined; author?: PrAuthor | null }): { pick: Picked; note?: string } {
  const s: StepAssign = start ?? { who: "me" };
  switch (s.who) {
    case "none": return { pick: { kind: "nobody" } };
    case "person": return s.person ? { pick: { kind: "person", id: s.person.id, name: s.person.name } } : { pick: { kind: "nobody" } };
    case "author": {
      const m = o.members?.length ? authorMember(o.author, o.members) : null;
      if (m) return { pick: { kind: "person", id: m.id, name: m.name } };
      return { pick: { kind: "nobody" }, note: `No ${"ClickUp"} member matches ${o.author?.login ? `“${o.author.login}”` : "the author"}, so it starts at nobody.` };
    }
    default: {
      const me = o.members?.find((m) => m.me);
      return { pick: me ? { kind: "person", id: me.id, name: me.name } : { kind: "me" } };
    }
  }
}

/** The tracker-side meaning of a pick, in the form the one write already takes. */
export function pickToEnsure(p: Picked): Ensure {
  return p.kind === "nobody" ? { kind: "none" } : p.kind === "me" ? { kind: "me" } : { kind: "person", id: p.id, name: p.name };
}

export const pickName = (p: Picked): string => (p.kind === "nobody" ? "nobody" : p.kind === "me" ? "you" : p.name);

/** The rows a search keeps: name or email contains it, case aside. */
export function filterAsk(rows: readonly AskRow[], q: string): AskRow[] {
  const n = q.trim().toLowerCase();
  return n ? rows.filter((r) => r.member.name.toLowerCase().includes(n) || (r.member.email ?? "").toLowerCase().includes(n)) : [...rows];
}
