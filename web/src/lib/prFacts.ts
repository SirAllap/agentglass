/*
 * One pull request, one reading, shared.
 *
 * The Pull requests view and the pane chip each read the same pull request
 * from GitHub on their own clocks. Each kept its own copy, so the panel could
 * say "merged" while the chip under a terminal went on saying "open". Both now
 * write here, stamped with when GitHub was read, and the chip draws the newest
 * of its own answer and this store. Keyed by repository (owner/name) and number
 * so the two views agree on identity without agreeing on a checkout path.
 */
import type { PrBranchSummary } from "../../../shared/types.ts";
import type { PrFact } from "./paneChip.ts";

const facts = new Map<string, PrFact>();
const listeners = new Set<() => void>();
let version = 0;
const CAP = 200;

const keyOf = (repo: string, n: number) => `${repo}#${n}`;

/** Record what a read said. An older reading never replaces a newer one. */
export function notePrs(repo: string, rows: readonly Pick<PrBranchSummary, "number" | "state" | "isDraft" | "reviewDecision">[], at = Date.now()): void {
  if (!repo) return;
  let changed = false;
  for (const r of rows) {
    const k = keyOf(repo, r.number);
    const cur = facts.get(k);
    if (cur && cur.at > at) continue;
    if (cur && cur.state === r.state && cur.isDraft === r.isDraft && cur.reviewDecision === r.reviewDecision) { cur.at = at; continue; }
    facts.delete(k);
    facts.set(k, { state: r.state, isDraft: r.isDraft, reviewDecision: r.reviewDecision, at });
    changed = true;
  }
  while (facts.size > CAP) facts.delete(facts.keys().next().value!);
  if (changed) { version++; for (const l of listeners) l(); }
}

export const prFactOf = (repo: string, n: number): PrFact | null => facts.get(keyOf(repo, n)) ?? null;
export const prFactsVersion = (): number => version;
export function onPrFacts(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }
/** For tests: a clean store. */
export function forgetPrFacts(): void { facts.clear(); version++; }
