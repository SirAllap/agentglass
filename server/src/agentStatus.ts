/*
 * "How are we" — one row per card this project's board shows a worker on:
 * card | role | state | next.
 *
 * Card, role and state are already joined (agentboard.ts's BoardRow, fed by
 * lantern.ts); "next" is the one thing nobody turns into a per-card field —
 * `flow.ts` only renders the path as prose for the orchestrator. This reads
 * it on demand, off the same board the Lantern already reads: no new timer,
 * no new state of its own.
 */
import type { BoardRow } from "./agentboard.ts";
import { slugOf } from "./cleanup.ts";
import type { Flow } from "../../shared/flow.ts";

export interface StatusRow { card: string; role: string; state: BoardRow["state"] | "waiting on person"; next: string }

/**
 * The step the project's flow says comes after `roleId`, by the suggested
 * path (`flow.path`). "done" past the last step, "" when `roleId` is not on
 * the path at all (a custom role asked for outside the suggested order, or
 * none) — nothing to say, not a guess.
 */
export function nextRoleAfter(flow: Flow, roleId: string | undefined): string {
  if (!roleId) return "";
  const i = flow.path.indexOf(roleId);
  if (i < 0) return "";
  const nextId = flow.path[i + 1];
  if (!nextId) return "done";
  return flow.roster.find((r) => r.id === nextId)?.name ?? nextId;
}

const roleName = (flow: Flow, roleId: string | undefined): string => (roleId ? flow.roster.find((r) => r.id === roleId)?.name ?? roleId : "");

/**
 * One row per board row that is a worker on a card: its branch carries a
 * card id prefix (`slugOf`, the same reading `cleanup.ts` plans a merge
 * with). Rows with no card — a bare checkout, the Lantern's own chat, the
 * orchestrator's row (`role` set) — are left out: this table is about
 * cards, not every pane.
 */
export function statusRows(rows: readonly BoardRow[], flow: Flow): StatusRow[] {
  return rows.flatMap((r) => {
    if (r.role) return [];
    const card = r.branch ? slugOf(r.branch) : null;
    if (!card) return [];
    const roleId = r.worker?.role;
    const next = r.needsYou ? "waiting on person" : nextRoleAfter(flow, roleId);
    return [{ card, role: roleName(flow, roleId), state: r.needsYou ? "waiting on person" : r.state, next }];
  });
}

/** The table as text: one line per row, in the column order the ask gave. Empty board: one line saying so, not a header over nothing. */
export function statusReadout(rows: readonly StatusRow[]): string {
  if (!rows.length) return "No card has a worker on it right now.";
  const cols = [["card", "role", "state", "next"], ...rows.map((r) => [r.card, r.role, r.state, r.next])];
  const w = [0, 1, 2, 3].map((i) => Math.max(...cols.map((c) => c[i]!.length)));
  return cols.map((c, i) => c.map((v, j) => v.padEnd(w[j]!)).join("  ") + (i === 0 ? `\n${w.map((n) => "-".repeat(n)).join("  ")}` : "")).join("\n");
}
