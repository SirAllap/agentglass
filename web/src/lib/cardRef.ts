/*
 * The work item a pull request came from, on the desk.
 *
 * The READING is `shared/taskref.ts`, and it is shared because the phone asks
 * exactly this and the two must not answer differently. What stays here is the
 * half that is genuinely about ClickUp: whether an item is one this machine's
 * board can open, and therefore what a tap on the chip is entitled to do.
 *
 * That split is the whole point. This file used to read clickup.com addresses
 * and nothing else, so a repository whose pull requests link Jira, Linear or a
 * GitHub issue got no chip at all — while the phone, since it was made
 * general, showed one. One reader, two screens, two answers.
 *
 * Three answers, and only the middle one involves ClickUp:
 *
 *   nothing              no chip, no gap, no placeholder
 *   ours                 open it here, in the board
 *   somebody else's      open its address, which needs no credentials
 */
import {
  chipFor, readTaskRef, type Evidence, type TaskRef, type TrackerId,
} from "../../../shared/taskref.ts";

export interface CardRef {
  /** What the chip says. The human id when the pull request has one, because
   *  `ORBIT-1042` is what people say out loud; the tracker's own id otherwise. */
  label: string;
  /** What the finder is handed. Not always the label: an address gives an
   *  unambiguous id, and using it skips the custom-id lookup entirely. */
  query: string;
  /** The item's own address, when the body carried one. The way out when this
   *  machine has no board to open it in — or when it is not this board's item
   *  at all. */
  url?: string;
  /** Which evidence this rests on. `url` is certain; the rest is a convention
   *  and needs corroborating before a board's mark is put on it. */
  from: Evidence;
  /** Named only by its own address, never guessed from an id's shape. Null
   *  means "an id, from we cannot say where". */
  tracker: TrackerId | null;
}

/**
 * What item this pull request is about, as far as it is willing to say.
 *
 * A thin call now. Every rule that used to be here — a template's own links
 * skipped by shape, a body naming two items answering neither, the bounds that
 * keep `fix/UTF-8-decode` from looking like an id — moved to shared/ with the
 * reading, and the phone's tests cover them.
 */
export function cardRef(pr: { headRefName?: string; title?: string; body?: string; url?: string }): CardRef | null {
  return readTaskRef(pr) as TaskRef | null;
}

/**
 * Does this item belong to the workspace we are connected to?
 *
 * Two ways for the answer to be no, and the first one is new: an address that
 * belongs to ANOTHER tracker is not this board's item, whatever its id looks
 * like. Being certain about the item and wrong about which system owns it is
 * how a Jira ticket ends up being looked up in ClickUp and found missing.
 *
 * The second is the prefix, derived from cards already read rather than
 * configured — see the server's `knownCardPrefix`. Unknown means nothing has
 * been read yet, and the honest answer then is yes: refusing to show a card
 * link because a board has not been opened this session would make the feature
 * come and go.
 */
export function looksLikeOurs(ref: CardRef, prefix: string | undefined): boolean {
  if (ref.tracker && ref.tracker !== "clickup") return false;
  if (ref.from === "url") return true;
  if (!prefix) return true;
  return ref.label.toUpperCase().startsWith(prefix.toUpperCase());
}

/**
 * What the chip should DO — the three answers above, as one decision instead
 * of a condition spread across some JSX.
 *
 * It lives here, next to the evidence it weighs, because the mistake it exists
 * to prevent is not a rendering mistake. The rule was right and the value fed
 * to it was not: the chip asked "are there boards", the answer was always yes
 * because the built-in board is always there, and a repository that had never
 * heard of ClickUp got ClickUp's mark on its pull requests. A boolean called
 * `connected` cannot be satisfied by an off-by-one, and a function returning
 * WHERE this goes cannot be half-applied.
 *
 *   null            say nothing — an id from a tracker we cannot resolve
 *   { in: "tasks" } open it here, in the board
 *   { in: "away" }  not this board's item, or no board here, and the body gave
 *                   an address — which opens without anybody's credentials
 */
export function chipAction(
  ref: CardRef | null,
  setup: { connected: boolean; prefix?: string } | null,
): { in: "tasks" } | { in: "away"; url: string } | null {
  // Null setup is "the answer has not arrived", not "no". Saying nothing until
  // it has is what stops the chip appearing and then vanishing.
  if (!ref || !setup) return null;
  if (setup.connected && looksLikeOurs(ref, setup.prefix)) return { in: "tasks" };
  // Everything else is the shared rule: an address opens, a bare id does not.
  const away = chipFor(ref, false);
  return away && "open" in away ? { in: "away", url: away.open } : null;
}
