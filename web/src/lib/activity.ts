/**
 * One list of what was done through this cockpit, from two records.
 *
 * The action log keeps every write a *person* made — staging, pushing, merging,
 * removing a container, answering a gate. The gates table keeps the fate of
 * every held tool call, which is not the same set: a request the timeout
 * allowed, or one a restart found already expired, changed what an agent did
 * and appears in no action row at all, because nobody made a request for it.
 *
 * An audit trail with a hole in it is worse than none — you stop looking for
 * the missing line — and "the outcomes nobody chose" is the hole most worth
 * closing, since those are exactly the ones nobody remembers.
 *
 * Where the two overlap, the gate record wins. It is the same event told
 * better: the actor is on the row itself, the summary is not clipped to share
 * 120 characters with the tool name, and the reason a human typed is there,
 * which the action log never carried.
 */
import type { ActionRecord, GateRecord } from "../../../shared/types.ts";

export type ActivityRow =
  | { kind: "action"; at: number; key: string; row: ActionRecord }
  | { kind: "gate"; at: number; key: string; row: GateRecord };

/**
 * Merge, newest first.
 *
 * A *successful* `/gate/*` action row is dropped, because the gate record
 * carries the same press with more of it. A **failed** one is kept: it is an
 * attempt rather than an outcome — somebody pressed deny on a request the
 * clock had already allowed — and the gates table has no row for the press
 * that lost, only for the one that won. Dropping it would quietly delete the
 * single most confusing thing that can happen here.
 */
export function mergeActivity(actions: ActionRecord[], gates: GateRecord[]): ActivityRow[] {
  const rows: ActivityRow[] = [];
  for (const a of actions) {
    if (a.action.startsWith("/gate/") && a.ok) continue;
    rows.push({ kind: "action", at: a.at, key: `a${a.id}`, row: a });
  }
  for (const g of gates) {
    // A gate still pending has no place in a record of what happened.
    if (!g.decided_at) continue;
    rows.push({ kind: "gate", at: g.decided_at, key: `g${g.id}`, row: g });
  }
  return rows.sort((x, y) => y.at - x.at || x.key.localeCompare(y.key));
}

/**
 * What a resolved gate says, in the words of the thing that resolved it.
 *
 * The three cases are genuinely different events and rounding them together is
 * the mistake this exists to prevent: "allowed" for a request a person read and
 * approved, and "allowed" for one that expired while they were at lunch, look
 * identical in a list and mean opposite things about whether anybody looked.
 */
export function gateLine(g: GateRecord): { verb: string; note: string } {
  const did = g.decision === "deny" ? "denied" : "approved";
  if (g.resolution === "human") return { verb: did, note: "" };
  const passive = g.decision === "deny" ? "denied" : "allowed";
  if (g.resolution === "restart")
    return { verb: passive, note: "the window closed while the server was down — nobody saw this" };
  return { verb: passive, note: "nobody answered before the timeout" };
}

/**
 * The name to show against a row, or nothing.
 *
 * Empty for this machine's own dashboard, which is most rows and where a label
 * would be noise standing in for the only case that needs no name. Also empty
 * when nobody decided — but that is never read as "local", because the line
 * itself already says the timeout resolved it.
 *
 * A human-decided row with no actor is one written before the column existed.
 * It shows nothing, which is knowingly lossy for the handful of rows already on
 * disk when this shipped; the alternative is marking every one of them unknown
 * forever to describe a gap that stops growing the moment it is deployed.
 */
export function actorLabel(row: ActivityRow): string {
  const who = row.kind === "action" ? row.row.actor : row.row.decided_by;
  return !who || who === "local" ? "" : who;
}
