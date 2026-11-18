/*
 * The rules of moving a step and adding your own, and nothing that draws.
 * The list view, the keyboard and the "Add a step" sheet ask these; the edits
 * themselves are `flowEdit.ts`, so a drop here saves what the canvas would.
 *
 * The two fixed places: the asker ("You") is always first and is not a step of
 * the path, so nothing can be dropped before it; the gate, the step a person
 * answers (`actor: "person"`) when it is last on the path, is always last, so
 * nothing goes after it and it cannot leave that place. A required step can
 * move but not be taken off the path.
 *
 * A slot is a place in the path as it would be with the moved step lifted out:
 * `index` 0 puts it first, `index` = length puts it last. That is the
 * `toIndex` `movePath` takes.
 *
 * Its ceiling, stated: one gate, the last person-step. A person-step in the
 * middle of the path is an ordinary step and moves freely.
 */
import { FLOW_MAX_ROLES, FLOW_NAME_MAX, gatePathWhy, roleById, type Flow, type FlowRole } from "../../../shared/flow.ts";
import { looksLikeSecret } from "../../../shared/orchestration.ts";
import { addRole, freshRoleId, movePath, removeFromPath } from "./flowEdit.ts";

/** The id of the gate: the last step on the path, when a person answers it. */
export function gateId(flow: Flow): string | null {
  const last = flow.path[flow.path.length - 1];
  return last && roleById(flow, last)?.actor === "person" ? last : null;
}

export interface Slot {
  index: number;
  ok: boolean;
  /** Plain words, only when refused. */
  why?: string;
}

/** Why a step cannot be picked up at all, or null. */
export function lockedWhy(flow: Flow, id: string): string | null {
  if (flow.path.indexOf(id) < 0) return "It is not on the path.";
  return id === gateId(flow) ? "Always last: no rule can switch it off." : null;
}

/** Every place a step could be dropped, each marked allowed or refused with the reason. A locked or missing step has none. */
export function dropSlots(flow: Flow, id: string): Slot[] {
  if (lockedWhy(flow, id)) return [];
  const rest = flow.path.filter((p) => p !== id);
  const gate = gateId(flow);
  const slots: Slot[] = [];
  for (let i = 0; i <= rest.length; i++) {
    if (gate && i === rest.length) slots.push({ index: i, ok: false, why: "Not here: the Gate is always last. Nothing can go after it." });
    else slots.push({ index: i, ok: true });
  }
  return slots;
}

export type Moved = { ok: true; flow: Flow } | { ok: false; error: string };

/** The flow after a drop at `index`, or the reason it is refused. A drop where the step already is changes nothing and is ok. */
export function moveTo(flow: Flow, id: string, index: number): Moved {
  const locked = lockedWhy(flow, id);
  if (locked) return { ok: false, error: locked };
  const slot = dropSlots(flow, id).find((s) => s.index === index);
  if (!slot) return { ok: false, error: "There is no such place on the path." };
  if (!slot.ok) return { ok: false, error: slot.why ?? "Not here." };
  return { ok: true, flow: movePath(flow, id, index) };
}

export interface Box { left: number; top: number; width: number; height: number }

/**
 * Where the floating card of a dragged row is drawn: the row's own column and
 * size, its top following the pointer (kept at the same grab point on the
 * card), never above the first row or below the last of the list.
 */
export function floatBox(row: Box, pointerY: number, grabDy: number, list: { top: number; bottom: number }): Box {
  const top = Math.min(Math.max(pointerY - grabDy, list.top), Math.max(list.top, list.bottom - row.height));
  return { left: row.left, top, width: row.width, height: row.height };
}

/** A path change made by the Board or the Canvas, held to the same Gate rule the server and the List use. */
export function checkPath(next: Flow, was?: Flow): Moved {
  const why = gatePathWhy(next.path, was?.path);
  return why ? { ok: false, error: `Not here: ${why}.` } : { ok: true, flow: next };
}

/**
 * The place a pointer at `y` means, from the midpoints of the other rows as
 * they were when the drag began: the drop slot shifts the live rows, so
 * measuring them while it is on screen makes the slot jump back and forth.
 */
export function slotFromMids(mids: readonly number[], y: number): number {
  let at = 0;
  mids.forEach((m, i) => { if (y > m) at = i + 1; });
  return at;
}

/** Where one allowed step earlier (-1) or later (+1) puts a step, for the keyboard; null at the end of the road. */
export function keyTarget(flow: Flow, id: string, dir: -1 | 1): number | null {
  const at = flow.path.indexOf(id);
  if (at < 0) return null;
  const to = at + dir;
  const slot = dropSlots(flow, id).find((s) => s.index === to);
  return slot?.ok ? to : null;
}

