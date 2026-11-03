// The pull request board's filter, as data: two lanes of rules and groups.
//
// A PR is kept iff it passes `show` and does not match `hide`. Shared because
// the server stores and validates views, the panel evaluates them, and the
// agent door reads and writes them, and the three must not disagree on shape.
//
// Depth counts groups below the lane: `show` itself is level 0, a group in it
// is level 1, and VIEW_LIMITS.depth (3) is the deepest allowed.
export type FilterOp = "is" | "not" | "set" | "unset" | "contains" | "matches" | "lt" | "gt";
export type FilterRule = { id: string; field: string; op: FilterOp; values: string[] };
export type FilterGroup = { id: string; kind: "group"; join: "and" | "or"; children: FilterNode[] };
export type FilterNode = FilterRule | FilterGroup;
/** Board filter: keep a PR iff it passes `show` and does not match `hide`. */
export type LaneFilter = { show: FilterGroup; hide: FilterGroup };
export type PrView = { id: string; name: string; filter: LaneFilter; order: number };

export const VIEW_LIMITS = { views: 12, name: 24, depth: 3, rules: 40, pattern: 200 };

const OPS = new Set<string>(["is", "not", "set", "unset", "contains", "matches", "lt", "gt"]);
const NO_VALUES = new Set<string>(["set", "unset"]);

export const isGroup = (n: FilterNode): n is FilterGroup => (n as FilterGroup).kind === "group";

export function emptyLanes(): LaneFilter {
  return {
    show: { id: "show", kind: "group", join: "and", children: [] },
    hide: { id: "hide", kind: "group", join: "or", children: [] },
  };
}

type Walk = { rules: number; ids: Set<string> };

function validateNode(x: unknown, depth: number, w: Walk): FilterNode | string {
  if (!x || typeof x !== "object") return "a rule must be an object";
  const o = x as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id) return "every rule and group needs an id";
  if (w.ids.has(o.id)) return `duplicate id "${o.id}"`;
  w.ids.add(o.id);
  if (o.kind === "group") {
    if (depth > VIEW_LIMITS.depth) return `groups nest at most ${VIEW_LIMITS.depth} deep`;
    if (o.join !== "and" && o.join !== "or") return "a group joins with and/or";
    if (!Array.isArray(o.children)) return "a group needs children";
    const children: FilterNode[] = [];
    for (const c of o.children) {
      const r = validateNode(c, depth + 1, w);
      if (typeof r === "string") return r;
      children.push(r);
    }
    return { id: o.id, kind: "group", join: o.join, children };
  }
  if (++w.rules > VIEW_LIMITS.rules) return `at most ${VIEW_LIMITS.rules} rules`;
  if (typeof o.field !== "string" || !o.field) return "a rule needs a field";
  if (typeof o.op !== "string" || !OPS.has(o.op)) return `unknown operator "${String(o.op)}"`;
  if (!Array.isArray(o.values) || o.values.some((v) => typeof v !== "string")) return "rule values must be strings";
  const values = o.values as string[];
  if (values.some((v) => v.length > VIEW_LIMITS.pattern)) return `a value is at most ${VIEW_LIMITS.pattern} characters`;
  if (o.op === "matches") {
    for (const v of values) {
      try { new RegExp(v, "i"); } catch { return `"${v}" is not a valid pattern`; }
    }
  }
  return { id: o.id, field: o.field, op: o.op as FilterOp, values };
}

function validateLane(x: unknown, w: Walk): FilterGroup | string {
  const r = validateNode(x, 0, w);
  if (typeof r === "string") return r;
  return isGroup(r) ? r : "a lane must be a group";
}

export function validateLaneFilter(x: unknown): LaneFilter | string {
  if (!x || typeof x !== "object") return "a filter must be an object";
  const o = x as Record<string, unknown>;
  const w: Walk = { rules: 0, ids: new Set() };
  const show = validateLane(o.show, w);
  if (typeof show === "string") return show;
  const hide = validateLane(o.hide, w);
  if (typeof hide === "string") return hide;
  return { show, hide };
}

export function validateViews(x: unknown): PrView[] | string {
  if (!Array.isArray(x)) return "views must be a list";
  if (x.length > VIEW_LIMITS.views) return `at most ${VIEW_LIMITS.views} views`;
  const out: PrView[] = [];
  const ids = new Set<string>();
  for (const v of x) {
    if (!v || typeof v !== "object") return "a view must be an object";
    const o = v as Record<string, unknown>;
    if (typeof o.id !== "string" || !o.id) return "a view needs an id";
    if (ids.has(o.id)) return `duplicate view id "${o.id}"`;
    ids.add(o.id);
    const name = typeof o.name === "string" ? o.name.trim() : "";
    if (!name) return "a view needs a name";
    if (name.length > VIEW_LIMITS.name) return `a view name is at most ${VIEW_LIMITS.name} characters`;
    if (typeof o.order !== "number" || !Number.isFinite(o.order)) return "a view needs an order";
    const filter = validateLaneFilter(o.filter);
    if (typeof filter === "string") return filter;
    out.push({ id: o.id, name, filter, order: o.order });
  }
  return out;
}

/**
 * Old flat preset/rules → lanes, keeping the same PRs.
 *
 * AND set: a rule that only says what to drop (`not`, `unset`) goes to `hide`
 * as its mirror (`is`, `set`); the rest stay in `show`. OR set: one rule
 * passing is enough, so there is no way to split it and the whole set stays in
 * `show` with join "or", ops untouched. A rule still being written (no values
 * on an op that needs them) filtered nothing before and is dropped here.
 */
export function lanesFromFlat(
  join: "and" | "or",
  rules: { field: string; op: string; values: string[] }[],
): LaneFilter {
  const lanes = emptyLanes();
  let n = 0;
  for (const r of rules) {
    if (!r.field || !OPS.has(r.op)) continue;
    if (!NO_VALUES.has(r.op) && !r.values.length) continue;
    const id = `r${++n}`;
    const op = r.op as FilterOp;
    if (join === "or") lanes.show.children.push({ id, field: r.field, op, values: [...r.values] });
    else if (op === "not") lanes.hide.children.push({ id, field: r.field, op: "is", values: [...r.values] });
    else if (op === "unset") lanes.hide.children.push({ id, field: r.field, op: "set", values: [] });
    else lanes.show.children.push({ id, field: r.field, op, values: [...r.values] });
  }
  if (join === "or") lanes.show.join = "or";
  return lanes;
}
