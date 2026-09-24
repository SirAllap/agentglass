/**
 * THE DASHBOARD'S FIRST LINE: what is running, what is stuck, what needs you.
 *
 * The dashboard answered "what happened" at equal weight in fourteen panels
 * and left "is anything wrong right now" to whoever could read them all. This
 * is that answer, in one line, and it is a re-read of the Lantern's board
 * rather than a new source: the same rows the rail's pip and the Lantern view
 * already poll, sorted by `attention` in shared/fieldRules.ts — the same call
 * the watch makes before it sends a notification, so the line and the push
 * cannot tell two stories. A permission or a held gate is what needs you (and
 * is exactly what the rail's pip counts); claimed work quiet for an hour, or a
 * turn that ended and nobody came back to for an hour, is stuck. The rows it
 * counts are the rows the Lantern view draws, so a clause that opens the view
 * finds what it counted.
 *
 * A turn that ended under the hour is not in the line. It is most sessions
 * most of the time, and a verdict that counts it is a verdict that is never
 * calm.
 *
 * Pure, and `now` is an argument, so it is tested here and not through a
 * render.
 */
import type { LanternRow } from "../components/LanternView.tsx";
import { attention, howLong } from "../../../shared/fieldRules.ts";
import { groupLantern } from "./lanternStore.ts";

export type VerdictTone = "calm" | "warn" | "critical";

export interface VerdictClause {
  kind: "running" | "stuck" | "need";
  count: number;
  text: string;
  tone: VerdictTone;
  /** When the clause is about exactly one agent with a pane, where to go. */
  paneId?: string;
}

export interface FleetVerdict {
  tone: VerdictTone;
  clauses: VerdictClause[];
  /** Every count, the zeros too: the KPI tiles under the strip draw these, so
   *  the two cannot show different numbers on one screen. */
  counts: { running: number; stuck: number; need: number };
  /** The last read failed and these are the rows from the one before it. */
  stale: boolean;
}

const waitWord = (w: NonNullable<LanternRow["needsYou"]>) =>
  w.kind === "permission" ? "needs your permission" : "held at the gate";

/** Null until the board has been read: "not known" must not be drawn as "all
 *  nominal". The store answers [] when its first read fails, so the rows alone
 *  cannot tell the two apart — `everRead` does. A failed read after a good one
 *  keeps the last answer, marked `stale`, so a server restart does not pull
 *  the line out from under the panels. */
export function fleetVerdict(all: LanternRow[] | null, now = Date.now(), failed = false, everRead = false): FleetVerdict | null {
  if (!all || (failed && !everRead)) return null;
  const rows = all.filter((r) => r.role !== "lantern");
  const need = rows.filter((r) => attention(r, now) === "blocked");
  const stuck = rows.filter((r) => { const a = attention(r, now); return a === "left" || a === "forgotten"; });
  /* The view's own Working group, not a second filter beside it: a row the
     server marked `gone` can still say `state: "working"`, and the view files
     it under Gone. */
  const running = groupLantern(rows).working;

  const calm = !need.length && !stuck.length;
  const clauses: VerdictClause[] = [{
    kind: "running", count: running.length, tone: "calm",
    text: running.length ? `${running.length} running${calm ? " · all nominal" : ""}` : "nothing running",
  }];
  if (stuck.length) {
    const one = stuck.length === 1 ? stuck[0] : null;
    clauses.push({
      kind: "stuck", count: stuck.length, tone: "warn", paneId: one?.paneId,
      text: !one ? `${stuck.length} stuck`
        : one.needsYou ? `${one.name} waiting for your next prompt for ${howLong(one.needsYou.since, now)}`
        : `${one.name} quiet for ${howLong(one.saidAt!, now)} on "${one.doing}"`,
    });
  }
  if (need.length) {
    const one = need.length === 1 ? need[0] : null;
    const w = one?.needsYou;
    clauses.push({
      kind: "need", count: need.length, tone: "critical", paneId: one?.paneId,
      /* `why` is the agent's own sentence ("Claude needs your permission to
         use Bash", "held at the gate: Bash — …"), so it stands alone; the
         kind's words are only for a wait that came without one. */
      text: one && w ? `${one.name}: ${w.why || waitWord(w)}` : `${need.length} need you`,
    });
  }
  return {
    tone: need.length ? "critical" : stuck.length ? "warn" : "calm", clauses,
    counts: { running: running.length, stuck: stuck.length, need: need.length },
    stale: failed,
  };
}
