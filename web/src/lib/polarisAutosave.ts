// The instant-save sequence of the Polaris view, apart from React so a fake `save` can drive it.
// One run writes the layer, then the on/off switch; whatever happens, it hands back the answer
// the store now holds, so the view can rebase on it and never keep a draft the store does not have.
import type { DoorId, SettingsAnswer, SettingsChange } from "../../../shared/polaris.ts";
import { draftState, rebaseDraft, saveCommit, type DraftState } from "./polarisDraft.ts";
import type { Scope } from "./polarisView.ts";

export type SaveFn = (change: SettingsChange) => Promise<{ error: string | null; answer: SettingsAnswer | null }>;

export type SaveRun =
  /** A live door the person has not allowed yet: ask first, write nothing. */
  | { kind: "ask"; consent: DoorId[] }
  | { kind: "saved"; answer: SettingsAnswer }
  /** The store holds `answer` (the last good one, or the one read before): revert the rows to it and say `error`. */
  | { kind: "failed"; answer: SettingsAnswer; error: string };

export const FAILED = "Could not save that change. It is back to what is stored.";

export async function runSave(state: DraftState, answer: SettingsAnswer, scope: Scope, allowed: readonly DoorId[], save: SaveFn): Promise<SaveRun> {
  const { plan: p, layer } = saveCommit(state, answer, scope);
  // The base moved under the confirmation between the question and this click: ask again.
  if (p.consent.some((d) => !allowed.includes(d))) { return { kind: "ask", consent: p.consent }; }
  const wasEnabled = state.base.enabled;
  let cur = answer;
  if (p.chosen || p.resets.size > 0 || Object.keys(p.edits).length > 0) {
    const r = await save({ settings: layer });
    if (r.error) return { kind: "failed", answer: cur, error: `${FAILED} ${r.error}` };
    if (r.answer) cur = r.answer;
  }
  if (state.draft.enabled !== wasEnabled) {
    const r = await save({ enabled: state.draft.enabled });
    if (r.error) return { kind: "failed", answer: cur, error: `${FAILED} ${r.error}` };
    if (r.answer) cur = r.answer;
  }
  return { kind: "saved", answer: cur };
}

const sameDraft = (a: DraftState, b: DraftState): boolean =>
  JSON.stringify([a.draft, [...a.resets].sort()]) === JSON.stringify([b.draft, [...b.resets].sort()]);

/**
 * The draft once a run ends. A failure puts the rows back on the stored answer. A success does too,
 * unless the person changed something while the save was in flight: that change is kept on the new
 * answer, and the view saves it next.
 */
export function settle(run: SaveRun, sent: DraftState, latest: DraftState, scope: Scope): DraftState | null {
  if (run.kind === "ask") return null;
  if (run.kind === "failed" || sameDraft(sent, latest)) return draftState(run.answer);
  return rebaseDraft(latest, run.answer, scope);
}
