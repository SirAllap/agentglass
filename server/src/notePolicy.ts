// What the server decides NOT to say.
//
// alerts.ts delivers; this file is the part of the decision that needs memory
// across events — a failed tool call is only news as the third in a row, and a
// Lantern finding is only news the first time it is seen. Both are pure over
// their inputs so the suite can replay an hour of a fleet through them without
// a server, a socket or a tmux.
//
// Measured before this existed, replaying one synthetic hour of a desk running
// five agents through main's rules: every failed Bash was its own row, "waiting
// for your input" was a popup and a chime per turn per agent, and the Lantern
// re-sent the same critical card every fifteen minutes for as long as one
// session stayed flagged. None of those is something a person can act on a
// second time.
//
// What is NOT here, and why: suppressing news about the pane somebody is
// looking at. tmux reports a client as `focused` by default — with
// `focus-events off`, tmux's own default, the flag is set on attach and never
// clears — and pane ids are per server, so `%5` on one server said nothing
// about `%5` on another. Measured on this desk: 76 sockets in the socket dir,
// and a client attached through `script` read `attached,focused` without ever
// sending a focus event. A rule built on that swallowed permission asks. It
// needs focus proven per server before it can come back.

/* ── failed tool calls ─────────────────────────────────────────────────────

   A single failure is how agents work: over 8 days, 464 of 465 were followed by
   another event from the same session within a minute, and none was the last
   thing a session did (alerts.ts has the measurement). What IS worth a person
   is the shape that failure takes when the agent is not recovering:

     · a STREAK — the same session failing ERROR_STREAK calls in a row with no
       success between them. Said once per streak; a success ends it.
     · a turn that ENDED on a failure — the last tool call before the session
       went quiet had failed. That is an agent that gave up, or is asking.

   "Ended" is a Stop followed by STOP_QUIET_MS without another tool call, not
   the Stop alone. The transcript scanner emits a Stop for every assistant line
   without a tool call, and Claude Code writes a thinking block on its own line,
   so a Stop lands in the middle of a turn after about half of all failures —
   measured over 200 transcripts: 227 of 416 failed tool results were followed
   by such a line. A tool call before the quiet period is over cancels it.

   Everything else is the session's own activity, which the board already
   draws. */

export const ERROR_STREAK = 3;
export const STOP_QUIET_MS = 20_000;

export type ErrorAlert =
  | { kind: "streak"; session: string; tool: string; count: number; text: string }
  | { kind: "stopped"; session: string; tool: string; text: string };

type Streak = { count: number; tool: string; text: string; said: boolean; stoppedAt?: number };

/** Only the fields a decision reads, so a test can hand in a literal. */
export type ErrorEvent = {
  hook_event_type: string;
  session_id: string;
  is_error?: number | boolean;
  tool_name?: string | null;
  error_text?: string | null;
};

export class ErrorStreaks {
  private by = new Map<string, Streak>();
  /** Sessions end without saying so often enough that the map would only grow. */
  private static readonly MAX = 500;

  /**
   * One event. Returns a streak to say now. A Stop after a failure returns
   * nothing and arms `settle`, which the caller asks after STOP_QUIET_MS.
   */
  note(e: ErrorEvent, now = Date.now()): ErrorAlert | null {
    const s = e.session_id;
    const type = e.hook_event_type;
    if (type.startsWith("PostToolUse")) {
      if (!e.is_error) { this.by.delete(s); return null; }
      const prev = this.by.get(s);
      const cur: Streak = {
        count: (prev?.count ?? 0) + 1,
        tool: e.tool_name || "tool",
        text: (e.error_text ?? "").slice(0, 200),
        said: prev?.said ?? false,
      };
      this.by.delete(s);
      this.by.set(s, cur);
      if (this.by.size > ErrorStreaks.MAX) this.by.delete(this.by.keys().next().value!);
      if (cur.count >= ERROR_STREAK && !cur.said) {
        cur.said = true;
        return { kind: "streak", session: s, tool: cur.tool, count: cur.count, text: cur.text };
      }
      return null;
    }
    // The turn went on: whatever looked like its end was not.
    if (type === "PreToolUse") {
      const cur = this.by.get(s);
      if (cur) delete cur.stoppedAt;
      return null;
    }
    // A new prompt is the person answering; whatever failed before it is theirs.
    if (type === "UserPromptSubmit" || type === "SessionEnd") { this.by.delete(s); return null; }
    if (type === "Stop") {
      const cur = this.by.get(s);
      // A streak already said includes this stop: one card for one episode.
      if (cur && !cur.said) cur.stoppedAt = now;
    }
    return null;
  }

