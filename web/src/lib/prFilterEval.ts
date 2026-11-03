// Evaluates a LaneFilter over rows: keep a row iff it passes `show` and does
// not match `hide`, and say which top-level child of which lane hid each one.
// (prLanes.ts is the triage board's lanes; this is the filter's.)
//
// A rule still being written (no values on an op that needs them) is inert: it
// neither keeps nor hides, the same rule the tasks board's `passes` follows.
// A lane with nothing live in it shows everything (show) or hides nothing
// (hide).
//
// Culprit, in reading order: show first, then hide. In a lane joined "and"
// (show) or "or" (hide) the culprit is the first top-level child that decides
// it. In the other joins (show "or", hide "and") no single child is to blame,
// so the lane's own group id takes the credit. A nested group is one child.
import type { FilterGroup, FilterNode, FilterRule, LaneFilter } from "../../../shared/prFilter.ts";
import { isGroup } from "../../../shared/prFilter.ts";
import type { ReadField } from "../components/tasks/filters.ts";

export type LaneResult<T> = {
  kept: T[];
  culprit: Map<T, string>;
  /** rule/group id -> rows it hid; the values sum to rows.length - kept.length. */
  hiddenBy: Map<string, number>;
};

const regexes = new Map<string, RegExp | null>();
function re(src: string): RegExp | null {
  let r = regexes.get(src);
  if (r === undefined) {
    try { r = new RegExp(src, "i"); } catch { r = null; }
    if (regexes.size > 200) regexes.clear();
    regexes.set(src, r);
  }
  return r;
}

/** true/false, or null when the rule is not live yet. */
function evalRule<T>(row: T, r: FilterRule, read: ReadField<T>): boolean | null {
  if (!r.field) return null;
  const mine = read(row, r.field);
  if (r.op === "set") return mine.length > 0;
  if (r.op === "unset") return mine.length === 0;
  if (!r.values.length) return null;
  // Card ids are typed in either case; every other value is compared as given.
  const norm = r.field === "card" ? (s: string) => s.toLowerCase() : (s: string) => s;
  const has = () => mine.some((m) => r.values.some((v) => norm(v) === norm(m)));
  switch (r.op) {
    case "is": return has();
    case "not": return !has();
    case "contains": return r.values.some((v) => mine.some((m) => m.toLowerCase().includes(v.toLowerCase())));
    case "matches": return r.values.some((v) => { const x = re(v); return !!x && mine.some((m) => x.test(m)); });
    case "lt": case "gt": {
      const n = Number(mine[0]);
      const lim = Number(r.values[0]);
      if (mine[0] === undefined || Number.isNaN(n) || Number.isNaN(lim)) return false;
      return r.op === "lt" ? n < lim : n > lim;
    }
  }
}

function evalNode<T>(row: T, n: FilterNode, read: ReadField<T>): boolean | null {
  if (!isGroup(n)) return evalRule(row, n, read);
  const live = n.children.map((c) => evalNode(row, c, read)).filter((x): x is boolean => x !== null);
  if (!live.length) return null;
  return n.join === "or" ? live.some(Boolean) : live.every(Boolean);
}

/** Id to credit when the lane's live children come out as `want` (show: false, hide: true). */
function blame<T>(row: T, lane: FilterGroup, want: boolean, firstWins: boolean, read: ReadField<T>): string | null {
  const verdicts = lane.children.map((c) => [c, evalNode(row, c, read)] as const).filter(([, v]) => v !== null);
  if (!verdicts.length) return null;
  if (firstWins) return verdicts.find(([, v]) => v === want)?.[0].id ?? null;
  return verdicts.every(([, v]) => v === want) ? lane.id : null;
}

export function evalLanes<T>(rows: T[], filter: LaneFilter, read: ReadField<T>): LaneResult<T> {
  const kept: T[] = [];
  const culprit = new Map<T, string>();
  const hiddenBy = new Map<string, number>();
  for (const row of rows) {
    const id =
      blame(row, filter.show, false, filter.show.join === "and", read)
      ?? blame(row, filter.hide, true, filter.hide.join === "or", read);
    if (id === null) { kept.push(row); continue; }
    culprit.set(row, id);
    hiddenBy.set(id, (hiddenBy.get(id) ?? 0) + 1);
  }
  return { kept, culprit, hiddenBy };
}
