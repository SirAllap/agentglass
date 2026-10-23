import type { NoteAgreement, PrRun } from "../../../shared/pluginUi.ts";

/**
 * What the small marks on a finding and on a run header say, out of the
 * screen so they can be asserted without a renderer.
 */

/** "2/3 agree": how many of the reviewers asked to confirm a finding did. */
export function agreementLabel(a: NoteAgreement): string {
  return `${a.k}/${a.n} agree`;
}

/** Everyone agreeing reads as settled, a minority as doubt, the rest as plain. */
export function agreementTone(a: NoteAgreement): "success" | "warning" | "muted" {
  if (a.k === a.n) return "success";
  if (a.k * 2 < a.n) return "warning";
  return "muted";
}

export function agreementTitle(a: NoteAgreement): string {
  return `${a.k} of ${a.n} second opinions agreed this is a real problem`;
}

/** A run's cost as a chip: dollars and cents, and "<$0.01" for the fractions
 *  of a cent a small run costs, so it never reads as free. */
export function costLabel(usd: number): string {
  if (usd <= 0) return "$0";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

export type RunHeaderState =
  | { kind: "plain"; label: string }
  | { kind: "waiting"; label: "Needs your OK"; canAnswer: true }
  | { kind: "answered"; label: string; canAnswer: false };

/** What the run header shows for a run's state. `needs-ok` is the one with
 *  buttons, and a run already answered keeps a sentence instead of them. */
export function runHeaderState(run: Pick<PrRun, "state" | "decision">): RunHeaderState {
  if (run.state !== "needs-ok") return { kind: "plain", label: run.state };
  if (run.decision === "approve") return { kind: "answered", label: "Approved, waiting for the plugin", canAnswer: false };
  if (run.decision === "skip") return { kind: "answered", label: "Skipped, waiting for the plugin", canAnswer: false };
  return { kind: "waiting", label: "Needs your OK", canAnswer: true };
}
