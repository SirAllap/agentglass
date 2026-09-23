// What the server decides NOT to say.
//
// alerts.ts delivers; this file is the part of the decision that needs memory
// across events — a failed tool call is only news as the third in a row, and a
// Lantern finding is only news the first time it is seen. Both are pure over
// their inputs so the suite can replay an hour of a fleet through them without
// a server, a socket or a tmux.
//
// Measured before this existed, on a desk running five agents: every failed
// Bash was its own row, the Lantern re-sent the same critical card every fifteen
// minutes for as long as one session stayed flagged, and "waiting for your
// input" arrived for the pane the person was typing in. None of those three is
// something a person can act on a second time.

/* ── failed tool calls ─────────────────────────────────────────────────────

   A single failure is how agents work: over 8 days, 464 of 465 were followed by
   another event from the same session within a minute, and none was the last
   thing a session did (alerts.ts has the measurement). What IS worth a person
   is the shape that failure takes when the agent is not recovering:

     · a STREAK — the same session failing ERROR_STREAK calls in a row with no
       success between them. Said once per streak; a success ends it.
     · a STOP on a failure — the turn ended and the last tool call before it had
       failed. That is an agent that gave up, or is asking about it.

   Everything else is the session's own activity, which the board already
   draws. */

export const ERROR_STREAK = 3;

export type ErrorAlert =
  | { kind: "streak"; session: string; tool: string; count: number; text: string }
  | { kind: "stopped"; session: string; tool: string; text: string };

type Streak = { count: number; tool: string; text: string; said: boolean };

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

  note(e: ErrorEvent): ErrorAlert | null {
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
    // A new prompt is the person answering; whatever failed before it is theirs.
    if (type === "UserPromptSubmit" || type === "SessionEnd") { this.by.delete(s); return null; }
    if (type === "Stop") {
      const cur = this.by.get(s);
      this.by.delete(s);
      // A streak already said includes this stop: one card for one episode.
      if (!cur || cur.said) return null;
      return { kind: "stopped", session: s, tool: cur.tool, text: cur.text };
    }
    return null;
  }
}

/* ── the Lantern ───────────────────────────────────────────────────────────

   The watch reads the board every few minutes and used to push whatever it
   found, every time: the same "1 needs you · 1 looks forgotten" as a critical
   card every fifteen minutes, about the same two sessions, for as long as they
   stayed that way. The person had seen it the first time.

   Now each finding is keyed by what it is about and when it began, and only a
   key not seen before is news. Two exceptions, both deliberate:

     · a BLOCKED session (a permission or the gate — not a prompt left open) is
       said once more after REMIND_MS, because an agent stopped on a question
       is the one thing that does not resolve itself.
     · a finding whose pane is on somebody's screen is not said at all while it
       is there: the prompt waiting for input is the one being typed into. A
       blocked one is dropped only when that terminal also has focus — being
       shown in a window behind another is not being seen.

   The card itself is one, keyed, and updated in place: the client replaces the
   previous Lantern row instead of adding another, and removes it when nothing
   is left. */

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

export type Screen = { shown: ReadonlySet<string>; focused: ReadonlySet<string> };
export const NO_SCREEN: Screen = { shown: new Set(), focused: new Set() };

export type LanternState = {
  /** key → when it was first said, and whether its one reminder went out. */
  said: Map<string, { at: number; reminded: boolean }>;
  /** The keys the card on the client currently lists, in order. */
  showing: string[];
};
export const lanternState = (): LanternState => ({ said: new Map(), showing: [] });

export const findingKey = (f: LanternFinding): string => `${f.kind}:${f.name}:${f.since}`;
const blocked = (f: LanternFinding): boolean => f.kind === "waiting" && !f.left;

export function onScreen(f: LanternFinding, screen: Screen): boolean {
  if (!f.pane) return false;
  return blocked(f) ? screen.focused.has(f.pane) : screen.shown.has(f.pane);
}

export type LanternStep<F extends LanternFinding> =
  /** Something new (or a blocked one's reminder): say it, at this urgency. */
  | { act: "announce"; urgency: 1 | 2; findings: F[]; panes: string[] }
  /** The set changed but nothing in it is new — redraw the card silently. */
  | { act: "update"; findings: F[]; panes: string[] }
  /** Everything it listed resolved. */
  | { act: "clear" }
  | { act: "none" };

/**
 * One look's worth of decision. Mutates `state` — it IS the memory.
 */
export function lanternStep<F extends LanternFinding>(all: F[], state: LanternState, now: number, screen: Screen = NO_SCREEN): LanternStep<F> {
  const visible = all.filter((f) => !onScreen(f, screen));
  const keys = visible.map(findingKey);
  // A resolved finding forgets it was said, so the next episode is news. So
  // does one that went on screen: looking at it is its answer.
  const present = new Set(keys);
  for (const k of state.said.keys()) if (!present.has(k)) state.said.delete(k);

  let fresh = false;
  let urgent = false;
  visible.forEach((f, i) => {
    const k = keys[i]!;
    const was = state.said.get(k);
    if (!was) {
      state.said.set(k, { at: now, reminded: false });
      fresh = true;
      if (blocked(f)) urgent = true;
    } else if (blocked(f) && !was.reminded && now - was.at >= REMIND_MS) {
      was.reminded = true;
      fresh = true;
      urgent = true;
    }
  });

  const same = keys.length === state.showing.length && keys.every((k, i) => k === state.showing[i]);
  const hadCard = state.showing.length > 0;
  state.showing = keys;
  const panes = [...new Set(visible.map((f) => f.pane).filter((p): p is string => !!p))];
  if (!visible.length) return hadCard ? { act: "clear" } : { act: "none" };
  if (fresh) return { act: "announce", urgency: urgent ? 2 : 1, findings: visible, panes };
  if (!same) return { act: "update", findings: visible, panes };
  return { act: "none" };
}
