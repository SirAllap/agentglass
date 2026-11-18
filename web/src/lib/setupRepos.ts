/*
 * Step 4's decisions, apart from its screen: what a folder answer means, how a
 * branch is cut to one line, the tally, and what Continue sends.
 *
 * Nothing here adds a project. The list is read with `GET /setup/repos`, and the
 * one write is the frame's Continue handing the ticked roots to `POST
 * /workspace` — added to what is already open, never instead of it.
 */
import type { SetupRepoRow, SetupRepos } from "../../../shared/types.ts";

/** How many characters of a branch one row shows before it is cut. */
export const BRANCH_MAX = 26;

/**
 * A branch on one line. Past `BRANCH_MAX` it keeps its leaf whole — the part
 * that tells two branches apart is after the last `/` — and collapses the rest
 * to `…/`; a branch that has no `/` to give is cut in its middle, so both ends
 * still read.
 */
export function branchLabel(name: string, max = BRANCH_MAX): string {
  const b = (name ?? "").trim();
  if (b.length <= max) return b;
  const leaf = b.slice(b.lastIndexOf("/") + 1);
  if (b.includes("/") && leaf.length + 2 <= max) return `…/${leaf}`;
  const keep = max - 1, head = Math.ceil(keep / 2), tail = keep - head;
  return `${b.slice(0, head)}…${b.slice(b.length - tail)}`;
}

/** What the folder read means, as the step draws it. */
export type ReposView =
  | { state: "reading" }
  | { state: "empty" }
  | { state: "gone"; path: string }
  | { state: "notrepo"; path: string }
  | { state: "rows"; path: string; rows: SetupRepoRow[]; capped: boolean };

export function reposView(asked: string, answer: SetupRepos | null): ReposView {
  if (!asked) return { state: "empty" };
  if (!answer) return { state: "reading" };
  if (!answer.exists) return { state: "gone", path: answer.path || asked };
  if (!answer.repos.length) return { state: "notrepo", path: answer.path || asked };
  return { state: "rows", path: answer.path || asked, rows: answer.repos, capped: answer.capped };
}

/** The rows a view holds; empty for every state that has none. */
export const repoRowsOf = (v: ReposView): readonly SetupRepoRow[] => (v.state === "rows" ? v.rows : []);

/** `Select all` ticks what is not ticked; it never clears what is. */
export const tickAll = (ticked: readonly string[], rows: readonly SetupRepoRow[]): string[] => [
  ...ticked,
  ...rows.map((r) => r.root).filter((root) => !ticked.includes(root)),
];

/** The footer's tally: the ticked rows out of the rows on screen. */
export const repoTally = (ticked: readonly string[], rows: readonly SetupRepoRow[]) => ({
  n: rows.filter((r) => ticked.includes(r.root)).length,
  of: rows.length,
});

/**
 * What Continue sends. Additive: the projects already open stay open, and the
 * ticked ones join them — adding one repository must not close the one the
 * person was working in (the server's own list replaces whatever it is sent).
 */
export function addedRoots(open: readonly string[], ticked: readonly string[]): string[] {
  return [...open, ...ticked.filter((r) => !open.includes(r))];
}

/**
 * What the footer's left button does on this step. Steps 2-4 say `Skip for now`,
 * which leaves the setup open and moves forward; the last step's `Not now` and
 * step 1's `Skip setup` finish it.
 */
export function skipAction(step: number, last: number): "advance" | "finish" {
  return step > 0 && step < last ? "advance" : "finish";
}

/**
 * Step 4's Continue is dead only when there is nothing to carry on with: a
 * folder that read as no repositories, with nothing ticked and no project open.
 * With a project already open (an upgrade, or `Run the setup again`) there is
 * nothing to add and Continue must still move on.
 */
export function reposBlocked(viewState: ReposView["state"], tickedN: number, openN: number): boolean {
  if (viewState === "rows" && tickedN > 0) return false;
  return openN === 0;
}

export type Move = "none" | "advance" | "commit" | "finish";

/**
 * What a press in the footer does. One rule for the button, Ctrl+Enter and
 * `Skip for now`, so none of them can do what another may not:
 * - a commit still in the air swallows every press (no second terminal);
 * - the primary and the key obey `blocked`;
 * - `Skip for now` / `Not now` never runs the step's write: skipping step 5
 *   must not open a terminal, skipping step 4 must not add the ticked repos.
 */
export function footerMove(o: { via: "primary" | "skip"; step: number; last: number; blocked: boolean; going: boolean }): Move {
  if (o.going) return "none";
  if (o.via === "skip") return skipAction(o.step, o.last);
  if (o.blocked) return "none";
  return "commit";
}
