/*
 * Typing `@` in a comment.
 *
 * The half people notice is the menu; the half that matters is what happens on
 * send. `@Name` inside the text of a ClickUp comment is PLAIN TEXT — it reads
 * as a mention on the card and notifies nobody, which is the worst shape a
 * message can have: the card says somebody was told and they were not. The
 * documented way to make one arrive is to assign the comment to them, so the
 * picker records who was named and the send hands that over.
 *
 * All of it is string work, kept away from the textarea so the awkward parts
 * are testable: an `@` in the middle of an email is not a mention, one typed
 * before an existing word replaces the right span, and a name with a space in
 * it has to come back out of the text intact.
 */

/** Somebody who can be named. Structural, so both the card's list members and
 *  any other roster fit without a conversion. */
export interface Mentionable {
  id: number;
  name: string;
}

export interface MentionQuery {
  /** Index of the `@`. */
  at: number;
  /** What has been typed after it, which may be empty. */
  query: string;
}

/**
 * Is the caret inside a mention being typed?
 *
 * The `@` has to start a word — an address like `dev@example.test` is not
 * somebody being called — and the run after it stops at whitespace, because a
 * menu that stays open across a sentence is a menu that fires on Enter when you
 * meant a newline.
 */
export function mentionQuery(text: string, caret: number): MentionQuery | null {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf("@");
  if (at < 0) return null;
  const before = at === 0 ? "" : upto[at - 1]!;
  if (before && !/\s|[([{]/.test(before)) return null;
  const query = upto.slice(at + 1);
  // Names have spaces in them, so ONE is allowed while the menu is open — "@Bruno
  // C" is still somebody being named. A second means the sentence has moved on,
  // and a menu that stays open eats the Enter you meant as a newline.
  if (/\n/.test(query) || (query.match(/\s/g)?.length ?? 0) > 1 || query.length > 40) return null;
  return { at, query };
}

/** Put a name in, and answer where the caret goes: after the name and a space,
 *  ready for the rest of the sentence. */
export function insertMention(text: string, q: MentionQuery, name: string): { text: string; caret: number } {
  const rest = text.slice(q.at + 1 + q.query.length);
  const body = `@${name} `;
  return { text: text.slice(0, q.at) + body + rest, caret: q.at + body.length };
}

/** Names the text calls out, longest first so "Ana María" wins over "Ana". */
export function mentioned<T extends Mentionable>(text: string, people: T[]): T[] {
  const found: T[] = [];
  for (const p of [...people].sort((a, b) => b.name.length - a.name.length)) {
    if (found.some((f) => f.id === p.id)) continue;
    // Word-ish boundary at the end: `@Ana` must not match inside `@Anabel`.
    const i = text.indexOf(`@${p.name}`);
    if (i < 0) continue;
    const after = text[i + 1 + p.name.length];
    if (after && /[A-Za-z0-9_-]/.test(after)) continue;
    found.push(p);
  }
  return found;
}

/** Who to hand the comment to so it actually arrives. Null when nobody was
 *  named — and when SEVERAL were, the first, because a comment is assigned to
 *  one person and picking silently is better than dropping the notification. */
export function assigneeFor<T extends Mentionable>(text: string, people: T[]): T | null {
  const named = mentioned(text, people);
  if (!named.length) return null;
  // In the order they appear in the sentence, not the order of the roster: the
  // first name in "@ana can you look, @bruno wrote it" is who is being asked.
  return named.sort((a, b) => text.indexOf(`@${a.name}`) - text.indexOf(`@${b.name}`))[0]!;
}

/** The roster, filtered by what has been typed after the `@`. */
export function matchPeople<T extends Mentionable>(people: T[], query: string, cap = 8): T[] {
  const q = query.trim().toLowerCase();
  const hit = q ? people.filter((p) => p.name.toLowerCase().includes(q)) : people;
  // Whoever the query starts with first: typing "ma" should offer María before
  // Tomás, whose name merely contains it.
  return [...hit]
    .sort((a, b) => Number(b.name.toLowerCase().startsWith(q)) - Number(a.name.toLowerCase().startsWith(q)))
    .slice(0, cap);
}

/**
 * Above the box or below it, and how tall.
 *
 * The menu hangs under the composer, which is fine everywhere except where the
 * composer already sits at the bottom of a modal — the card view — and then the
 * list runs off the end of it: "the mention picker sort of runs off the
 * bottom and I cannot see the list the way I should".
 *
 * So it is placed against the viewport rather than assumed: below when there is
 * room, above when there is more room there, and never taller than the space it
 * lands in. Pure, and given the numbers rather than reading them, because the
 * whole point is to be able to check the awkward cases without a browser.
 */
export interface MenuBox {
  /** Where the composer is, in viewport coordinates. */
  top: number;
  bottom: number;
}

export interface MenuPlace {
  up: boolean;
  maxHeight: number;
}

/** The tallest the menu is ever drawn, and the shortest worth drawing: below
 *  three rows it is a scroller with nothing to scroll. */
export const MENU_MAX = 220;
export const MENU_MIN = 96;
/** The menu overlaps the box by this much (see the `calc(100% - 30px)` it is
 *  drawn with), so the space it needs is that much less than the gap. */
const OVERLAP = 30;
/** Never flush against the window edge. */
const EDGE = 12;

export function menuPlacement(box: MenuBox, viewportHeight: number): MenuPlace {
  const below = viewportHeight - box.bottom + OVERLAP - EDGE;
  const above = box.top + OVERLAP - EDGE;
  // Below unless it genuinely does not fit AND there is more room the other
  // way: a menu that flips for a few pixels is a menu that jumps around while
  // somebody types.
  const up = below < MENU_MAX && above > below;
  const room = Math.max(up ? above : below, 0);
  return { up, maxHeight: Math.max(MENU_MIN, Math.min(MENU_MAX, room)) };
}