  /** Was the session's last Stop really the end of its turn? Said once. */
  settle(session: string, now = Date.now()): ErrorAlert | null {
    const cur = this.by.get(session);
    if (cur?.stoppedAt === undefined || cur.said || now - cur.stoppedAt < STOP_QUIET_MS) return null;
    this.by.delete(session);
    return { kind: "stopped", session, tool: cur.tool, text: cur.text };
  }
}

/* ── the Lantern ───────────────────────────────────────────────────────────

   The watch reads the board every few minutes and used to push whatever it
   found, every time: the same "1 needs you · 1 looks forgotten" as a critical
   card every fifteen minutes, about the same two sessions, for as long as they
   stayed that way. The person had seen it the first time.

   Now each finding is keyed by what it is about and when it began, and only a
   key not seen before is news. One exception: a BLOCKED session (a permission
   or the gate — not a prompt left open) is said once more after REMIND_MS,
   because an agent stopped on a question is the one thing that does not
   resolve itself.

   The card itself is one, keyed, and updated in place: the client replaces the
   previous Lantern row instead of adding another, and removes it when nothing
   is left. Its urgency is the card's STANDING level — critical while anything
   in it is blocked — whatever the newest line in it is; whether it interrupts
   is a separate question, answered by whether anything in it is new. */

export const REMIND_MS = 30 * 60_000;

/** The shape both versions of lanternwatch.ts produce. `left` exists where
 *  "waiting" also covers a prompt left open for an hour; absent, a waiting
 *  finding is treated as blocked, which is the louder and safer reading. */
export type LanternFinding = {
  kind: "waiting" | "forgotten" | "gone";
  name: string;
  since: number;
  pane?: string;
  left?: boolean;
};

export type LanternState = {
  /** key → when it was first said, and whether its one reminder went out. */
  said: Map<string, { at: number; reminded: boolean }>;
  /** The keys the card on the client currently lists, in order. */
  showing: string[];
};
export const lanternState = (): LanternState => ({ said: new Map(), showing: [] });

export const findingKey = (f: LanternFinding): string => `${f.kind}:${f.name}:${f.since}`;
const blocked = (f: LanternFinding): boolean => f.kind === "waiting" && !f.left;

/** The card's standing level: critical while anything in it is blocked. */
export const lanternUrgency = (f: readonly LanternFinding[]): 1 | 2 => (f.some(blocked) ? 2 : 1);

export type LanternStep<F extends LanternFinding> =
  /** Something new (or a blocked one's reminder): say it. */
  | { act: "announce"; urgency: 1 | 2; findings: F[]; panes: string[] }
  /** The set changed but nothing in it is new — redraw the card silently. */
  | { act: "update"; urgency: 1 | 2; findings: F[]; panes: string[] }
  /** Everything it listed resolved. */
  | { act: "clear" }
  | { act: "none" };

/**
 * One look's worth of decision. Mutates `state` — it IS the memory.
 */
export function lanternStep<F extends LanternFinding>(all: F[], state: LanternState, now: number): LanternStep<F> {
  const keys = all.map(findingKey);
  // A resolved finding forgets it was said, so the next episode is news.
  const present = new Set(keys);
  for (const k of state.said.keys()) if (!present.has(k)) state.said.delete(k);

  let fresh = false;
  all.forEach((f, i) => {
    const k = keys[i]!;
    const was = state.said.get(k);
    if (!was) {
      state.said.set(k, { at: now, reminded: false });
      fresh = true;
    } else if (blocked(f) && !was.reminded && now - was.at >= REMIND_MS) {
      was.reminded = true;
      fresh = true;
    }
  });

  const same = keys.length === state.showing.length && keys.every((k, i) => k === state.showing[i]);
  const hadCard = state.showing.length > 0;
  state.showing = keys;
  if (!all.length) return hadCard ? { act: "clear" } : { act: "none" };
  const panes = [...new Set(all.map((f) => f.pane).filter((p): p is string => !!p))];
  const urgency = lanternUrgency(all);
  if (fresh) return { act: "announce", urgency, findings: all, panes };
  if (!same) return { act: "update", urgency, findings: all, panes };
  return { act: "none" };
}
