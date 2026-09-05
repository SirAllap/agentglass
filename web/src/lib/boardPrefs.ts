/*
 * Which lanes of the pull-request board are folded away.
 *
 * The board was the ONE container fold in this app that forgot itself. Every
 * other one persists — the tasks rail, the browser's spaces, Docker's stacks —
 * and this one held its state in a `useState({})` that nothing read or wrote.
 * Worse than a fresh start each launch: the panel mounts the board
 * conditionally, so typing one character in the filter unmounted it and took
 * the folds with it.
 *
 * TWO CONVENTIONS PICKED ON PURPOSE, because the audit that led here counted
 * eleven container folds in this app using four state shapes and three
 * localStorage namespaces, with the polarity flipping between them:
 *
 *   the key      `agentglass.<surface>.<thing>` — the majority spelling, the
 *                one with forty keys behind it. Not `agx.` and not `agx_`.
 *   the polarity what is SHUT, like the tasks rail and the browser. A list of
 *                the closed ones means a lane added tomorrow arrives OPEN,
 *                which is the answer somebody wants for a lane they have never
 *                seen. Storing the open ones would hide it.
 *
 * Reconciled against the lanes that exist on read, the way `taskSources.ts`
 * does it, so a lane that is renamed or dropped cannot leave a fold behind
 * pointing at nothing.
 */

const KEY = "agentglass.pr.lanes";

/** The ids of the lanes that are folded. Unknown ids are dropped, so a stored
 *  fold for a lane that no longer exists simply stops existing too. */
export function foldedLanes(known: readonly string[]): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string" && known.includes(x));
  } catch { return []; }
}

/** Written as a plain list. An empty one REMOVES the key rather than storing
 *  `[]`: nothing folded is the default, and a default worth writing down is a
 *  default that will disagree with the code the day the default changes. */
export function setFoldedLanes(ids: readonly string[]): void {
  try {
    if (!ids.length) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify([...new Set(ids)]));
  } catch { /* private mode, or a browser that has said no */ }
}

/**
 * The lane that cannot be folded away.
 *
 * "Needs your review" is the lane this board exists for — the sentence at the
 * top counts it, and a person folding it has hidden the only column that is
 * asking them for something. Two folds in this app already override the user
 * for the same reason and both wrote down why: Docker reopens a stack that has
 * just broken ("the reason to collapse one is that it is fine and you want the
 * room"), and the tool feed refuses because "a folded failure is worse than no
 * fold at all".
 *
 * This is the gentler form of the same rule — it never folds rather than
 * unfolding itself later, so nothing moves under the hand that is clicking.
 *
 * ONLY WHILE IT HOLDS SOMETHING, which the first version of this missed. The
 * argument above is entirely about a lane that is asking you for something: a
 * lane at ZERO is asking for nothing, and it was still taking 268 pixels of a
 * board that does not fit five columns on his screen, with a control that
 * refused. Reported looking straight at it: "no puedo plegar la primera
 * columna", under a heading reading `0 NEEDS YOUR REVIEW`.
 *
 * Both halves matter and they do not conflict. Empty, it folds like any other.
 * The moment something lands in it, `foldable` says no again — and because a
 * fold is only ever REFUSED and never undone, a lane that fills up while folded
 * stays folded rather than springing open under the hand that is clicking. It
 * still says its count on the folded strip, which is how you find out.
 */
export const ALWAYS_OPEN = "review";

/** Whether this lane may be folded right now. `count` is what it holds. */
export function foldable(id: string, count: number): boolean {
  return id !== ALWAYS_OPEN || count === 0;
}

/**
 * What the keyboard walks in a lane, which is not what the lane holds.
 *
 * Pulled out of the component because it is the one piece of the fold that a
 * render cannot show: a cursor sitting on a card behind a 44px strip looks
 * exactly like a cursor sitting on a card. The first version of this fold had
 * no test for it at all — the assertion that should have caught it passed with
 * the guard deleted, which is how a hole this shape stays open.
 *
 * A folded lane walks as EMPTY, which is this app's own answer three times
 * over. `DockerPanel.ordered` puts it best: "so j/k walks what is on screen,
 * skipping collapsed stacks rather than jumping into a container nobody can
 * see". Without it the board's own heal does not fire either — it only rescues
 * a lane with nothing in it, and a folded lane with six cards reports six.
 */
export function walkable<T>(
  all: readonly T[],
  o: { folded: boolean; opened: boolean; cap: number },
): readonly T[] {
  if (o.folded) return [];
  return o.opened ? all : all.slice(0, o.cap);
}
