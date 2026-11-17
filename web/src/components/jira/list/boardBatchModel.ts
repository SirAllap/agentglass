/*
 * The board's own extras on top of the shared card selection (selectionModel.ts): Shift+click's range within a
 * column, and the line a batch move ends with. Pulled out of JiraBoard.tsx so both can be tested without a renderer.
 */
import type { Selection } from "./selectionModel.ts";

/** Shift+click: every id between `anchor` and `id` in `order` (one column's own card order), replacing whatever was
 *  selected before. Either end missing from `order` — the anchor scrolled off, say — falls back to just `id`. */
export function rangeSelected(order: readonly string[], anchor: string, id: string): Selection {
  const a = order.indexOf(anchor), b = order.indexOf(id);
  if (a < 0 || b < 0) return new Set([id]);
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return new Set(order.slice(lo, hi + 1));
}

export interface BatchFailure { key: string; reason: string }

/** The line a batch move ends with: plain when every card moved, naming each refusal when one did not. */
export function batchResultLine(moved: number, failed: readonly BatchFailure[]): string {
  const movedWord = `${moved} moved`;
  if (!failed.length) return movedWord;
  const detail = failed.map((f) => `${f.key}: ${f.reason}`).join("; ");
  return `${movedWord} · ${failed.length} could not (${detail})`;
}

/** Which cards a drag of `id` carries: the whole selection when `id` is one of it (and there is more than one), else
 *  just `id`. `order` is the board's own card order, so the batch keeps it whatever order the picks were made in. */
export function dragBatchIds(order: readonly string[], selection: Selection, id: string): string[] {
  if (selection.has(id) && selection.size > 1) return order.filter((x) => selection.has(x));
  return [id];
}

/** Of the cards a drop would move, those still sent: a card whose own steps refuse the column stays while at least
 *  one other accepts, so the batch's last line names it instead of dropping it unseen. `allowed` is each card's own
 *  verdict; nothing allowed at all sends nothing (the caller says why). */
export function dropTargets<T>(eligible: readonly T[], allowed: readonly boolean[]): T[] {
  return allowed.some(Boolean) ? [...eligible] : [];
}
