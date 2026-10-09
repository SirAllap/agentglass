/*
 * A block that asks when it runs: who the picker offers, in what order, and where it starts.
 *
 * Merging a colleague's pull request as a favour must not put the card on the person who merged
 * it, and a fixed "assign me" in Settings cannot know which merge this is. So the block can ask:
 * the setting is where the picker starts, and the person chooses at the moment of acting.
 *
 * The order is the question's own order: who is already on the card, then the person pressing, then
 * everybody else, by name. (A tracker whose accounts are GitHub's, see AUTHOR_IS_MEMBER, would put
 * the pull request's author first; ClickUp's are a different system and nothing is guessed.) Each person is listed once, with every reason that applies.
 * "Nobody" is a choice of its own, not a row.
 *
 * Ceiling: the people are the list's members the server already holds, so a person who is on the
 * workspace but not on that list is not offered. That is the same set "Assign" has always named.
 */
import type { ListMember, StepAssign } from "../../../shared/providers.ts";
import { authorMember, type Ensure, type PrAuthor } from "./stepAssign.ts";
import { orderMembers } from "./peopleOrder.ts";

export interface AskRow { member: ListMember; /** On the card now: the first group, as everywhere else people are picked. */ onCard: boolean }
export interface AskModel { rows: AskRow[] }

/** One person the question has settled on: the person pressing (before the members are known), or one member. */
export type PickedPerson = { kind: "me" } | { kind: "person"; id: number; name: string };
/** Everybody the question has settled on. Empty is nobody. */
export type Picked = PickedPerson[];

export function askModel(o: {
  members: readonly ListMember[] | null | undefined;
  author?: PrAuthor | null;
  onCard?: readonly { id?: number | null }[];
  /** The tracker's accounts are GitHub's (see AUTHOR_IS_MEMBER). False for ClickUp: nobody is guessed from the pull request. */
  authorIsMember?: boolean;
}): AskModel {
  const members = o.members ?? [];
  const onCard = new Set((o.onCard ?? []).map((p) => p.id).filter((n): n is number => n != null));
  /* The app's one ordering (lib/peopleOrder, the card's Assigned picker): who is on the card, then you, then everyone by name. */
  const rows = orderMembers([...members], onCard).map((member) => ({ member, onCard: onCard.has(member.id) }));
  /* A tracker that shares identity with GitHub would lift the pull request's author to the top. */
  const author = o.authorIsMember && o.author && members.length ? authorMember(o.author, members) : null;
  if (author) { const i = rows.findIndex((r) => r.member.id === author.id); if (i > 0) rows.unshift(...rows.splice(i, 1)); }
  return { rows };
}

/**
 * Where the picker starts, from the setting: the block's own people, or the person pressing when none is set.
 * "The pull request's author" is only a choice on a tracker whose accounts are GitHub's (AUTHOR_IS_MEMBER);
 * for ClickUp it is never offered and a saved one has been migrated to "ask, starting at nobody". The case
 * stays so a tracker that shares identity can use it.
 */
export function startingPick(start: (StepAssign & { also?: { id: number; name: string }[] }) | undefined, o: { members: readonly ListMember[] | null | undefined; author?: PrAuthor | null; authorIsMember?: boolean }): { pick: Picked } {
  const s = start ?? { who: "me" as const };
  switch (s.who) {
    case "none": return { pick: [] };
    case "person": return { pick: s.person ? [{ kind: "person", id: s.person.id, name: s.person.name }, ...(s.also ?? []).map((p) => ({ kind: "person" as const, id: p.id, name: p.name }))] : [] };
    case "author": {
      const m = o.authorIsMember && o.members?.length ? authorMember(o.author, o.members) : null;
      return { pick: m ? [{ kind: "person", id: m.id, name: m.name }] : [] };
    }
    default: {
      const me = o.members?.find((m) => m.me);
      return { pick: [me ? { kind: "person", id: me.id, name: me.name } : { kind: "me" }] };
    }
  }
}

/** Where the take-off picker starts, from the setting, among the people who are on the card now. */
export function startingTakeOff(start: { who: "none" | "me" | "all" | "people"; people?: { id: number; name: string }[] } | undefined, o: { cardPeople: readonly ListMember[] }): Picked {
  const asPicked = (m: ListMember): PickedPerson => ({ kind: "person", id: m.id, name: m.name });
  switch (start?.who) {
    case "all": return o.cardPeople.map(asPicked);
    case "me": return o.cardPeople.filter((m) => m.me).map(asPicked);
    case "people": return (start.people ?? []).filter((p) => o.cardPeople.some((m) => m.id === p.id)).map((p) => ({ kind: "person" as const, id: p.id, name: p.name }));
    default: return [];
  }
}

/** The member ids a pick means, for a write that names people (the take-off). */
export const pickedIds = (p: Picked, members: readonly ListMember[] | null | undefined): number[] =>
  p.flatMap((x) => (x.kind === "me" ? (members?.find((m) => m.me)?.id ?? []) : [x.id]));

/** The tracker-side meaning of a pick, in the form the one write already takes. */
export function pickToEnsure(p: Picked): Ensure {
  if (!p.length) return { kind: "none" };
  const one = (x: PickedPerson) => (x.kind === "me" ? { kind: "me" as const } : { kind: "person" as const, id: x.id, name: x.name });
  return p.length === 1 ? one(p[0]!) : { kind: "many", list: p.map(one) };
}

/** Is this member among the picked? The person pressing is the same whether the pick says "me" or names them. */
export const isPicked = (p: Picked, m: ListMember): boolean => p.some((x) => (x.kind === "me" ? !!m.me : x.id === m.id || (!!m.me && false)));

/** A member added to the pick, or taken out of it when already there. */
export function togglePick(p: Picked, m: ListMember): Picked {
  return isPicked(p, m) ? p.filter((x) => !(x.kind === "me" ? !!m.me : x.id === m.id)) : [...p, m.me ? { kind: "person", id: m.id, name: m.name } : { kind: "person", id: m.id, name: m.name }];
}

/** "Sam R." for "Sam Rivera": enough to tell people apart in a line, short enough to fit two or three. */
export function shortName(name: string): string {
  const w = name.trim().split(/\s+/);
  return w.length < 2 ? w[0] ?? "" : `${w[0]} ${w[w.length - 1]![0]!.toUpperCase()}.`;
}
const shorts = (p: Picked): string[] => p.map((x) => (x.kind === "me" ? "you" : shortName(x.name)));

/** The trigger's words: "nobody", "you", "Sam R.", "Sam R., Ada L. +1". */
export function pickName(p: Picked): string {
  const n = shorts(p);
  if (!n.length) return "nobody";
  return n.length <= 2 ? n.join(", ") : `${n.slice(0, 2).join(", ")} +${n.length - 2}`;
}

/** The sentence's words: "nobody", "Sam R.", "Sam R. and Ada L.", "Sam R., Ada L. and Leo M.". */
export function pickSentence(p: Picked): string {
  const n = shorts(p);
  return !n.length ? "nobody" : n.length === 1 ? n[0]! : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
}

/** The rows a search keeps: name or email contains it, case aside. */
export function filterAsk(rows: readonly AskRow[], q: string): AskRow[] {
  const n = q.trim().toLowerCase();
  return n ? rows.filter((r) => r.member.name.toLowerCase().includes(n) || (r.member.email ?? "").toLowerCase().includes(n)) : [...rows];
}
