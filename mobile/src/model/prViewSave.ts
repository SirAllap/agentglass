/*
 * What "Save this view" writes. The sheet (mock s29) saves the board on screen
 * as a `PrView` — the same shape the desk sends to `/prs/views` — so the desk
 * shows it as a chip after a refresh and the phone shows the desk's.
 *
 * The phone's rules are two switches (drafts, bots). A saved view carries them
 * as the desk's own hide rules, so the desk's evaluator reads them the same.
 * "Everyone's pull requests" is a phone-only scope and is not saved: a view is
 * a name for the rules, as the sheet says.
 */
import { VIEW_LIMITS, emptyLanes, type LaneFilter, type PrView } from "../../../shared/prFilter.ts";
import type { LaneRules } from "./prBoard.ts";

/** A bot login: GitHub's `name[bot]`, or the plain `bot` the list answer uses. */
export const BOT_AUTHOR_PATTERN = "^bot$|\\[bot\\]$";

export function lanesFromRules(rules: LaneRules): LaneFilter {
  const lanes = emptyLanes();
  if (rules.drafts) lanes.hide.children.push({ id: "r1", field: "is", op: "is", values: ["draft"] });
  if (rules.bots) lanes.hide.children.push({ id: "r2", field: "author", op: "matches", values: [BOT_AUTHOR_PATTERN] });
  return lanes;
}

export type NameFailure = "empty" | "long" | "taken" | "full";
export const cleanViewName = (raw: string): string => raw.replace(/\s+/g, " ").trim();

export const NAME_FAILURE: Record<NameFailure, string> = {
  empty: "Give the view a name.",
  long: `A name is at most ${VIEW_LIMITS.name} characters.`,
  taken: "A view with that name exists. Pick another.",
  full: `A repository keeps at most ${VIEW_LIMITS.views} views. Remove one on the computer first.`,
};

export type SaveResult = { ok: true; list: PrView[]; view: PrView } | { ok: false; reason: NameFailure };

/** The list with the new view last; the desk's `addView` rules, same limits. */
export function withNewView(list: readonly PrView[], raw: string, rules: LaneRules, id: string): SaveResult {
  if (list.length >= VIEW_LIMITS.views) return { ok: false, reason: "full" };
  const name = cleanViewName(raw);
  if (!name) return { ok: false, reason: "empty" };
  if (name.length > VIEW_LIMITS.name) return { ok: false, reason: "long" };
  const k = name.toLowerCase();
  if (list.some((v) => v.name.toLowerCase() === k)) return { ok: false, reason: "taken" };
  const view: PrView = { id, name, filter: lanesFromRules(rules), order: list.length };
  return { ok: true, list: [...list, view], view };
}

export const newViewId = (): string => `pv${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
