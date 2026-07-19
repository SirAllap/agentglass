import type { WatchEvent, OpenToolCall } from "../../../shared/types.ts";
import { agentKey, fmtMs } from "./format.ts";

export type AgentStatus = "working" | "waiting" | "errored" | "idle";

export interface AgentCard {
  key: string;
  source_app: string;
  session_id: string;
  model_name: string | null;
  status: AgentStatus;
  lastAction: string;
  lastType: string;
  events: number;
  tools: number;
  errors: number;
  cost: number;
  tokens: number;
  lastSeen: number;
  lastErrorTs: number;
  spark: number[]; // events per recent bucket
  /** Distinct subagents this session spawned (by agent_id). */
  subagents: number;
  /** Subagent type → count, most common first (e.g. Explore, workflow-subagent). */
  subagentTypes: [string, number][];
  /** A tool call that started (PreToolUse) and hasn't reported back yet. */
  runningTool: string | null;
  runningSince: number;
  /** Context-window estimate: the latest turn's full prompt size (input +
   *  cache read + cache write — each API call re-sends the conversation, so
   *  that sum IS the context). 0 = no turn seen yet. */
  ctxTokens: number;
  ctxTs: number;
  ctxLimit: number;
}

/** Context-window ceiling by model — coarse, for the radar's "how close to
 *  compaction" scale. Unknown models get Claude's 200k. */
function ctxLimitOf(model: string | null): number {
  const m = (model || "").toLowerCase();
  if (m.includes("gemini")) return 1_000_000;
  if (m.includes("gpt-5")) return 400_000;
  if (m.includes("gpt") || /^o[134]/.test(m)) return 128_000;
  return 200_000;
}

const STALL_MS = 20_000;
const IDLE_MS = 5 * 60_000;
// An open tool call older than this is a lost pair (crashed session, dropped
// event), not a genuinely long build — stop vouching for it as "working".
const TOOL_RUN_MAX_MS = 30 * 60_000;
// An open tool call this old is worth a heads-up: probably a long build,
// possibly a hang — either way the user wants to know it's still open.
const TOOL_RUN_WARN_MS = 5 * 60_000;

function blankCard(key: string, source_app: string, session_id: string, model_name: string | null): AgentCard {
  return {
    key,
    source_app,
    session_id,
    model_name,
    status: "idle",
    lastAction: "",
    lastType: "",
    events: 0,
    tools: 0,
    errors: 0,
    cost: 0,
    tokens: 0,
    lastSeen: 0,
    lastErrorTs: 0,
    spark: new Array(20).fill(0),
    subagents: 0,
    subagentTypes: [],
    runningTool: null,
    runningSince: 0,
    ctxTokens: 0,
    ctxTs: 0,
    ctxLimit: 200_000,
  };
}

/** Roll the live event buffer up into per-agent cards. `openTools` is the
 *  server's authoritative list of still-running tool calls, used to keep (or
 *  restore) a session's "running" state when the originating PreToolUse has aged
 *  out of `events` — otherwise a long job in flight reads as idle or vanishes. */
