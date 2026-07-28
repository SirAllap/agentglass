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
}

export interface FeedEntry extends FeedTool {
  kind: "message" | "tool";
  role?: "user" | "assistant";
  text?: string;
}

export type FeedItem =
  | { kind: "message"; ts: number; role: "user" | "assistant"; text: string }
  /** Consecutive tool runs, oldest first, as one openable block. */
  | { kind: "tools"; ts: number; runs: FeedTool[]; errors: number };

/**
 * The conversation as a feed: messages and the work between them, in order.
 *
 * `timeline` arrives newest-first (the server's budget drops the oldest), so
 * this takes the newest `limit` entries and turns them back round.
 */
export function buildFeed(timeline: readonly FeedEntry[] | undefined, limit = 120): FeedItem[] {
  const recent = (timeline ?? []).slice(0, limit).reverse();
  const out: FeedItem[] = [];
  for (const e of recent) {
    if (e.kind === "message") {
      if (!e.text) continue;
      out.push({ kind: "message", ts: e.ts, role: e.role ?? "assistant", text: e.text });
      continue;
    }
    const last = out[out.length - 1];
    const run: FeedTool = { ts: e.ts, tool: e.tool, target: e.target, note: e.note, is_error: e.is_error };
    if (last && last.kind === "tools") {
      last.runs.push(run);
      if (e.is_error) last.errors++;
    } else {
      out.push({ kind: "tools", ts: e.ts, runs: [run], errors: e.is_error ? 1 : 0 });
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