/** Whether a step can be taken off the path, and if not, why. Required steps stay; the last step cannot go. */
export function removeWhy(flow: Flow, id: string): string | null {
  const role = roleById(flow, id);
  if (!role || flow.path.indexOf(id) < 0) return "It is not on the path.";
  // The Gate first: a required Gate cannot move, so "it can move" would be false for it.
  if (id === gateId(flow)) return "Always last: no rule can switch it off.";
  if (role.required) return "Required: it can move, not be deleted.";
  if (flow.path.length < 2) return "The last step cannot go.";
  return null;
}

/** Take a step off the path unless `removeWhy` says no. */
export function removeStep(flow: Flow, id: string): Moved {
  const why = removeWhy(flow, id);
  return why ? { ok: false, error: why } : { ok: true, flow: removeFromPath(flow, id) };
}

export interface StepDraft {
  name: string;
  /** The role of the team whose engine and rules the step brings. */
  roleId: string;
  required: boolean;
  /** The step it comes after; `null` puts it first. */
  after: string | null;
}

export interface DraftCheck {
  /** Set only for the field that is wrong. */
  name?: string;
  role?: string;
  after?: string;
  /** The sheet cannot save while this is set. */
  full?: string;
  ok: boolean;
}

/** Says what is wrong with a draft, in plain words and per field; the sheet keeps the Add button off until `ok`. */
export function checkDraft(flow: Flow, d: StepDraft): DraftCheck {
  const out: DraftCheck = { ok: true };
  const name = d.name.trim();
  if (!name) out.name = "Give the step a name.";
  else if (name.length > FLOW_NAME_MAX) out.name = `Too long: ${FLOW_NAME_MAX} characters at most. It shows in one line on the flow.`;
  else if (looksLikeSecret(name)) out.name = "That looks like a key. A step name is a label, not a secret.";
  else if (!/^[A-Za-z0-9][A-Za-z0-9 ._:/'()+·-]*$/.test(name)) out.name = "Letters, digits, spaces and . _ : / ' ( ) · + - only.";
  if (!roleById(flow, d.roleId)) out.role = "Pick who does this step.";
  if (d.after !== null && flow.path.indexOf(d.after) < 0) out.after = "Pick a step on the path.";
  else if (d.after !== null && d.after === gateId(flow)) out.after = "Not after the Gate: it is always last.";
  if (flow.roster.length >= FLOW_MAX_ROLES) out.full = `The team is full: ${FLOW_MAX_ROLES} roles at most. Delete one first.`;
  out.ok = !out.name && !out.role && !out.after && !out.full;
  return out;
}

/** The draft a sheet opens with when nothing was typed: the builder's role, not required, after the last step before the gate. */
export function freshDraft(flow: Flow): StepDraft {
  const gate = gateId(flow);
  const last = [...flow.path].reverse().find((id) => id !== gate) ?? null;
  return { name: "", roleId: flow.roster.find((r) => r.policyRole === "builder")?.id ?? flow.roster[0]?.id ?? "", required: false, after: last };
}

/**
 * The draft again after a trip to the worker editor: what was typed stays;
 * the role just made (if any) is picked; a place that no longer fits falls
 * back to the default one.
 */
export function resumeDraft(flow: Flow, d: StepDraft, madeRoleId?: string | null): StepDraft {
  const roleId = madeRoleId && roleById(flow, madeRoleId) ? madeRoleId : d.roleId;
  const after = d.after === null || (flow.path.indexOf(d.after) >= 0 && d.after !== gateId(flow)) ? d.after : freshDraft(flow).after;
  return { ...d, roleId, after };
}

/** The slot a draft's "comes after" means: 0 for the front, else just behind that step. */
export function draftIndex(flow: Flow, after: string | null): number {
  return after === null ? 0 : flow.path.indexOf(after) + 1;
}

/**
 * Add a step of your own: a new role in the team, named as typed, that brings
 * the picked role's engine and rules, put on the path where the draft says.
 * Refused with the draft's first reason when it is not ok.
 */
export function addStep(flow: Flow, d: StepDraft): Moved {
  const c = checkDraft(flow, d);
  if (!c.ok) return { ok: false, error: c.name ?? c.role ?? c.after ?? c.full ?? "The step is not ready." };
  const base = roleById(flow, d.roleId) as FlowRole;
  const name = d.name.trim();
  const role: FlowRole = {
    ...base, chain: [...base.chain], tools: [...base.tools], allow: base.allow ? [...base.allow] : undefined,
    id: freshRoleId(flow, name), name, does: "Your own step", required: d.required,
  };
  if (!role.allow) delete role.allow;
  delete role.resolvedChain;
  return addRole(flow, role, draftIndex(flow, d.after));
}
