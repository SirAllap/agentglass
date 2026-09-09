/*
 * WAKING THE SEAT — on what changed, not on a clock.
 *
 * The version of this post that was run by hand woke every twenty minutes and
 * re-read a field nobody had touched: of fourteen rounds in one afternoon,
 * twelve said "no change". Each of those is a turn, a context, and a bill, to
 * learn that nothing happened — and the app already knew nothing had happened,
 * because `lanternwatch.tick()` had just read the same board for free.
 *
 * So the seat has no clock of its own (its prompt says so in as many words).
 * This module rides the watch that already runs: after each look it compares
 * what the field says needs a person with what it said last time, and prompts
 * the seat ONLY when that changed. A floor underneath — `seatWakeHours` — wakes
 * it anyway now and then, so a quiet day still gets a line rather than silence
 * that cannot be told from a dead agent.
 *
 * What is compared is the FINDINGS, not the board: an agent moving from one
 * file to the next changes the board every few seconds and changes nothing a
 * person needs to know. What changes a finding is somebody stopping, somebody
 * going quiet for an hour, or a window vanishing.
 */
import * as AgentOps from "./agentops.ts";
import { inScope, seatWakeHours } from "./config.ts";
import type { Finding } from "./lanternwatch.ts";
import { everySeat, seated } from "./seat.ts";
import { releaseVanished } from "./seatqueue.ts";
import { unreadWorthWaking } from "./seatreport.ts";
import { noteWoken, wokenFor, __resetWoken } from "./seatwoken.ts";

/* What each seat was last told lives in seatwoken.ts, a leaf: the view reads
   it for its dial, and having seat.ts and this file import each other for one
   timestamp is a cycle. */

/**
 * The findings reduced to what a person would call a change.
 *
 * Kind and name, sorted — deliberately NOT the wording or the elapsed time,
 * which drift every minute ("7m" becomes "8m") and would make every look a
 * change.
 */
export function fingerprint(f: Finding[]): string {
  return f.map((x) => `${x.kind}:${x.name}`).sort().join("|");
}

/** The line the seat is woken with: what is new, in the words the watch used. */
export function wakeLine(now: Finding[], before: string): string {
  const had = new Set(before ? before.split("|") : []);
  const fresh = now.filter((f) => !had.has(`${f.kind}:${f.name}`));
  if (fresh.length) return `The field changed: ${fresh.map((f) => f.line).join(" · ")}. Take a look and report your line.`;
  if (now.length === 0) return "The field is clear: nobody is stopped and nothing has gone quiet. Report your line.";
  return "The field changed. Take a look and report your line.";
}

export interface WakeDeps {
  seats?: () => { root: string; endedAt: number | null }[];
  /** The named agents alive right now, injected so a test can say who is gone
   *  without a tmux server. */
  alive?: () => string[];
  /** Given the project root, not the seat's name: an ADOPTED seat has no named
   *  agent to look up, and that is the common case. */
  prompt?: (root: string, text: string) => Promise<unknown>;
  now?: number;
}

/**
 * One pass after a watch tick. Returns the roots woken, so a test can assert
 * the silence as easily as the noise.
 */
export async function wakeSeats(f: Finding[], deps: WakeDeps = {}): Promise<string[]> {
  const now = deps.now ?? Date.now();
  const seats = (deps.seats ?? (() => everySeat()))();
  const send = deps.prompt ?? ((root: string, text: string) => promptSeat(root, text));
  const floorMs = seatWakeHours() * 3_600_000;
  const woken: string[] = [];
  /* Work handed to an agent whose window is gone is work nobody is doing, and
     a row left claimed is hidden from the queue for ever. Freed here, on the
     look that already knows who is alive, rather than by a watchdog of its
     own. The attempt it cost is kept: that is what makes the ceiling mean
     something. */
  const alive = new Set((deps.alive ?? (() => aliveNames()))());
  for (const s of seats) {
    if (s.endedAt === null) releaseVanished(s.root, alive);
  }
  for (const s of seats) {
    /* A row with `ended_at` set is a project whose chair is empty. Its
       settings are kept; nobody is in it to wake. */
    if (s.endedAt !== null) continue;
    /* Whose field this is. A seat for one repository woken because an agent in
       another one stopped would spend a turn reporting on work that is none of
       its business — and, with powers, offer to unstick it. */
    const mine = f.filter((x) => x.worktree && inScope(x.worktree, s.root));
    /*
     * A report waiting is part of what the field says, and the count is in the
     * fingerprint so a fifth report wakes the seat exactly as a fifth stopped
     * agent does. Its own words for why this matters: it was pasting five
     * reports by hand.
     *
     * Only the ones worth a turn, though — a report that says work is
     * proceeding is a thing to read at the next round, not a reason to spend
     * one. That line was drawn by the seat itself: "reporte con ESTADO y nada
     * más" is on its own list of what should NOT wake it.
     */
    const waiting = unreadWorthWaking(s.root);
    const fp = `${fingerprint(mine)}#${waiting}`;
    const last = wokenFor(s.root);
    const changed = !last || last.fingerprint !== fp;
    const overdue = !last || now - last.at >= floorMs;
    if (!changed && !overdue) continue;
    noteWoken(s.root, fp, now);
    /* A first sighting is not a change: the seat has just been given the whole
       field in its opening prompt, and waking it to say so would be a turn
       spent repeating what it is already reading. */
    if (!last) continue;
    const line = changed
      ? (waiting ? `${waiting} report${waiting === 1 ? "" : "s"} waiting: run \`agentglass-agent inbox\`. ` : "") + wakeLine(mine, last.fingerprint.split("#")[0] ?? "")
      : "Nothing has changed since your last round. Say so in one line, or say what you notice.";
    await send(s.root, line);
    woken.push(s.root);
  }
  return woken;
}

/** Every named agent with a pane, by name. Synchronous on the registry the
 *  watch has just reconciled — a second tmux call here would be asking the
 *  same question twice in one tick. */
function aliveNames(): string[] {
  return AgentOps.everyAgent().filter((a) => a.endedAt === null).map((a) => a.name);
}

/*
 * THE SEAT IS WOKEN WHEREVER IT IS SITTING.
 *
 * This looked the seat up with `agentNamed`, which knows only agents this app
 * STARTED — and the seat that runs a real project here adopted the chair from
 * a session somebody had already opened. So every wake in this file was a
 * no-op for the one seat it was written for, silently, for as long as it has
 * existed. Its own words, measuring it from the other side: "NO me despertó
 * (lo leí porque miré)".
 *
 * `seated` is the resolution the rest of the seat uses and it answers for both
 * ways of being in the chair: a named agent this app opened, or the pane an
 * adopted session is running in.
 */
async function promptSeat(root: string, text: string): Promise<void> {
  const a = await seated(root);
  /* Gone means the person closed the chair or the machine restarted; the row
     is closed by `reconcile` and the view says so. Nothing to shout about. */
  if (!a) return;
  await AgentOps.promptAgent(a.paneId, text, 10_000);
}

export function __resetSeatWake(): void { __resetWoken(); }