export function deriveAgents(events: WatchEvent[], openTools: OpenToolCall[] = []): AgentCard[] {
  const now = Date.now();
  const map = new Map<string, AgentCard>();
  // Subagents fold into their parent session_id but carry agent_id/agent_type,
  // so track the distinct subagents (and their kinds) seen per session.
  const subs = new Map<string, Map<string, string>>(); // key → (agent_id → agent_type)

  // Finished-tool lookups, so an open PreToolUse can be told apart from one
  // whose Post already landed (same pairing the feed does). A quiet session
  // mid-build emits nothing for minutes — the open Pre is the only evidence
  // it's still working rather than idle.
  const postIds = new Set<string>();
  const postBySessTool = new Map<string, number[]>();
  for (const e of events) {
    if (e.hook_event_type !== "PostToolUse" && e.hook_event_type !== "PostToolUseFailure") continue;
    if (e.tool_use_id) postIds.add(e.tool_use_id);
    if (e.tool_name) {
      const k = `${e.session_id}|${e.tool_name}`;
      const arr = postBySessTool.get(k) ?? [];
      arr.push(e.timestamp);
      postBySessTool.set(k, arr);
    }
  }

  for (const e of events) {
    const key = agentKey(e);
    let a = map.get(key);
    if (!a) {
      a = blankCard(key, e.source_app, e.session_id, e.model_name);
      map.set(key, a);
    }
    // Context estimate from the newest MAIN-session turn. Subagent turns are
    // excluded — a subagent has its own context, not the session's.
    if (!e.agent_id) {
      const turnTok = e.input_tokens + e.cache_read_tokens + e.cache_creation_tokens;
      if (turnTok > 0 && e.timestamp >= a.ctxTs) { a.ctxTokens = turnTok; a.ctxTs = e.timestamp; }
    }
    if (e.hook_event_type === "PreToolUse" && e.timestamp >= a.runningSince) {
      const done = e.tool_use_id
        ? postIds.has(e.tool_use_id)
        : (postBySessTool.get(`${e.session_id}|${e.tool_name}`) ?? []).some((t) => t >= e.timestamp);
      if (!done) { a.runningTool = e.tool_name || "tool"; a.runningSince = e.timestamp; }
    }
    if (e.agent_id) {
      let m = subs.get(key);
      if (!m) subs.set(key, (m = new Map()));
      // Don't let a later type-less event downgrade a known subagent type
      // (inner tool events don't re-carry it) back to the generic fallback.
      const prev = m.get(e.agent_id);
      if (e.agent_type || !prev) m.set(e.agent_id, e.agent_type || prev || "subagent");
    }
    a.events++;
    if (e.hook_event_type === "PostToolUse" || e.hook_event_type === "PostToolUseFailure") a.tools++;
    if (e.is_error) { a.errors++; if (e.timestamp >= a.lastErrorTs) a.lastErrorTs = e.timestamp; }
    a.cost += e.cost_usd;
    a.tokens += e.input_tokens + e.output_tokens;
    if (e.timestamp >= a.lastSeen) {
      a.lastSeen = e.timestamp;
      a.lastType = e.hook_event_type;
      if (e.model_name) a.model_name = e.model_name; // latest, not last-in-array
      a.lastAction = e.tool_name
        ? `${e.hook_event_type} · ${e.tool_name}`
        : e.hook_event_type;
    }
  }

  // Seed "running" state from the server's authoritative open-tool list, for
  // tool calls whose PreToolUse isn't in the buffer (aged out on a busy fleet,
  // or never loaded after a reload). A session with ALL its events evicted gets
  // its card recreated here so it doesn't vanish from Fleet/Radar mid-run.
  for (const s of openTools) {
    // A Post already in the buffer means the tool finished after the seed was
    // taken — don't resurrect it as running.
    const closed = (postBySessTool.get(`${s.session_id}|${s.tool_name}`) ?? []).some((t) => t >= s.since);
    if (closed) continue;
    const key = `${s.source_app}:${s.session_id}`;
    let a = map.get(key);
    if (!a) {
      a = blankCard(key, s.source_app, s.session_id, null);
      a.lastSeen = s.since;
      a.lastType = "PreToolUse";
      map.set(key, a);
    }
    if (s.since >= a.runningSince) { a.runningTool = s.tool_name; a.runningSince = s.since; }
  }

  // Spark buckets over the last 20 * 3s = 60s window.
  const bucketMs = 3000;
  for (const e of events) {
    const a = map.get(agentKey(e))!;
    const idx = 19 - Math.floor((now - e.timestamp) / bucketMs);
    if (idx >= 0 && idx < 20) a.spark[idx]++;
  }

  for (const a of map.values()) {
    const since = now - a.lastSeen;
    // A session that ended can't still be running a tool, whatever pair we
    // think is open; and an open pair past the ceiling is lost, not long.
    if (a.lastType === "Stop" || a.lastType === "SessionEnd" || (a.runningTool && now - a.runningSince >= TOOL_RUN_MAX_MS)) {
      a.runningTool = null;
    }
    const running = !!a.runningTool;
    // Anything idle long enough is idle, regardless of what it was doing —
    // otherwise an abandoned "waiting"/"errored" agent stays lit forever and
    // keeps re-triggering its alert. An open tool call is the one exception:
    // a long build emits no events while it runs, and reading that silence as
    // idle is exactly the slow-vs-hung false positive to avoid.
    if ((since >= IDLE_MS && !running) || a.lastType === "Stop" || a.lastType === "SessionEnd") a.status = "idle";
    else if (a.lastType === "PermissionRequest" || a.lastType === "Notification") a.status = "waiting";
    // Errored only on a RECENT error, not a lifetime count — one transient
    // failure early shouldn't paint a now-healthy agent red for its whole run.
    else if (now - a.lastErrorTs < STALL_MS) a.status = "errored";
    else if (since < STALL_MS || running) a.status = "working";
    else a.status = "idle";
    // While a tool call is open, its live duration is the most informative
    // thing the card can say — better than the stale "PreToolUse · Bash".
    if (a.status === "working" && running) a.lastAction = `running ${a.runningTool} · ${fmtMs(now - a.runningSince)}`;

    a.ctxLimit = ctxLimitOf(a.model_name);

    const m = subs.get(a.key);
    if (m) {
      a.subagents = m.size;
      const byType = new Map<string, number>();
      for (const type of m.values()) byType.set(type, (byType.get(type) ?? 0) + 1);
      a.subagentTypes = [...byType.entries()].sort((x, y) => y[1] - x[1]);
    }
  }

  return [...map.values()].sort((a, b) => b.lastSeen - a.lastSeen);
}

export interface Alert {
  id: string;
  level: "warn" | "error" | "info";
  agent: string;
  text: string;
  ts: number;
}

export function deriveAlerts(agents: AgentCard[]): Alert[] {
  const now = Date.now();
  const out: Alert[] = [];
  for (const a of agents) {
    if (a.status === "waiting")
      out.push({ id: "wait:" + a.key, level: "warn", agent: a.key, text: "waiting for approval / input", ts: a.lastSeen });
    if (a.status === "errored")
      out.push({ id: "err:" + a.key, level: "error", agent: a.key, text: `${a.errors} error(s) — last action ${a.lastAction}`, ts: a.lastSeen });
    // A tool call open this long deserves eyes: could be a fat build, could be
    // a hang — the alert says which tool and for how long, and the user knows
    // which of the two their project makes plausible.
    if (a.status === "working" && a.runningTool && now - a.runningSince >= TOOL_RUN_WARN_MS)
      out.push({ id: "long:" + a.key, level: "warn", agent: a.key, text: `${a.runningTool} running for ${fmtMs(now - a.runningSince)} — long job or stuck?`, ts: a.runningSince });
    const rate = a.tools > 3 ? a.errors / a.tools : 0;
    if (rate > 0.25)
      out.push({ id: "rate:" + a.key, level: "error", agent: a.key, text: `high failure rate ${(rate * 100).toFixed(0)}%`, ts: a.lastSeen });
  }
  return out.sort((x, y) => y.ts - x.ts);
}
