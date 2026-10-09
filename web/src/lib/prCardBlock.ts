// What the tracker block on a board card says, decided apart from the screen.
//
// The block sits on the card's identity line and is drawn per REPOSITORY, not
// per install: a tracker that is connected for the whole machine does not make
// every repository's pull requests cards of it. A repository that never links
// one gets a card that is only the pull request — no block, no gap held for
// one, no "No card linked" hint nagging about something it will never have.
//
// There is no per-repository setting to read, so the answer is derived from
// what the board already holds: a repository uses the tracker when at least one
// of its pull requests on the board reads as one of its cards.
//
// The ceiling: a tracker repository whose open pull requests ALL lack a card
// reads as a repository without one and draws nothing. That is quiet rather than
// wrong, and remembering "this repository once had a card" is the next step.
import { cardRef, looksLikeOurs } from "./cardRef.ts";
import { CARD_PEOPLE_MAX } from "../../../shared/cardPeople.ts";

/** The slice of a pull request the rule reads. */
type Reads = { card?: unknown; headRefName?: string; title?: string; body?: string; url?: string };

/**
 * Does this repository's board use the connected tracker?
 *
 * `prs` is every pull request the board holds for ONE repository (the board is
 * drawn per repository). A card already attached counts; so does a reference in
 * the branch, title or body that belongs to the connected workspace — an id from
 * another tracker's address does not, which is `looksLikeOurs`.
 */
export function repoUsesTracker(prs: readonly Reads[], hasTaskProvider: boolean, noCustomIds = false): boolean {
  if (!hasTaskProvider) return false;
  return prs.some((p) => {
    if (p.card) return true;
    const ref = cardRef(p);
    return !!ref && looksLikeOurs(ref, undefined, true, noCustomIds);
  });
}

/**
 * Which block a card draws.
 *
 *   card     the saved boards hold it: id, status, faces
 *   loading  the second pass is not in: the shape the answer will have
 *   id       the branch names a card the boards have never seen: the id alone
 *   hint     a tracker repository, and this pull request has no card
 *   none     a repository without a tracker: nothing, nothing reserved
 *
 * A card that is READ always draws, whatever the repository rule says: the
 * rule exists to keep an unwanted block away, and a card in hand is the wanted
 * one. Everything that is only a guess waits for the rule.
 */
export type TrackerBlock = "card" | "loading" | "id" | "hint" | "none";

export function trackerBlock(o: {
  card: boolean; hasId: boolean; checksLoaded: boolean | undefined; repoUses: boolean;
}): TrackerBlock {
  if (o.card) return "card";
  if (!o.repoUses) return "none";
  if (o.checksLoaded === false) return "loading";
  return o.hasId ? "id" : "hint";
}

/** A reading older than this is dimmed and carries its age. */
export const STALE_MS = 60 * 60_000;

/**
 * How old the card's reading is, in words, and whether that is too old to state
 * as current. Hours only past the hour ("200h ago"): a day count is a rounding
 * nobody needs on a status that was true when it was read.
 */
export function readingAge(at: number | undefined, now = Date.now()): { stale: boolean; said: string } {
  if (!at) return { stale: false, said: "" };
  const age = now - at;
  const said = age < 60_000 ? "just now"
    : age < STALE_MS ? `${Math.round(age / 60_000)}m ago`
      : `${Math.round(age / 3_600_000)}h ago`;
  return { stale: age > STALE_MS, said };
}

/** Faces drawn, and the "+N" for the rest (0 when everyone fits). */
export function peopleShown(count: number): { faces: number; more: number } {
  return { faces: Math.min(count, CARD_PEOPLE_MAX), more: Math.max(0, count - CARD_PEOPLE_MAX) };
}
