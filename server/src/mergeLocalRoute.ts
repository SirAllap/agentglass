/*
 * POST /flight-plan/plans/:id/merge-local: merges a launched plan's branch into the local base branch
 * when the flow's gates pass and the server's own review of the diff has no blocker. Never pushes.
 * index.ts routes to this and answers what it returns. Handler order, first match answers:
 *   1 launched plan only   2 a worker is refused   3 an override from a non-person is refused
 *   4 only the person or the project's assign seat   5 base and branch rules, with recovery
 *   6 seat limits, the flow's gates (integrateGate), the person's intent row
 *   7 the sign-off (signoff.ts)   8 repo checks   9 the per-repo lock   10 intent row, merge, finish
 */
import * as FlightPlan from "./flightPlan.ts";
import * as Store from "./flightPlanStore.ts";
import * as Local from "./localMerge.ts";
import { personSignoff, signoffFor } from "./signoff.ts";

export interface MergeCaller { kind: "person" | "seat" | "worker" | "other"; powers?: string; name: string }
export interface MergeAnswer { status: number; body: Record<string, unknown> }
const refuse = (status: number, error: string, extra: Record<string, unknown> = {}): MergeAnswer => ({ status, body: { ok: false, error, ...extra } });

/** Recovery for the plan's one row left at 0 (a crash, or a shell merge after a refused try). Returns the answer when the branch is now in base. */
function recover(plan: Store.Plan, base: string, root: string): MergeAnswer | null {
  const row = Store.openMerge(plan.id);
  if (!row) return null;
  if (!row.tip || !Local.isAncestor(root, row.tip, `refs/heads/${base}`)) { Store.settleMerge(row.id, 3); return null; }
  const found = row.baseBefore && row.branch ? Local.findMergeCommit(root, base, row.baseBefore, Local.mergeSubject(row.branch, plan.id)) : null;
  if (found) { Store.finishMerge(row.id, plan.id, found); return { status: 200, body: { ok: true, state: "already-merged", sha: found, mergedBy: "this-verb" } }; }
  Store.settleMerge(row.id, 2);
  Store.markLanded(plan.id);
  return { status: 200, body: { ok: true, state: "already-merged", mergedBy: "other-means" } };
}

/** Plans with a merge in flight: the gate await below lets a second request in, so it is turned away rather than run on the already-merged base. */
const inFlight = new Set<string>();

export async function handleMergeLocal(plan: Store.Plan, c: MergeCaller, body: { override?: unknown }, base: string | null): Promise<MergeAnswer> {
  if (inFlight.has(plan.id)) return refuse(409, "A merge for this plan is already running: wait for it to finish", { code: "merge-busy", state: "merge-busy" });
  inFlight.add(plan.id);
  try { return await mergeLocalOnce(plan, c, body, base); } finally { inFlight.delete(plan.id); }
}

