/*
 * Edits of a Flow value, and nothing else: every function takes a flow and
 * returns a new one that `validateFlow` would still accept. The canvas calls
 * these; no screen keeps a list of its own, so what is drawn is what is saved.
 *
 * Two rules every edit ends on (`settle`):
 *  - the passing arrows are the path itself, one per neighbouring pair, so a
 *    step inserted, removed or moved never leaves an arrow pointing at a
 *    neighbour it no longer has;
 *  - a failing arrow stays only while both its ends are still on the path, and
 *    a role that left the path is no longer required (a step nobody runs cannot
 *    be a hard rule).
 *
 * Its ceiling, stated: one failing arrow per step and target pair, and a
 * failing arrow only goes back (to an earlier step). Branches that jump forward
 * are the next thing after this and are not here.
 */
import { FLOW_MAX_ROLES, FLOW_ROUNDS_MAX, roleById, type Flow, type FlowEdge, type FlowRole } from "../../../shared/flow.ts";

const copy = (flow: Flow): Flow => ({
  ...flow,
  path: [...flow.path],
  blocks: flow.blocks.map((b) => ({ ...b })),
  roster: flow.roster.map((r) => ({ ...r, chain: [...r.chain], tools: [...r.tools] })),
  stages: flow.stages.map((s) => ({ ...s })),
  edges: flow.edges.map((e) => ({ ...e })),
});

/** Passing arrows from the path, failing arrows kept only while they still go back along it. */
function settle(flow: Flow, pathChanged: boolean): Flow {
  const at = (id: string) => flow.path.indexOf(id);
  const fails = flow.edges.filter((e) => e.on === "fail" && at(e.from) >= 0 && at(e.to) >= 0 && at(e.to) < at(e.from));
  const passes: FlowEdge[] = [];
  for (let i = 0; i < flow.path.length - 1; i++) passes.push({ from: flow.path[i]!, to: flow.path[i + 1]!, on: "pass" });
  flow.edges = [...passes, ...fails];
  for (const r of flow.roster) if (r.required && at(r.id) < 0) r.required = false;
  // A path that changed is laid out again by the screen; a path that did not keeps where a person put each block.
  flow.blocks = pathChanged ? [] : flow.blocks.filter((b) => at(b.id) >= 0);
  return flow;
}

/** An id no role of the team has, from a name: `QA sign-off` → `qa-sign-off`, then `-2`, `-3`. */
export function freshRoleId(flow: Flow, name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36) || "role";
  if (!roleById(flow, base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (!roleById(flow, id)) return id;
  }
}

export type Added = { ok: true; flow: Flow } | { ok: false; error: string };

/**
 * Add a role to the team. With `index` it also goes on the path at that place
 * (0 = first); without it the role is only in the team, off the path.
 */
export function addRole(flow: Flow, role: FlowRole, index?: number): Added {
  if (flow.roster.length >= FLOW_MAX_ROLES) return { ok: false, error: `The team takes at most ${FLOW_MAX_ROLES} roles.` };
  if (roleById(flow, role.id)) return { ok: false, error: "Another role already has that id." };
  const next = copy(flow);
  next.roster.push({ ...role, chain: [...role.chain], tools: [...role.tools], required: index === undefined ? false : role.required });
  if (index === undefined) return { ok: true, flow: next };
  next.path.splice(Math.max(0, Math.min(index, next.path.length)), 0, role.id);
  return { ok: true, flow: settle(next, true) };
}

/** Put a role the team already has on the path at `index`. A role already on it moves. */
export function placeOnPath(flow: Flow, id: string, index: number): Flow {
  if (!roleById(flow, id)) return flow;
  const next = copy(flow);
  const was = next.path.indexOf(id);
  if (was >= 0) next.path.splice(was, 1);
  const to = Math.max(0, Math.min(was >= 0 && was < index ? index - 1 : index, next.path.length));
  next.path.splice(to, 0, id);
  return settle(next, true);
}

