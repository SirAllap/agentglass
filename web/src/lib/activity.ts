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

/*
 * WHAT THE ACTIVITY PAGE DOES WITH THESE ROWS.
 *
 * `dayName`, `byDay` and `runsOf` lived inside SettingsModal.tsx, which meant
 * the two claims the page makes — "grouped by day" and "repetitions folded" —
 * could only be checked by looking at it. They are pure, they are the whole of
 * the behaviour, and they are three of the easiest things in this app to get
 * subtly wrong: a day boundary, a fold key, and what refuses to fold.
 *
 * Here they can be run over the real rows, which is how they were verified:
 * 200 records out of a copy of his own database, against a SQL query over the
 * same copy.
 */
/**
 * Group by the day something happened, newest first.
 *
 * Calendar days, not "24 hours ago": the question is "was this today", and a
 * row from 23:50 last night is not today however few hours have passed. Local
 * time, because the reader's day is the one being named.
 *
 * `Intl` for the older headings, so a January date does not read as 01/02 to
 * half the world — and it needs no locale of its own, the browser has his.
 */
export function dayName(at: number): string {
  const d = new Date(at);
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const days = Math.floor((midnight.getTime() - new Date(d).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

/* `at` off the RUN, not off its row: a gate record keeps its timestamps under
   other names and only the merged row carries one field both kinds share. */
export function byDay<T extends { at: number }>(runs: T[]): { day: string; runs: T[] }[] {
  const out: { day: string; runs: T[] }[] = [];
  for (const r of runs) {
    const day = dayName(r.at);
    const last = out[out.length - 1];
    if (last && last.day === day) last.runs.push(r);
    else out.push({ day, runs: [r] });
  }
  return out;
}

/**
 * The day headings, each with its rows already folded.
 *
 * ONE function because the ORDER of the two is the whole correctness argument,
 * and the call site had it backwards for as long as this page has existed.
 * Folding first lets a run of identical neighbours span local midnight: the
 * fold keeps the timestamp of its FIRST member and carries the whole count
 * across the boundary, so one day is credited with events that happened on the
 * other. Measured on his own database — 200 rows, one fold of
 * `/prs/pending-review` with two members on one day and three on the next:
 *
 *     day            SQL   the page said
 *     2026-08-27      64      67   (+3, the three borrowed)
 *     2026-08-26      68      65   (-3, the three lost)
 *
 * Both ends of a heading are a claim about what happened THAT day, and a fold
 * that reaches past the heading above it breaks both at once. Grouping first
 * makes the boundary a wall the fold cannot cross, which is also what a reader
 * assumes it is: nobody expects a "x5" under Tuesday to be counting Monday.
 */
export function activityDays(rows: ReturnType<typeof mergeActivity>): { day: string; runs: ActivityRun[] }[] {
  return byDay(rows).map(({ day, runs }) => ({ day, runs: runsOf(runs) }));
}

export type ActivityRun = ReturnType<typeof mergeActivity>[number] & { times: number };
export function runsOf(rows: ReturnType<typeof mergeActivity>): ActivityRun[] {
  const out: ActivityRun[] = [];
  for (const r of rows) {
    const prev = out[out.length - 1];
    const same = prev
      && prev.kind === "action" && r.kind === "action"
      && prev.row.action === r.row.action
      && prev.row.target === r.row.target
      && prev.row.ok === r.row.ok
      && prev.row.ok; /* a failure is never one of a crowd */
    if (same) { prev.times++; continue; }
    out.push({ ...r, times: 1 });
  }
  return out;
}

