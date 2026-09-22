/**
 * THE DASHBOARD'S FIRST LINE: what is running, what is stuck, what needs you.
 *
 * The dashboard answered "what happened" at equal weight in fourteen panels
 * and left "is anything wrong right now" to whoever could read them all. This
 * is that answer, in one line, and it is a re-read of the Lantern's board
 * rather than a new source: the same rows the rail's pip and the Lantern view
 * already poll, sorted by the rules they already use — a permission or a held
 * gate is what needs you (`lanternNeed`), claimed work quiet for an hour is
 * stuck (the watch's "forgotten", from shared/fieldRules.ts, which already
 * leaves dead names out). The rows it counts are the rows the Lantern view
 * draws, so a clause that opens the view finds what it counted.
 *
 * A turn that ended and waits for its next prompt is not in the line. It is
 * most sessions most of the time, and a verdict that counts it is a verdict
 * that is never calm.
 *
 * Pure, and `now` is an argument, so it is tested here and not through a
 * render.
 */
import type { LanternRow } from "../components/LanternView.tsx";
import { isForgotten } from "../../../shared/fieldRules.ts";
import { ago } from "./fileRecents.ts";

export type VerdictTone = "calm" | "warn" | "critical";

export interface VerdictClause {
  kind: "running" | "stuck" | "need";
  count: number;
  text: string;
  tone: VerdictTone;
  /** When the clause is about exactly one agent with a pane, where to go. */
  paneId?: string;
}

export interface FleetVerdict { tone: VerdictTone; clauses: VerdictClause[] }

const waitWord = (w: NonNullable<LanternRow["needsYou"]>) =>
  w.kind === "permission" ? "needs your permission" : "held at the gate";

/** Null until the board has been read, and whenever the last read failed: "not
 *  known" must not be drawn as "all nominal". The store answers [] when its
 *  first read fails, so the rows alone cannot tell the two apart. */
export function fleetVerdict(all: LanternRow[] | null, now = Date.now(), failed = false): FleetVerdict | null {
  if (!all || failed) return null;
  const rows = all.filter((r) => r.role !== "lantern");
  const need = rows.filter((r) => r.needsYou && r.needsYou.kind !== "input");
  const stuck = rows.filter((r) => isForgotten(r, now));
  const running = rows.filter((r) => !r.needsYou && r.state === "working");

  const calm = !need.length && !stuck.length;
  const clauses: VerdictClause[] = [{
    kind: "running", count: running.length, tone: "calm",
    text: running.length ? `${running.length} running${calm ? " · all nominal" : ""}` : "nothing running",
  }];
  if (stuck.length) {
    const one = stuck.length === 1 ? stuck[0] : null;
    clauses.push({
      kind: "stuck", count: stuck.length, tone: "warn", paneId: one?.paneId,
      text: one ? `${one.name} quiet for ${ago(one.saidAt!, now).replace(/ ago$/, "")} on "${one.doing}"` : `${stuck.length} stuck`,
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
  return { tone: need.length ? "critical" : stuck.length ? "warn" : "calm", clauses };
}
