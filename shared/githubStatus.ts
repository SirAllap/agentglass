/**
 * "GitHub has not decided" — when waiting stops being normal, and whether
 * GitHub itself says why.
 *
 * Mergeability is computed lazily: a pull request reads UNKNOWN for a few
 * seconds after a push or a base move, then settles. When it does not settle
 * the panel used to keep saying "this settles in a few seconds", which is a
 * promise nobody keeps for an hour. So the first time a pull request shows
 * UNKNOWN is remembered, and past STUCK_AFTER_MS the sentence changes to what
 * is true: how long, and what can be done.
 *
 * Only when stuck is GitHub's public status page asked (server side, cached;
 * see githubStatusCached in server/src/prs.ts), so a healthy day costs nothing.
 *
 * Ceiling: the clock starts when THIS app first saw UNKNOWN, not when GitHub
 * began computing, so a stuck pull request found already stuck reads as short.
 */
export const STUCK_AFTER_MS = 3 * 60_000;
export const STATUS_URL = "https://www.githubstatus.com";
export const STATUS_SUMMARY_URL = "https://www.githubstatus.com/api/v2/summary.json";

/** The components whose trouble explains a pull request that will not settle. */
const WATCHED = new Set(["pull requests", "api requests"]);

export interface GithubProblem {
  /** One line, ready to show. */
  text: string;
  url: string;
}

/** Whole minutes UNKNOWN has been showing, or null while it is not yet worth saying. */
export function stuckMinutes(since: number | null | undefined, now: number): number | null {
  if (since == null || now < since || now - since < STUCK_AFTER_MS) return null;
  return Math.floor((now - since) / 60_000);
}

/**
 * Reads the Statuspage `summary.json` shape: `components[]` ({name, status}) and
 * `incidents[]` (unresolved ones only, on this endpoint). Returns null when
 * there is nothing to report or the document is not that shape — an unreadable
 * answer is never a problem.
 */
export function problemFromSummary(json: unknown): GithubProblem | null {
  if (!json || typeof json !== "object") return null;
  const j = json as { components?: unknown; incidents?: unknown };
  const comps = Array.isArray(j.components) ? j.components : [];
  const bad = comps.filter((c): c is { name: string; status: string } =>
    !!c && typeof c === "object"
    && typeof (c as { name?: unknown }).name === "string" && typeof (c as { status?: unknown }).status === "string"
    && WATCHED.has((c as { name: string }).name.toLowerCase())
    && (c as { status: string }).status !== "operational");
  if (bad.length > 0) return { text: "GitHub reports a problem with pull requests right now", url: STATUS_URL };
  const open = (Array.isArray(j.incidents) ? j.incidents : []).find(
    (x): x is { name: string; status?: string } => !!x && typeof x === "object" && typeof (x as { name?: unknown }).name === "string"
      && (x as { status?: unknown }).status !== "resolved" && (x as { status?: unknown }).status !== "postmortem");
  if (open) return { text: `GitHub reports an open incident: ${open.name.slice(0, 120)}`, url: STATUS_URL };
  return null;
}

/** The branch on GitHub moved but the pull request still points at the old head:
 *  GitHub has not synced its own pull request. A strong sign of "stuck" by itself. */
export const LAGGING_SENTENCE = "GitHub updated the branch but the pull request has not caught up yet.";

/** The sentence for a pull request GitHub has not decided on, past the threshold. */
export function stuckDetail(minutes: number, behind: number | null | undefined, problem?: GithubProblem | null, lagging = false): string {
  if (lagging) {
    return `${LAGGING_SENTENCE} Update branch would be refused until it does; open it on github.com if it stays like this.${problem ? ` ${problem.text}.` : ""}`;
  }
  const first = `GitHub has not decided for ${minutes} min.`;
  const options = behind && behind > 0
    ? " Update branch is behind its base and usually makes GitHub recompute; or open it on github.com."
    : " Open it on github.com to see what it says.";
  return `${first}${problem ? ` ${problem.text}.` : ""}${options}`;
}
