// The checks the Pull requests board already loaded, kept by address so the Jira
// card's PR chip reads the same numbers instead of "CI not read". Fed from the
// list answers the board asks for anyway: no request of its own.
import type { PrCheckRollup, PrRepoId, PrSummary } from "../../../shared/types.ts";

const held = new Map<string, { checks: PrCheckRollup; at: number }>();
/** What else the same list row says about a pull request, for the Jira tile: read-only facts, no request of their own. */
export type ListFacts = Pick<PrSummary, "number" | "state" | "isDraft" | "baseRefName" | "additions" | "deletions" | "reviewDecision" | "reviewers" | "humanReview">;
const facts = new Map<string, ListFacts>();
const subs = new Set<() => void>();

const keyOf = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`;

/** Remember every row of a list answer whose second pass (the checks) has arrived. */
export function publishListChecks(repo: Pick<PrRepoId, "owner" | "name"> | null | undefined, prs: readonly (Pick<PrSummary, "number" | "checks" | "checksLoaded"> & Partial<ListFacts>)[] | undefined): void {
  if (!repo || !prs) return;
  if (listLoadOf(`${repo.owner}/${repo.name}`) !== "done") loads.set(`${repo.owner}/${repo.name}`.toLowerCase(), "done");
  const at = Date.now();
  let any = false;
  for (const p of prs) {
    if (!p.checksLoaded || !p.checks) continue;
    const k = keyOf(`${repo.owner}/${repo.name}`, p.number);
    held.set(k, { checks: p.checks, at });
    facts.set(k, { number: p.number, state: p.state ?? "OPEN", isDraft: !!p.isDraft, baseRefName: p.baseRefName ?? "", additions: p.additions ?? 0, deletions: p.deletions ?? 0, reviewDecision: p.reviewDecision ?? null, ...(p.reviewers ? { reviewers: p.reviewers } : {}), ...(p.humanReview !== undefined ? { humanReview: p.humanReview } : {}) });
    any = true;
  }
  if (any) for (const s of subs) s();
}

/* Whether the board's list load for a repo has run: the Jira chip says "loading" meanwhile, "not read" only after. */
export type ListLoad = "idle" | "loading" | "done" | "failed";
const loads = new Map<string, ListLoad>();
export const listLoadOf = (repo: string): ListLoad => loads.get(repo.toLowerCase()) ?? "idle";
export function setListLoad(repo: string, to: ListLoad): void {
  loads.set(repo.toLowerCase(), to);
  for (const s of subs) s();
}
/** For tests: forget every load and reading. */
export function __resetListChecks(): void { held.clear(); facts.clear(); loads.clear(); }

/**
 * What a card's CI chip does: show a reading, trigger the board's own list load (store empty, nothing asked yet),
 * say "loading" while that load is in flight, or say "not read" once it finished without the PR (or failed).
 */
export function ciPlan(hasRead: boolean, load: ListLoad): { show: "read" | "loading" | "not-read"; trigger: boolean } {
  if (hasRead) return { show: "read", trigger: false };
  if (load === "idle") return { show: "loading", trigger: true };
  if (load === "loading") return { show: "loading", trigger: false };
  return { show: "not-read", trigger: false };
}

export function listChecksFor(repo: string, number: number): { checks: PrCheckRollup; at: number } | null {
  return held.get(keyOf(repo, number)) ?? null;
}

/** The list row's other facts for a pull request, once its second pass arrived; null before. */
export function listFactsFor(repo: string, number: number): ListFacts | null {
  return facts.get(keyOf(repo, number)) ?? null;
}

export function onListChecks(fn: () => void): () => void { subs.add(fn); return () => { subs.delete(fn); }; }
