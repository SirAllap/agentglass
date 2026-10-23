/*
 * A chair that has run out of plan, said once.
 *
 * Workers keep going to the end of their turn when their chair has no engine
 * left to run it. Nothing is lost, and nobody is asking for anything yet, but
 * the person is the only one who can sign an engine in or add one to the
 * chain, so this is the one case that is allowed to notify: a blocked agent.
 * Everything else about orchestration is a quiet row.
 *
 * Asked at the moments a worker's failure says an engine is out (a rate limit
 * or a sign-in problem), and again, for a project whose card is up, when the
 * policy is saved or the engines are checked, since those are how a plan comes
 * back; never on a clock. The set is in memory: after a restart a card that
 * was up stays until the next of those moments finds the chair out again and
 * replaces it under the same key. The chain says whether the chair
 * has a plan: the policy resolved against what this machine can run now. It is
 * told once per project until a plan is back, so five workers failing behind
 * one chair are one card, not five.
 */
import { basename } from "node:path";
import { resolve, type Policy, type RuleFacts } from "../../../shared/orchestration.ts";
import type { EngineReadiness } from "../../../shared/types.ts";

export interface ChairNotify {
  out(project: string, running: number): void;
  back(project: string): void;
}

const told = new Set<string>();
export function __forgetTold(): void { told.clear(); }
/** The projects whose card is up: who to ask again when an engine or the policy changes. */
export const toldRoots = (): string[] => [...told];

export function watchChair(p: {
  root: string; policy: Policy; facts: RuleFacts; readiness: readonly EngineReadiness[];
  /** Workers of this seat still running. */
  running: number; notify: ChairNotify;
}): void {
  const planned = resolve(p.policy, p.facts, p.readiness).orchestrator.ok;
  const project = basename(p.root);
  if (planned) {
    if (told.delete(p.root)) p.notify.back(project);
    return;
  }
  if (told.has(p.root)) return;
  told.add(p.root);
  p.notify.out(project, p.running);
}