/** Reorder: the same as placing, said as what a drag does. `toIndex` is where it lands in the new list. */
export function movePath(flow: Flow, id: string, toIndex: number): Flow {
  if (flow.path.indexOf(id) < 0) return flow;
  const next = copy(flow);
  next.path.splice(next.path.indexOf(id), 1);
  next.path.splice(Math.max(0, Math.min(toIndex, next.path.length)), 0, id);
  return settle(next, true);
}

/** Take a role off the path. The last step cannot go: a flow with no path is refused by the data. */
export function removeFromPath(flow: Flow, id: string): Flow {
  if (flow.path.indexOf(id) < 0 || flow.path.length < 2) return flow;
  const next = copy(flow);
  next.path = next.path.filter((p) => p !== id);
  return settle(next, true);
}

/** Take a role out of the team: off the path, out of the roster. */
export function removeRole(flow: Flow, id: string): Flow {
  if (!roleById(flow, id)) return flow;
  const onPath = flow.path.includes(id);
  if (onPath && flow.path.length < 2) return flow;
  const next = copy(flow);
  next.roster = next.roster.filter((r) => r.id !== id);
  next.path = next.path.filter((p) => p !== id);
  return settle(next, true);
}

/** Replace one role's fields (name, prompt, chain, tools, reads-only, required…). The id stays. */
export function updateRole(flow: Flow, id: string, patch: Partial<Omit<FlowRole, "id">>): Flow {
  if (!roleById(flow, id)) return flow;
  const next = copy(flow);
  const i = next.roster.findIndex((r) => r.id === id);
  next.roster[i] = { ...next.roster[i]!, ...patch, id };
  return settle(next, false);
}

/** Required is a property of the role; it only takes while the role is on the path. */
export function setRequired(flow: Flow, id: string, required: boolean): Flow {
  if (required && !flow.path.includes(id)) return flow;
  return updateRole(flow, id, { required });
}

/**
 * A failing arrow from `from` back to `to`, with its cap. Replaces the step's
 * earlier failing arrow: a step has one way back. `to` has to be earlier on the
 * path, and the cap is clamped to what the data allows.
 */
export function setFail(flow: Flow, from: string, to: string, maxRounds: number): Flow {
  const a = flow.path.indexOf(from), b = flow.path.indexOf(to);
  if (a < 0 || b < 0 || b >= a) return flow;
  const next = copy(flow);
  next.edges = next.edges.filter((e) => !(e.on === "fail" && e.from === from));
  next.edges.push({ from, to, on: "fail", maxRounds: Math.max(1, Math.min(FLOW_ROUNDS_MAX, Math.round(maxRounds) || 1)) });
  return settle(next, false);
}

/** Take a step's failing arrow away: when it fails, the person is asked. */
export function clearFail(flow: Flow, from: string): Flow {
  const next = copy(flow);
  next.edges = next.edges.filter((e) => !(e.on === "fail" && e.from === from));
  return settle(next, false);
}

/** Where a person dropped a block. Whole numbers, never negative. */
export function moveBlock(flow: Flow, id: string, x: number, y: number): Flow {
  if (!flow.path.includes(id)) return flow;
  const next = copy(flow);
  const spot = { id, x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)) };
  const i = next.blocks.findIndex((b) => b.id === id);
  if (i >= 0) next.blocks[i] = spot;
  else next.blocks.push(spot);
  return next;
}

/** The failing arrow a step has, if any. */
export const failOf = (flow: Flow, id: string): FlowEdge | undefined => flow.edges.find((e) => e.on === "fail" && e.from === id);

/** What the top bar counts: blocks on the path, stages they sit in, roles in the team. */
export function flowCounts(flow: Flow): { blocks: number; stages: number; team: number } {
  const stages = new Set(flow.path.map((id) => roleById(flow, id)?.stage));
  return { blocks: flow.path.length, stages: stages.size, team: flow.roster.length };
}

/**
 * Where "Add a block" puts a new step when nobody picked a gap: the end of the
 * path, but before a step a person answers, because that one stays last.
 */
export function endIndex(flow: Flow): number {
  const last = roleById(flow, flow.path[flow.path.length - 1] ?? "");
  return last?.actor === "person" ? flow.path.length - 1 : flow.path.length;
}
