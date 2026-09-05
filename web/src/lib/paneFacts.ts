/*
 * What a pane's branch is attached to, remembered between launches.
 *
 * The four doors a pane draws are answered by three different questions and
 * only the first of them is local:
 *
 *   which worktree   ~4 ms   (the pane's own processes — see panewt.ts)
 *   which pull request  ~560 ms  (a `gh` call, per branch)
 *   which card / its priority  ~450 ms  (a ClickUp call, per card)
 *
 * Measured on the developer's own machine, warm, twice each. So a first hover
 * on a pane costs about a second of network before the block can say anything
 * beyond the branch — and after a restart every pane pays it again, one at a
 * time, as the pointer reaches them. "Why does it take so long to read the panes?"
 *
 * Both answers change on the scale of a working day: a branch's pull request is
 * the same pull request tomorrow, and a card's priority changes when somebody
 * says so out loud. So they are written down and shown immediately on the next
 * launch, and re-asked in the background — stale-while-revalidate, the shape
 * this app already uses for the pull-request detail.
 *
 * What is NOT written down is anything that moves: no check states, no review
 * decision beyond what the block draws as a dot, and nothing at all once the
 * entry is a day old.
 */

export interface RememberedPr {
  repo: string | null;
  /** The shape the chip needs; `null` is "asked, and there is none". */
  pr: unknown | null;
  at: number;
}

const PR_KEY = "agentglass.term.branchPr";
const PRIO_KEY = "agentglass.term.cardPrio";
/** A day. Past that the answer is re-asked before it is drawn — a pull request
 *  that was merged last week must not open from a memory. */
export const FACTS_MAX_AGE = 24 * 60 * 60 * 1000;
const CAP = 80;

function read<T>(key: string): [string, T][] {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || "null");
    if (!Array.isArray(raw)) return [];
    const now = Date.now();
    return raw.filter((e): e is [string, T & { at: number }] =>
      Array.isArray(e) && typeof e[0] === "string" && !!e[1]
      && typeof (e[1] as { at?: unknown }).at === "number"
      && now - (e[1] as { at: number }).at < FACTS_MAX_AGE).slice(-CAP);
  } catch { return []; }
}

function write(key: string, entries: [string, unknown][]): void {
  try { localStorage.setItem(key, JSON.stringify(entries.slice(-CAP))); }
  catch { /* private mode or a full quota — this run still has its memory */ }
}

export const readBranchPrs = (): [string, RememberedPr][] => read<RememberedPr>(PR_KEY);
export const writeBranchPrs = (m: Map<string, RememberedPr>): void => write(PR_KEY, [...m.entries()]);

/** Card query → `{ priority, at }`. A priority is a word or nothing. */
export interface RememberedPrio { priority: string | null; at: number }
export const readCardPrios = (): [string, RememberedPrio][] => read<RememberedPrio>(PRIO_KEY);
export const writeCardPrios = (m: Map<string, RememberedPrio>): void => write(PRIO_KEY, [...m.entries()]);
