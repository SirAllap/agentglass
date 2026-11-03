// Edits to a LaneFilter, as pure functions: every one returns a new filter and
// refuses (returns the same object) what the limits in shared/prFilter.ts forbid.
import { VIEW_LIMITS, isGroup, type FilterGroup, type FilterNode, type FilterRule, type LaneFilter } from "../../../shared/prFilter.ts";
import { laneOfId, totalRules, type LaneName } from "./prFilterView.ts";

let seq = 0;
export const newNodeId = (): string => `n${Date.now().toString(36)}${(++seq).toString(36)}`;

const mapGroup = (g: FilterGroup, fn: (g: FilterGroup) => FilterGroup): FilterGroup => {
  const kids = g.children.map((c) => (isGroup(c) ? mapGroup(c, fn) : c));
  return fn({ ...g, children: kids });
};

const lane = (f: LaneFilter, l: LaneName): FilterGroup => (l === "show" ? f.show : f.hide);
const withLane = (f: LaneFilter, l: LaneName, g: FilterGroup): LaneFilter => (l === "show" ? { ...f, show: g } : { ...f, hide: g });

/** Groups below the lane that hold `id` (0 = it sits directly in the lane). */
function levelOf(g: FilterGroup, id: string, level = 0): number {
  if (g.id === id) return level;
  for (const c of g.children) {
    if (c.id === id) return level + (isGroup(c) ? 1 : 0);
    if (isGroup(c)) { const r = levelOf(c, id, level + 1); if (r >= 0) return r; }
  }
  return -1;
}

export function addRule(f: LaneFilter, to: LaneName | string, rule: FilterRule): LaneFilter {
  if (totalRules(f) >= VIEW_LIMITS.rules) return f;
  const l = to === "show" || to === "hide" ? to : laneOfId(f, to);
  if (!l) return f;
  const target = to === "show" || to === "hide" ? lane(f, l).id : to;
  return withLane(f, l, mapGroup(lane(f, l), (g) => (g.id === target ? { ...g, children: [...g.children, rule] } : g)));
}

/** A group at `to` (a lane name or a group id). Refused past VIEW_LIMITS.depth. */
export function addGroup(f: LaneFilter, to: LaneName | string, group: FilterGroup): LaneFilter {
  const l = to === "show" || to === "hide" ? to : laneOfId(f, to);
  if (!l) return f;
  const target = to === "show" || to === "hide" ? lane(f, l).id : to;
  const at = levelOf(lane(f, l), target);
  if (at < 0 || at + 1 > VIEW_LIMITS.depth) return f;
  return withLane(f, l, mapGroup(lane(f, l), (g) => (g.id === target ? { ...g, children: [...g.children, group] } : g)));
}

/** The deepest a group added at `to` can sit, so the editor can grey out "+ Group". */
export function canAddGroup(f: LaneFilter, to: LaneName | string): boolean {
  const l = to === "show" || to === "hide" ? to : laneOfId(f, to);
  if (!l) return false;
  const target = to === "show" || to === "hide" ? lane(f, l).id : to;
  const at = levelOf(lane(f, l), target);
  return at >= 0 && at + 1 <= VIEW_LIMITS.depth;
}

export function removeNode(f: LaneFilter, id: string): LaneFilter {
  const l = laneOfId(f, id);
  if (!l || id === lane(f, l).id) return f;
  return withLane(f, l, mapGroup(lane(f, l), (g) => ({ ...g, children: g.children.filter((c) => c.id !== id) })));
}

export function updateRule(f: LaneFilter, id: string, patch: Partial<Omit<FilterRule, "id">>): LaneFilter {
  const l = laneOfId(f, id);
  if (!l) return f;
  return withLane(f, l, mapGroup(lane(f, l), (g) => ({
    ...g, children: g.children.map((c) => (c.id === id && !isGroup(c) ? { ...c, ...patch } : c)),
  })));
}

export function setJoin(f: LaneFilter, groupId: string, join: "and" | "or"): LaneFilter {
  const l = laneOfId(f, groupId);
  if (!l) return f;
  return withLane(f, l, mapGroup(lane(f, l), (g) => (g.id === groupId ? { ...g, join } : g)));
}

/** A top-level rule or group to the other lane. Nested nodes stay where they are. */
export function moveToLane(f: LaneFilter, id: string, to: LaneName): LaneFilter {
  const from = laneOfId(f, id);
  if (!from || from === to) return f;
  const node = lane(f, from).children.find((c) => c.id === id);
  if (!node) return f;
  const removed = withLane(f, from, { ...lane(f, from), children: lane(f, from).children.filter((c) => c.id !== id) });
  return withLane(removed, to, { ...lane(removed, to), children: [...lane(removed, to).children, node] });
}

/** Typed rules land in the lane the text named. Refused (unchanged) past the rule limit. */
export function addParsed(f: LaneFilter, add: { lane: LaneName; node: FilterNode }[]): LaneFilter {
  let out = f;
  for (const a of add) {
    const next = isGroup(a.node) ? addGroup(out, a.lane, a.node) : addRule(out, a.lane, a.node);
    out = next;
  }
  return out;
}

/** Drop rules with nothing to say (a value-taking op with no value). The deck never keeps one. */
export function withoutInert(f: LaneFilter): LaneFilter {
  const live = (n: FilterNode): boolean => isGroup(n) || n.op === "set" || n.op === "unset" || n.values.length > 0;
  const strip = (g: FilterGroup): FilterGroup => ({ ...g, children: g.children.filter(live).map((c) => (isGroup(c) ? strip(c) : c)) });
  return { show: strip(f.show), hide: strip(f.hide) };
}

/** An edited rule back in place: same lane updates it where it stands, another lane moves it. */
export function replaceRule(f: LaneFilter, lane: LaneName, rule: FilterRule): LaneFilter {
  if (laneOfId(f, rule.id) === lane) return updateRule(f, rule.id, { field: rule.field, op: rule.op, values: rule.values });
  return addRule(removeNode(f, rule.id), lane, rule);
}
