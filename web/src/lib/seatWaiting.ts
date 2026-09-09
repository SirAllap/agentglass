/*
 * WHAT IS WAITING ON THE PERSON — the first question the orchestrator's screen
 * exists to answer.
 *
 * Composed here rather than in the view because the interesting part is the
 * rule, not the markup, and one of the four kinds is subtle enough to be worth
 * pinning: work whose owner has gone.
 *
 * The day this was built from, in the seat's own account: the person had to
 * ask "what have we got left?" six times, and each time the answer was
 * reassembled by hand out of a head and a list nobody else could see.
 */
import type { SeatFieldRow, SeatReportRow, SeatTask } from "./api.ts";

export interface Waiting {
  /** An agent sitting at a prompt. There is a pane to go to, and it is the
   *  cheapest thing on the list to clear. */
  stopped: SeatFieldRow[];
  /** A live agent that said, in its own words, that it needs a decision or is
   *  blocked — not this app's reading of a hook. */
  asked: SeatReportRow[];
  /**
   * A blocker whose agent is GONE.
   *
   * The one kind here that disappears if nothing says it: the work stopped and
   * its owner left, so nobody is coming back for it. Asked for by the seat
   * reading its own screen — "eso es trabajo huérfano".
   */
  orphaned: SeatReportRow[];
  /** A queued task that has already defeated two agents. A third go is not the
   *  answer; a person is. */
  beaten: SeatTask[];
  count: number;
}

/** Whether this name is somebody you could still go and talk to. */
const reachable = (field: SeatFieldRow[], name: string): boolean =>
  field.some((f) => !f.gone && f.name === name);

export function whatWaits(field: SeatFieldRow[], reports: SeatReportRow[], tasks: SeatTask[], maxAttempts = 2): Waiting {
  const stopped = field.filter((r) => !r.gone && r.needsYou);
  /* A report counts once, by which of the two it is: an agent that is here and
     asking, or an agent that asked and left. */
  const asked = reports.filter((r) => (r.blocked || r.need) && reachable(field, r.agent));
  const orphaned = reports.filter((r) => r.blocked && !reachable(field, r.agent));
  const beaten = tasks.filter((t) => !t.doneAt && !t.takenAt && t.attempts >= maxAttempts);
  return { stopped, asked, orphaned, beaten, count: stopped.length + asked.length + orphaned.length + beaten.length };
}
