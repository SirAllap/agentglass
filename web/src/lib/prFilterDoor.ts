/*
 * What the agent doors `pr.filter.*` and `pr.views.*` do in this window.
 *
 * Each goes through the seam the board itself uses (prBoardFilterStore for the
 * live filter, prViewsStore for the saved views), so an agent's change and a
 * click cannot mean different things, and the panel repaints from the store
 * without knowing who wrote. A refusal throws: controlReply answers it as
 * `{ok:false, applied:false, error}`, which is how a filter line that does not
 * parse is returned to the caller with nothing applied.
 *
 * The filter travels as the one-line text syntax (prFilterSyntax.ts), the same
 * a person types into the board's input. The ceiling: text cannot say everything
 * a tree can (a rule inside a group inside a group is written with parentheses
 * and flips only facets), and a view saved from text is as expressive as that.
 */
import { emptyLanes, type LaneFilter } from "../../../shared/prFilter.ts";
import { checkName } from "./filterPresets.ts";
import { getPrFilter, setPrFilter } from "./prBoardFilterStore.ts";
import { lanesToText, parseRuleText } from "./prFilterSyntax.ts";
import { activeViewId, addView, commitViews, loadViews, removeView, updateView, viewsState } from "./prViewsStore.ts";

/** Text in the board's syntax as lanes; the parser's own sentence when it does not parse. */
export function lanesFromText(text: string): LaneFilter {
  const r = parseRuleText(text);
  if ("error" in r) throw new Error(r.error);
  const f = emptyLanes();
  for (const { lane, node } of r.add) f[lane].children.push(node);
  return f;
}

export const filterGet = (repo: string) => ({ repo, text: lanesToText(getPrFilter(repo)) });

export function filterSet(repo: string, a: { text?: string; clear?: boolean }) {
  const next = a.clear ? emptyLanes() : lanesFromText(a.text ?? "");
  const why = setPrFilter(repo, next);
  if (why) throw new Error(why);
  return { repo, text: lanesToText(next) };
}

export async function viewsList(repo: string) {
  await loadViews(repo);
  const on = activeViewId(repo);
  return { repo, views: viewsState(repo).views.map((v) => ({ name: v.name, text: lanesToText(v.filter), active: v.id === on })) };
}

const idOf = () => `pv${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const sameName = (a: string, b: string) => a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();
const FAILS = { empty: "give the view a name", long: "a view name is at most 24 characters", taken: "that name is taken", full: "at most 12 views: delete one first", missing: "no view has that name" } as const;

/** Save under `name`: a view of that name is replaced, else one is added. The filter is `text`, or the board's live one. */
export async function viewsSave(repo: string, name: string, text?: string) {
  const filter = text === undefined ? getPrFilter(repo) : lanesFromText(text);
  await loadViews(repo);
  const list = viewsState(repo).views;
  const at = list.find((v) => sameName(v.name, name));
  const n = checkName(name, list, at?.id);
  if (!n.ok) throw new Error(FAILS[n.reason]);
  const r = at ? updateView(list, at.id, filter) : addView(list, n.name, filter, idOf());
  if (!r.ok) throw new Error(FAILS[r.reason]);
  const err = await commitViews(repo, r.list);
  if (err) throw new Error(err);
  return { repo, name: r.view.name, text: lanesToText(r.view.filter), replaced: !!at };
}

export async function viewsDelete(repo: string, name: string) {
  await loadViews(repo);
  const at = viewsState(repo).views.find((v) => sameName(v.name, name));
  const d = at && removeView(viewsState(repo).views, at.id);
  if (!d) throw new Error(FAILS.missing);
  const err = await commitViews(repo, d.list);
  if (err) throw new Error(err);
  return { repo, deleted: d.removed.view.name };
}
