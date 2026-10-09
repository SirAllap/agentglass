// What each zone of a board card says, decided apart from the screen.
//
// The card is a tracker header over one pull-request panel with three zones:
// what it is, where it stands, what happened last. The wording and the cut
// points live here because there is no renderer in this project to test them
// through, and a rule that only exists inside JSX is a rule nothing checks.
import type { PrCheckRollup } from "../../../shared/types.ts";

/** Nothing has moved for this long and the card says so in words, not only in amber. */
export const STALL_DAYS = 7;

/** Faces a person gets on a card before the rest read as "+N". */
export const FACES_MAX = 5;

/**
 * Splits "Exports | Restore the bundle…" into the area and the sentence, so the
 * area can be drawn quieter. Only a short prefix before the FIRST " | " counts:
 * a title that merely contains a pipe further in is one sentence, not a prefix.
 * A title with no such prefix comes back whole.
 */
export function splitTitle(title: string): { pre: string; rest: string } {
  const at = title.indexOf(" | ");
  if (at < 1 || at > 24 || !title.slice(at + 3).trim()) return { pre: "", rest: title };
  return { pre: title.slice(0, at), rest: title.slice(at + 3) };
}

export type Standing = {
  /** The one word the zone leads with, in the check bar's colour. */
  word: string;
  kind: "green" | "red" | "pending" | "none";
  /** Red only: how many, as a chip beside the word. Colour is never the only signal. */
  failing: string | null;
  /** How far the suite has got, 0..100. An empty track is "nothing reported", not "done". */
  done: number;
};

/**
 * The checks as the standing zone draws them. `pending` wins over `red`: a
 * suite still running with one failure in is still running, and drawing it as
 * finished-red would say it had stopped.
 */
export function standing(c: PrCheckRollup): Standing {
  const done = c.total > 0 ? Math.round(((c.total - c.pending) / c.total) * 100) : 0;
  if (c.pending > 0) return { word: `${c.success} of ${c.total} in`, kind: "pending", failing: null, done };
  if (c.verdict === "red") {
    return { word: "red", kind: "red", failing: `${c.failure} ${c.failure === 1 ? "check" : "checks"} failing`, done };
  }
  if (c.total === 0) return { word: "no checks", kind: "none", failing: null, done };
  return { word: "green", kind: "green", failing: null, done };
}

/** Whole days since `updatedAt` when that is past the threshold; null while it is moving or unreadable. */
export function stalledDays(updatedAt: string, now = Date.now()): number | null {
  const at = Date.parse(updatedAt);
  if (!Number.isFinite(at)) return null;
  const days = Math.floor((now - at) / 86_400_000);
  return days >= STALL_DAYS ? days : null;
}

export type EventLine = {
  /** The sentence that put the card in its lane, or what stands in for it. */
  text: string;
  /** No sentence yet: drawn quieter, with a dash where the date would be. */
  empty: boolean;
  /** Set when the card has been still for a week or more. */
  quiet: string | null;
};

/** The last-event zone. An empty reason is an honest "nothing yet", never a blank row. */
export function eventLine(reason: string | undefined, updatedAt: string, now = Date.now()): EventLine {
  const text = (reason ?? "").trim();
  if (!text) return { text: "No review activity yet", empty: true, quiet: null };
  const days = stalledDays(updatedAt, now);
  return { text, empty: false, quiet: days === null ? null : `${days} days without activity` };
}
