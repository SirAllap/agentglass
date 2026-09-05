/*
 * "Is this a card id, and where else is it mentioned?"
 *
 * Shared because two sides ask the same question and must not drift. The panel
 * asks it to decide whether Enter is a JUMP or a search; the server asks it to
 * decide whether a sweep needs to carry card bodies, which costs real seconds.
 * If those two ever disagree, the panel jumps for a query the server searched
 * as text, or the other way round, and neither surface can tell you why.
 */

/**
 * `1042`, `ORBIT-1042`, `ORBIT-2077` — a card, said the way people say one.
 *
 * Three digits at least, so a page number or a sprint count is not mistaken
 * for a card. An optional prefix, because a workspace's custom ids carry one
 * and people type it about half the time.
 */
export const looksLikeCardId = (q: string): boolean =>
  /^\s*([A-Za-z][\w]*-)?\d{3,}\s*$/.test(q);

/** The digits of a card id, with any prefix and spaces taken off. `null` when
 *  the text is not one. */
export function cardIdDigits(q: string): string | null {
  const m = /^\s*(?:[A-Za-z][\w]*-)?(\d{3,})\s*$/.exec(q);
  return m ? m[1]! : null;
}

/**
 * Does this card's text refer to the card whose digits these are?
 *
 * The sibling of `mentionsCard` in server/src/clickup.ts, which asks the same
 * question of a pull request and takes the WHOLE id. This one takes the digits
 * because a person searching types `1042` about as often as `ORBIT-1042`, and
 * both have to find the same thing.
 *
 * The boundary rules are that function's, deliberately, so the two never
 * disagree about what counts as a mention: a word character after the number
 * means a different card (`ORBIT-1042` must not match inside `ORBIT-10420`),
 * and a HYPHEN after it does not — a branch is literally
 * `fix/ORBIT-1042-pagination`, and a body that names that branch is referring
 * to the card.
 *
 * WHY THE PREFIX IS REQUIRED, and the bare number is not enough. `1042` on its
 * own turns up in dates, in counts, in the middle of a hash. A search for a
 * card that answers with every card whose body holds those four digits is a
 * search nobody reads twice. A reference has the shape of one: letters, a
 * hyphen, the number, standing alone.
 *
 * The prefix is not pinned to the workspace's own. Somebody quoting another
 * tracker still means something, and this is a search — a near miss the reader
 * can see the reason for costs one glance, while a miss costs them the thing
 * they were looking for.
 */
export function mentionsCardId(text: string, digits: string): boolean {
  if (!text || !digits) return false;
  return new RegExp(`(^|[^\\w])[A-Za-z][\\w]*-${digits}(?!\\w)`).test(text);
}
