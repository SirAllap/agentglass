/*
 * The doors between a pane, its branch, its pull request and its card.
 *
 * The phone had the route for a branch's pull request the whole time
 * (`/prs/for-branch`, read only by Source control) and the pane list already
 * says every window's checkout, so "which PR is this window working on" and
 * "which window is working on this PR" are both answerable from data on the
 * screen. They were two places to look instead of one door.
 *
 * ── the trap: two worktrees of one repository ─────────────────────────────
 * A branch lookup must be answered by the CHECKOUT, never by the repository.
 * `feat/ORBIT-1050` and `feat/ORBIT-1042` are two windows of `acme/orbit`, and
 * a fallback to the repository's first worktree opens the wrong pane while
 * looking entirely plausible. So: no branch answer means no pane, and the
 * screen says so. A window name is a weaker fallback, allowed only for a card
 * key — a window called `orbit-1042` is the window for ORBIT-1042 — and it too
 * refuses to choose between two candidates.
 *
 * The branch map is a plain object of checkout → branch: the screen fills it
 * from `/git/repo?root=` for the tabs it draws, capped at eight.
 */
import type { PrBranchSummary } from "../../../shared/types.ts";

/**
 * What `/prs/for-branch` answers, which is deliberately less than a list row.
 * `from` is the pull request whose HEAD is this branch; `into` are the ones
 * that use it as their base. Declared here as well as on the screen that first
 * read it, because the shape is one route's reply and neither is shared.
 */
export interface BranchLookup {
  ok: boolean;
  repo?: string;
  from?: PrBranchSummary;
  into: PrBranchSummary[];
  /** `gh` is logged out: different from "no pull request for this branch". */
  needsAuth?: boolean;
  /** The server said there was nothing to ask GitHub about. */
  local?: boolean;
  error?: string;
}

export type BranchPr =
  | { hit: PrBranchSummary; why?: undefined }
  | { hit: null; why: string };

/** The pull request this branch opens, or one sentence saying why there is none. */
export function prForBranch(answer: BranchLookup): BranchPr {
  if (!answer.ok) return { hit: null, why: answer.error || "GitHub did not answer." };
  if (answer.from) return { hit: answer.from };
  if (answer.needsAuth) return { hit: null, why: "GitHub on the computer is not signed in." };
  if (answer.local) return { hit: null, why: answer.error || "This checkout has no branch to look up." };
  const base = answer.into[0];
  if (base) {
    return {
      hit: null,
      why: `No pull request from this branch. It is the base of #${base.number}.`,
    };
  }
  return { hit: null, why: "No pull request for this branch yet." };
}

/** The directory stripped of trailing slashes — two spellings of one checkout. */
const at = (path: string): string => path.replace(/\/+$/, "");

interface Place {
  paneId: string;
  name: string;
  where: string;
}

/**
 * The pane running this branch, among the tabs the strip draws.
 *
 * `branches` is checkout → branch; a missing entry is "git did not answer", not
 * "the default branch", and it answers nothing rather than the first tab.
 */
export function paneForBranch<T extends Place>(
  tabs: readonly T[], branches: Readonly<Record<string, string>>, branch: string | null | undefined,
): T | null {
  if (!branch) return null;
  const wanted = branch.trim();
  if (!wanted) return null;
  const byDir = new Map(Object.entries(branches).map(([where, name]) => [at(where), name]));
  const found = tabs.filter((tab) => byDir.get(at(tab.where)) === wanted);
  return found.length === 1 ? found[0]! : null;
}

/*
 * A project key as a tracker writes it — `ORBIT-1042`. Upper case is required
 * in the branch text, and that is what keeps a version out of it: `fix/utf-8`
 * has no key, while `feat/ORBIT-1042` does. Ceiling: a branch that spells an
 * all-caps version, `feat/UTF-8`, would be read as a key.
 */
const KEY = /\b([A-Z][A-Z0-9]+-\d+)\b/;

export function taskKeyIn(text: string | null | undefined): string | null {
  return text ? (KEY.exec(text)?.[1] ?? null) : null;
}

/**
 * The pane working on this key.
 *
 * A branch carrying the key is the exact answer. A window NAMED after it
 * (`orbit-1042`) is the fallback for a checkout git has not answered for, and
 * it is refused when two tabs carry it: the key names a piece of work, and two
 * windows claiming one work item is not a tie this screen may break.
 */
export function paneForKey<T extends Place>(
  tabs: readonly T[], branches: Readonly<Record<string, string>>, key: string | null | undefined,
): T | null {
  const wanted = key?.trim().toUpperCase();
  if (!wanted) return null;
  const byDir = new Map(Object.entries(branches).map(([where, branch]) => [at(where), branch]));
  const onBranch = tabs.filter((tab) => {
    const branch = byDir.get(at(tab.where));
    return !!branch && taskKeyIn(branch) === wanted;
  });
  if (onBranch.length === 1) return onBranch[0]!;
  if (onBranch.length > 1) return null;
  const named = tabs.filter((tab) => tab.name.toLowerCase().includes(wanted.toLowerCase()));
  return named.length === 1 ? named[0]! : null;
}