async function mergeLocalOnce(plan: Store.Plan, c: MergeCaller, body: { override?: unknown }, base: string | null): Promise<MergeAnswer> {
  if (plan.state !== "launched") return refuse(409, "only a launched plan has a branch to merge", { state: "not-launched" });
  if (c.kind === "worker") return refuse(403, "A worker never merges: the person or the project's coordinator asks");
  const asPerson = c.kind === "person";
  if (body.override !== undefined && !asPerson) return refuse(403, "An override is the person's alone", { state: "override-is-the-persons" });
  if (!asPerson && !(c.kind === "seat" && c.powers === "assign")) return refuse(403, "Merging is the person's, or the project's coordinator with the power to assign");
  let override: { reason: string; signoff: boolean } | null = null;
  if (body.override !== undefined) {
    const o = body.override as { reason?: unknown; signoff?: unknown } | null;
    const reason = typeof o?.reason === "string" ? o.reason.trim() : "";
    if (!o || typeof o !== "object" || reason.length < 3 || reason.length > 500) return refuse(400, "override.reason: 3 to 500 characters");
    if (o.signoff !== undefined && o.signoff !== true) return refuse(400, "override.signoff: true or left out");
    override = { reason, signoff: o.signoff === true };
  }
  const root = plan.root;
  // 5: base and branch rules, read-only, with recovery.
  if (!base || base.startsWith("origin/") || Local.tipOf(root, base) === null) return refuse(409, "The local base branch is missing or has diverged from its remote; fix it, then retry", { state: "base-not-local" });
  const got = recover(plan, base, root);
  if (got) return got;
  if (plan.landedAt) return { status: 200, body: { ok: true, state: "already-landed" } };
  const branch = plan.launched?.branch;
  if (!branch) return refuse(409, "this plan has no branch to merge", { state: "no-branch" });
  const tip = Local.tipOf(root, branch);
  if (!tip) return refuse(409, `the branch ${branch} is gone`, { state: "branch-gone" });
  if (tip === plan.launched?.from) return refuse(409, "the branch has not moved since it was cut: there is nothing to merge", { state: "nothing-to-merge" });
  if (Local.isAncestor(root, tip, `refs/heads/${base}`)) {
    // Landed only when the branch really grew past the commit it was cut from: a branch reset to an older commit already in base contributed nothing.
    const from = plan.launched?.from;
    if (!from || !Local.isAncestor(root, from, tip)) return refuse(409, "the branch holds nothing past the commit it was cut from: there is nothing to merge", { state: "nothing-to-merge" });
    Store.markLanded(plan.id);
    return { status: 200, body: { ok: true, state: "already-merged" } };
  }
  // 6: a seat's limits, then the flow's gates.
  if (!asPerson) {
    if (FlightPlan.isHeld(root)) return refuse(403, "this project is held: no merge until the person resumes it", { state: "held" });
    const pilot = FlightPlan.pilotOf(root);
    if (pilot !== "autopilot") return refuse(403, `this project flies in ${pilot === "copilot" ? "Co-pilot" : "Manual"}: merging is the person's`, { state: "not-autopilot" });
  }
  const gate = await FlightPlan.integrateGate(plan, { asPerson, override: !!override, tip });
  // The await above gave other work a turn: the base may have moved or the branch landed meanwhile.
  const again = recover(plan, base, root);
  if (again) return again;
  if (Local.isAncestor(root, tip, `refs/heads/${base}`)) return refuse(409, "the branch is already in the base: there is nothing to merge", { state: "nothing-to-merge" });
  const row = { id: null as number | null };
  const passes = gate.ok ? gate.passes : [];
  const intent = (signoffId: number | null) => Store.recordMerge({ planId: plan.id, who: asPerson ? "you" : `coordinator:${c.name}`, base, baseBefore: Local.tipOf(root, base), branch, tip, overridden: gate.ok ? gate.overridden : [], reason: override?.reason ?? null, passes, signoffId });
  if (!gate.ok) {
    const { ok: _ok, ...rest } = gate;
    return refuse(gate.status, gate.error, { ...rest, state: gate.stopReason === "required-step" || gate.stopReason === "rounds-used" ? gate.stopReason : "stop", overridable: asPerson });
  }
  if (override) {
    try { row.id = intent(null); } catch { return refuse(500, "the override could not be recorded: nothing ran", { state: "not-recorded" }); }
  }
  const settle3 = () => { if (row.id !== null) Store.settleMerge(row.id, 3); };
  // 7: the server's own sign-off.
  const s = signoffFor(plan, tip, base, root, !!override?.signoff);
  let signoffId: number | null = null;
  if (s.state === "running" && s.baseMoved) { settle3(); return refuse(409, "The base branch moved since the review: a new review of the diff has started", { state: "base-moved", runId: s.runId }); }
  if (s.state === "running") { settle3(); return { status: 202, body: { ok: false, state: "signoff-running", runId: s.runId } }; }
  if (s.state === "blocker") { settle3(); return refuse(409, s.sentence, { state: "signoff-blocker" }); }
  if (s.state === "waiting") {
    if (asPerson && override?.signoff) signoffId = personSignoff(plan, tip, Local.tipOf(root, base) ?? "", "you", override.reason);
    else { settle3(); return refuse(409, `The review of the diff could not finish: ${s.sentence}`, { state: "signoff-waiting", reason: s.reason, personMaySignOff: asPerson }); }
  } else signoffId = s.id;
  if (row.id !== null) Store.setMergeSignoff(row.id, signoffId);
  // 8-10: repo checks, lock, intent row, merge, finish.
  let r: Local.MergeResult;
  try {
    r = Local.mergeLocal(root, { base, branch, sha: tip, reviewedBase: s.state === "clear" ? s.baseSha : null, planId: plan.id, onBeforeGit: () => { if (row.id === null) row.id = intent(signoffId); } });
  } catch { return refuse(500, "the merge could not be recorded: nothing ran", { state: "not-recorded" }); }
  if (!r.ok) { settle3(); return refuse(r.status, r.error, { state: r.reason, ...(r.files ? { files: r.files } : {}) }); }
  try { Store.finishMerge(row.id!, plan.id, r.sha); } catch { return refuse(500, "The merge happened but could not be recorded", { state: "merged-not-recorded", sha: r.sha }); }
  return { status: 200, body: { ok: true, state: "merged", sha: r.sha, base, branch, passes, overridden: gate.overridden, warnings: gate.warnings, hooks: "skipped", pushed: false } };
}
