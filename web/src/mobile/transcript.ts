// Which turns the phone draws, and in which direction.
//
// `SessionDetail.conversation` arrives newest-first: the server orders it that
// way so its size budget drops the oldest turns rather than the ones you opened
// the session to read (server/src/db.ts). Every reader has to turn it back
// round before drawing it, and the phone did not — it rendered the array as it
// came and took `slice(-40)`, which on a newest-first list is the OLDEST forty.
// A long session therefore opened on ancient history, newest at the top, with
// the turn you had just sent pinned below all of it.
//
// A chat reads downwards. That is not a preference, it is what every messaging
// app on the device has taught the person holding it.

/** One turn, reduced to what the ordering cares about. */
export interface Turn {
  ts: number;
}

/**
 * The newest `limit` turns, oldest first.
 *
 * Take from the head (newest-first input), then reverse — the other way round
 * keeps the wrong end of a long session.
 */
export function recentTurns<T extends Turn>(conversation: readonly T[] | undefined, limit = 40): T[] {
  return (conversation ?? []).slice(0, limit).reverse();
}

// ── what the agent DID, not only what it said ───────────────────────────
//
// The phone drew messages and nothing else, so an agent that spent twenty
// minutes reading files, running tests and editing code appeared to have
// produced three sentences. The terminal shows the work; the companion showed
// the commentary. Everything needed is already in `SessionDetail.timeline` —
// every tool run with what it acted on — it simply was not being rendered.
//
// Tool runs are grouped rather than listed one per row: a turn is routinely
// twenty of them, and twenty rows of "Read" on a 412px screen buries the
// sentence they belong to. One line per run of them, openable when you want the
// detail, which is how the terminal reads too.

export interface FeedTool {
  ts: number;
  tool?: string;
  target?: string | null;
  note?: string | null;
  is_error?: boolean;
  /** What the tool answered. Seeing what an agent RAN and never what came back
   *  is what still sends you to the terminal: a failing test and a passing one
   *  look identical without it. It has been on the wire the whole time. */
  output?: string | null;
  /** True when `output` is only the head of a longer result, so the screen can
   *  say so instead of implying the command was that quiet. */
  output_clipped?: boolean;
  /** Links an edit to its diff in `SessionDetail.changes`. */
  tool_use_id?: string | null;
  /** Which subagent produced this, when it was not the main thread. */
  agent_id?: string | null;
  agent_type?: string | null;
}

export interface FeedEntry extends FeedTool {
  kind: "message" | "tool";
  role?: "user" | "assistant";
  text?: string;
}

export type FeedItem =
  | { kind: "message"; ts: number; role: "user" | "assistant"; text: string }
  /** A turn that was cut off. Not a message — see NOISE below. */
  | { kind: "note"; ts: number; text: string }
  /** Consecutive tool runs from one agent, oldest first, as one openable block. */
  | { kind: "tools"; ts: number; runs: FeedTool[]; errors: number; agent?: string | null };

/**
 * Lines that are transcript bookkeeping rather than conversation.
 *
 * Claude Code writes these into the JSONL itself, the scanner ingests them like
 * any other message, and the phone drew them as chat bubbles — so a session
 * that had been interrupted twice read as an agent that had said
 * "[Request interrupted by user]" to you, twice, in its own voice.
 *
 * Dropped outright would be worse: that a turn was cut off is a real fact about
 * the session and losing it makes the gap in the conversation inexplicable. So
 * they become a note — one thin centred line, not a thing anybody said.
 */
const NOISE: Record<string, string> = {
  "[Request interrupted by user]": "You interrupted this turn",
  "[Request interrupted by user for tool use]": "You interrupted this turn",
  "No response requested.": "No reply was asked for",
};

/**
 * How many messages survive no matter how hard the agent is working.
 *
 * The window used to be a flat count of timeline entries, and a tool run is an
 * entry. So a turn that touched forty files spent the whole budget on tool rows
 * and evicted every message — the harder the agent worked, the less of what it
 * said you could see, which is exactly backwards and exactly the complaint.
 * Messages and tools get separate budgets now.
 */
const MESSAGE_FLOOR = 50;

/**
 * The conversation as a feed: messages and the work between them, in order.
 *
 * `timeline` arrives newest-first (the server's budget drops the oldest), so
 * this walks from the newest end, spends the two budgets independently, and
 * turns the result back round.
 */
export function buildFeed(
  timeline: readonly FeedEntry[] | undefined,
  limit = 120,
  messageFloor = MESSAGE_FLOOR,
): FeedItem[] {
  // The floor is a guarantee inside the window, never a way past it. A caller
  // asking for ten entries must get ten, not fifty.
  const floor = Math.min(messageFloor, limit);
  const toolBudget = Math.max(0, limit - floor);
  const kept: FeedEntry[] = [];
  let messages = 0;
  let tools = 0;
  for (const e of timeline ?? []) {
    if (e.kind === "message") {
      if (messages >= floor) continue;
      messages++;
    } else {
      if (tools >= toolBudget) continue;
      tools++;
    }
    kept.push(e);
    if (messages >= floor && tools >= toolBudget) break;
  }
  kept.reverse();

  const out: FeedItem[] = [];
  for (const e of kept) {
    if (e.kind === "message") {
      if (!e.text) continue;
      const note = NOISE[e.text.trim()];
      if (note) { out.push({ kind: "note", ts: e.ts, text: note }); continue; }
      out.push({ kind: "message", ts: e.ts, role: e.role ?? "assistant", text: e.text });
      continue;
    }
    const last = out[out.length - 1];
    const run: FeedTool = {
      ts: e.ts, tool: e.tool, target: e.target, note: e.note, is_error: e.is_error,
      output: e.output, output_clipped: e.output_clipped, tool_use_id: e.tool_use_id,
      agent_id: e.agent_id, agent_type: e.agent_type,
    };
    // A block belongs to one agent. Merging a subagent's runs into the main
    // thread's is how four agents working in parallel read as one very busy
    // one, and the tag to keep them apart is already on every entry.
    if (last && last.kind === "tools" && (last.runs[0]?.agent_id ?? null) === (e.agent_id ?? null)) {
      last.runs.push(run);
      if (e.is_error) last.errors++;
    } else {
      out.push({
        kind: "tools", ts: e.ts, runs: [run], errors: e.is_error ? 1 : 0,
        agent: e.agent_type ?? (e.agent_id ? "subagent" : null),
      });
    }
  }
  return out;
}

/** A one-line summary of a block of tool runs: what it did, and how much. */
export function summariseRuns(runs: readonly FeedTool[]): string {
  const counts = new Map<string, number>();
  for (const r of runs) counts.set(r.tool || "tool", (counts.get(r.tool || "tool") ?? 0) + 1);
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([tool, n]) => (n > 1 ? `${tool} ×${n}` : tool));
  const rest = counts.size > 3 ? ` +${counts.size - 3} more` : "";
  return parts.join(" · ") + rest;
}

/** The end of a path, or the head of a command — the part that identifies a
 *  run on a narrow screen. The rest is prefix you already know. */
export function shortTarget(target: string | null | undefined, max = 46): string {
  if (!target) return "";
  const oneLine = target.replace(/\s+/g, " ").trim();
  const tail = oneLine.includes("/") && !oneLine.includes(" ")
    ? oneLine.split("/").slice(-2).join("/")
    : oneLine;
  return tail.length > max ? tail.slice(0, max - 1) + "…" : tail;
}
