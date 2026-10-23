/*
 * The orchestration policy on this machine: the stored rules read with the
 * base the app already holds, and written back split the same way.
 *
 * Not in config.ts because the base reads the seat, and the seat reads
 * config.ts. config.ts keeps the stored half (`readStoredPolicy`), this file
 * puts the two together.
 *
 * The base is read through, never copied: the worker roles ARE
 * `workerRoles()`, the chair's choice IS the seat's kind and model. Writing a
 * policy whose base differs writes through to those, so `/agents/roles` and
 * the seat answer the same before and after, and nobody has two places to
 * change one thing.
 */
import {
  composePolicy, defaultStored, ROLE_IDS, storedOf, validatePolicy,
  type EngineChoice, type Policy,
} from "../../shared/orchestration.ts";
import type { RoleId } from "../../shared/workerRoles.ts";
import { policyRoots, readStoredPolicy, workerRoles, writeStoredPolicy, writeWorkerRole } from "./config.ts";
import { defaultSeatModel, seatRow, setSeatSettings } from "./seat.ts";

/** What the app runs today, as engine and model, for one project. */
export function baseChoices(root?: string): { orchestrator: EngineChoice; workers: Record<RoleId, EngineChoice> } {
  const roles = workerRoles();
  const workers = {} as Record<RoleId, EngineChoice>;
  for (const id of ROLE_IDS) workers[id] = { engine: roles[id].provider, model: roles[id].model };
  const row = root ? seatRow(root) : null;
  // `||`, as openSeat reads it: a row written by the settings route carries ""
  // for "not chosen", and the chair still gets the cheap default.
  return { orchestrator: { engine: row?.kind || "claude", model: row?.model || defaultSeatModel() }, workers };
}

export interface PolicyView {
  policy: Policy;
  /** Which stored policy answered: the project's own, or the global one. */
  scope: "project" | "global";
  /** The root asked about, when there was one. */
  root?: string;
  /** Roots that carry their own policy. */
  overrides: string[];
}

/** The policy in force for a project: its override replaces the global one
 *  whole, and either falls back to the defaults when nothing is stored. */
export function readPolicy(root?: string): PolicyView {
  const own = root ? readStoredPolicy(root) : null;
  const stored = own ?? readStoredPolicy() ?? defaultStored();
  return {
    policy: composePolicy(stored, baseChoices(root)),
    scope: own ? "project" : "global",
    ...(root ? { root } : {}),
    overrides: policyRoots(),
  };
}

export type WriteResult = { ok: true; view: PolicyView } | { ok: false; error: string };

/**
 * Check a whole policy and store it. `root` absent writes the global one; a
 * project root writes that project's override, and `null` policy removes it.
 *
 * The base may change only where the app already has a place for it: a worker
 * role's engine and model (through `writeWorkerRole`, which refuses an engine
 * with no lock), and the chair's model for a project. The chair's ENGINE is
 * fixed until another engine can sit in it, and the base is one choice per
 * field, so a fallback chain is a rule.
 */
export function writePolicy(root: string | undefined, raw: unknown): WriteResult {
  if (raw === null) {
    if (!root) return { ok: false, error: "the global policy cannot be removed, only changed" };
    const r = writeStoredPolicy(root, null);
    return r.ok ? { ok: true, view: readPolicy(root) } : { ok: false, error: r.error ?? "could not write the policy" };
  }
  const v = validatePolicy(raw);
  if (!v.ok) return v;
  const p = v.value;
  const now = baseChoices(root);

  // Everything that can refuse does so before anything is written.
  for (const id of ROLE_IDS) {
    const chain = p.base.workers[id].value;
    if (chain.length !== 1) return { ok: false, error: `policy.base.workers.${id}.value: holds one choice; put a fallback chain in a rule` };
  }
  const chair = p.base.orchestrator.value;
  if (chair.length !== 1) return { ok: false, error: "policy.base.orchestrator.value: holds one choice; put a fallback chain in a rule" };
  const want = chair[0]!;
  if (want.engine !== now.orchestrator.engine) {
    return { ok: false, error: "policy.base.orchestrator.value: the chair's engine is set when the seat opens; another engine in the chair comes later" };
  }
  const chairModelChanged = want.model !== now.orchestrator.model;
  if (chairModelChanged && !root) {
    return { ok: false, error: "policy.base.orchestrator.value: the chair's model is a project's choice; set it on a project policy" };
  }
  const roleWrites: [RoleId, EngineChoice][] = [];
  for (const id of ROLE_IDS) {
    const c = p.base.workers[id].value[0]!;
    if (c.engine !== now.workers[id].engine || c.model !== now.workers[id].model) roleWrites.push([id, c]);
  }

  // A worker role is a global setting: a project policy that moves one would
  // move it for every project.
  if (root && roleWrites.length) {
    return { ok: false, error: `policy.base.workers.${roleWrites[0]![0]}.value: worker roles are global; change it on the global policy, or name it in a rule here` };
  }

  for (const [id, c] of roleWrites) {
    const w = writeWorkerRole(id, { provider: c.engine, model: c.model });
    if (!w.ok) return { ok: false, error: `policy.base.workers.${id}.value: ${w.error ?? "could not be saved"}` };
  }
  if (chairModelChanged && root) {
    const row = seatRow(root);
    setSeatSettings(root, want.model, row?.powers ?? "speak");
  }
  const w = writeStoredPolicy(root, storedOf(p));
  if (!w.ok) return { ok: false, error: w.error ?? "could not write the policy" };
  return { ok: true, view: readPolicy(root) };
}
