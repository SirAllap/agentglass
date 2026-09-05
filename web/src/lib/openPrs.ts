/*
 * "Show me that pull request."
 *
 * A ClickUp card knows its PR numbers; the pull-request view knows how to
 * display one. Neither is a parent of the other, and the panel asking is three
 * levels down from the one that owns the view. The same one-slot bus as
 * termIssue.ts and openSettings.ts, for the same reason: the sender does not
 * know whether the receiver is mounted, and should not have to.
 *
 * What travels is a SEARCH, not a selection — a number typed into the box that
 * view already has. That is deliberate: it is the gesture somebody performs by
 * hand today, it lands them somewhere they recognise, and it degrades honestly
 * when the PR is in another repository or has been deleted. Pushing a selection
 * instead would need the view to hold a card's idea of what exists.
 */
/**
 * How wide the receiving view has to look.
 *
 * `open` is the ordinary case and the cheap one. `all` includes every pull
 * request the repository has ever had — 16,199 of them on a real one against
 * 389 open — so it is asked for only when the thing being looked for is not
 * open, which the sender already knows from the card.
 */
export type PrScope = "open" | "all";

export interface PrJump { query: string; scope: PrScope; n: number }

let listener: ((j: PrJump) => void) | null = null;
let seq = 0;

export function onOpenPrs(fn: ((j: PrJump) => void) | null): () => void {
  listener = fn;
  return () => { if (listener === fn) listener = null; };
}

/** Open the pull-request view looking for this. `n` rises each time so asking
 *  for the same number twice is two arrivals, not one ignored. */
export function openPrs(query: string, scope: PrScope = "open"): void {
  listener?.({ query, scope, n: ++seq });
}

/**
 * Open one, rather than search for it.
 *
 * `openPrs` types a number into the panel's filter and lets it search, which is
 * right when the sender only has a string — a branch name off a notification,
 * a card id. It is wrong when the sender knows exactly which pull request it
 * means: reported from Source control, where pressing the branch's own chip put
 * "17375" in the search box and stopped at "25 of 388 matches", having already
 * had the number in hand.
 *
 * So a caller that knows both the repository and the number says so, and the
 * shell turns that into the panel's own jump — which selects and opens.
 */
/** What a caller can ask for beyond "open it". `mention` says: once it is open,
 *  go to the place somebody named me and flash it — the inbox knows THAT you
 *  were mentioned and nothing about where, which is the half that made a
 *  mention notification end at the top of a forty-entry conversation. */
export interface PrOpen { repo: string; number: number; mention?: boolean; n?: number }

let exact: ((j: PrOpen) => void) | null = null;

export function onOpenPr(fn: ((j: PrOpen) => void) | null): () => void {
  exact = fn;
  return () => { if (exact === fn) exact = null; };
}

export function openPr(repo: string, number: number, opts: { mention?: boolean } = {}): void {
  // `n` rises so asking for the same pull request twice arrives twice: pressing
  // the same inbox row again should jump to the mention again.
  exact?.({ repo, number, ...opts, n: ++seq });
}

/**
 * The repository and number inside a pull request's own URL.
 *
 * The card panel lists the pull requests on a ClickUp card and had only the
 * number to hand — so pressing one typed it into the panel's filter and left
 * you looking at "376 matches, 1 shown", one more click from the thing you
 * asked for. The URL is right there in the same row and carries the half that
 * was missing.
 *
 * Any host, not only github.com: an enterprise install serves the same path.
 * Null for anything that is not one — a card can state a pull request nobody
 * has linked, and that row has no URL at all.
 */
export function prRefFromUrl(url: string | undefined | null): { repo: string; number: number } | null {
  if (!url) return null;
  const m = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#]|$)/.exec(url.trim());
  if (!m) return null;
  const number = Number(m[3]);
  return Number.isSafeInteger(number) && number > 0 ? { repo: `${m[1]}/${m[2]}`, number } : null;
}
