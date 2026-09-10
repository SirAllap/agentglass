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
import type { SeatFieldRow, SeatNeed, SeatReportRow, SeatTask } from "./api.ts";

export interface Waiting {
  /**
   * WHAT THE SEAT ITSELF IS ASKING FOR, and the pile it used most.
   *
   * Something finished that needs one action only a person can take: re-upload
   * the GIF, ask for a reviewer, say yes to a push. A separate kind from
   * `asked` because the direction is the other way — that is what the agents
   * want from the person, this is what the seat wants back — and before this it
   * lived nowhere but a chat, so it was lost the moment the conversation moved
   * on.
   */
  ready: SeatNeed[];
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

/*
 * THE ORDER IS THE SEAT'S, and its reason is better than the obvious one.
 *
 * The first draft put `stopped` first, because an agent at a prompt is the
 * cheapest thing to clear. It corrected that: what the person takes time to
 * decide is the only part of the day that cannot be recovered — a decision of
 * theirs waited hours — while an agent parked at a prompt is rarely what is
 * holding the day up. So: what is asked of them first, then the work that will
 * be lost if nobody says it, then the cheap ones.
 */
export function whatWaits(
  field: SeatFieldRow[], reports: SeatReportRow[], tasks: SeatTask[], needs: SeatNeed[] = [], maxAttempts = 2,
): Waiting {
  const ready = needs.filter((n) => !n.doneAt);
  const stopped = field.filter((r) => !r.gone && r.needsYou);
  /* A report counts once, by which of the two it is: an agent that is here and
     asking, or an agent that asked and left. */
  const asked = reports.filter((r) => (r.blocked || r.need) && reachable(field, r.agent));
  const orphaned = reports.filter((r) => r.blocked && !reachable(field, r.agent));
  const beaten = tasks.filter((t) => !t.doneAt && !t.takenAt && t.attempts >= maxAttempts);
  return {
    ready, asked, orphaned, stopped, beaten,
    count: ready.length + asked.length + orphaned.length + stopped.length + beaten.length,
  };
}
