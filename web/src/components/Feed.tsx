import { memo, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import type { WatchEvent } from "../../../shared/types.ts";
import { Panel } from "./Panel.tsx";
import { Portal } from "./Portal.tsx";
import { friendly, detail, DOT_COLOR } from "../lib/labels.ts";
import { fmtTime, fmtMs, fmtUsd, agentKey, hashColor } from "../lib/format.ts";

type Category = "all" | "tools" | "chat" | "alerts";

const CATS: { key: Category; label: string }[] = [
  { key: "all", label: "all" },
  { key: "tools", label: "tools" },
  { key: "chat", label: "chat" },
  { key: "alerts", label: "alerts" },
];

const TOOL_TYPES = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure"]);
const ALERT_TYPES = new Set(["Notification", "PermissionRequest", "PostToolUseFailure", "PreCompact"]);

function inCategory(e: WatchEvent, cat: Category): boolean {
  if (cat === "all") return true;
  if (cat === "tools") return TOOL_TYPES.has(e.hook_event_type);
  if (cat === "alerts") return ALERT_TYPES.has(e.hook_event_type) || !!e.is_error;
  return !TOOL_TYPES.has(e.hook_event_type); // chat: prompts, turns, sessions, subagents
}

/** One display row — either a single event, a still-running tool, or a coalesced ×N group. */
interface Row {
  key: string;
  e: WatchEvent;
  running: boolean;
  count: number;
}

/**
 * Turn the raw event stream into readable rows:
 *  1. Pair PreToolUse→Post — once a tool finishes, only the finished line remains;
 *     unfinished Pre events render as a pulsing "running" row. Rows are keyed by
 *     tool_use_id so a running row morphs in place into its finished row.
 *  2. Coalesce consecutive identical rows (same agent + type + detail) into ×N.
 */
function buildRows(events: WatchEvent[], pairPool: WatchEvent[] = events): Row[] {
  // Post lookups for pairing — computed over the FULL buffer, not the filtered
  // view. Pairing against a filtered list made every finished tool in a
  // "PreToolUse"-filtered (or searched, or lane-sliced) view render as a
  // perpetually pulsing Running row, because its Post was filtered out.
  const postIds = new Set<string>();
  const postBySessTool = new Map<string, number[]>();
  for (const e of pairPool) {
    if (e.hook_event_type !== "PostToolUse" && e.hook_event_type !== "PostToolUseFailure") continue;
    if (e.tool_use_id) postIds.add(e.tool_use_id);
    if (e.tool_name) {
      const k = `${e.session_id}|${e.tool_name}`;
      const arr = postBySessTool.get(k) ?? [];
      arr.push(e.timestamp);
      postBySessTool.set(k, arr);
    }
  }

  const rows: Row[] = [];
  for (const e of events) {
    if (e.hook_event_type === "PreToolUse") {
      // Skip the Pre if its Post already arrived — the finished line tells the story.
      const done = e.tool_use_id
        ? postIds.has(e.tool_use_id)
        : (postBySessTool.get(`${e.session_id}|${e.tool_name}`) ?? []).some((t) => t >= e.timestamp);
      if (done) continue;
      rows.push({ key: e.tool_use_id ? `t:${e.tool_use_id}` : `e:${e.id}`, e, running: true, count: 1 });
      continue;
    }
    const key =
      (e.hook_event_type === "PostToolUse" || e.hook_event_type === "PostToolUseFailure") && e.tool_use_id
        ? `t:${e.tool_use_id}`
        : `e:${e.id}`;
    // Coalesce with the previous row when it reads identically.
    const prev = rows[rows.length - 1];
    if (
      prev &&
      !prev.running &&
      prev.e.hook_event_type === e.hook_event_type &&
      prev.e.tool_name === e.tool_name &&
      agentKey(prev.e) === agentKey(e) &&
      detail(prev.e) === detail(e)
    ) {
      prev.count++;
      prev.e = e; // keep the newest timestamp/cost visible
      continue;
    }
    rows.push({ key, e, running: false, count: 1 });
  }
  return rows;
}

/** One feed line — shared between the single stream and the per-session lanes. */
function EventRowInner({ row, onSelect, compact }: { row: Row; onSelect?: (e: WatchEvent) => void; compact?: boolean }) {
  const { e, running, count } = row;
  const f = running ? { verb: "Running", color: "#a78bfa", dot: "run" as const } : friendly(e);
  const d = detail(e);
  const aKey = agentKey(e);
  const aColor = hashColor(aKey);
  return (
    <motion.div
      onClick={() => onSelect?.(e)}
      initial={{ opacity: 0, x: -12, backgroundColor: `color-mix(in srgb, ${f.color} 22%, transparent)` }}
      animate={{ opacity: 1, x: 0, backgroundColor: "rgba(0,0,0,0)" }}
      whileHover={{ backgroundColor: "color-mix(in srgb, var(--primary) 12%, transparent)" }}
      transition={{ duration: 0.5 }}
      className="relative flex items-center gap-2 py-1 pr-1.5 pl-3 rounded-md text-[11px] cursor-pointer min-w-0"
    >
      {/* inset rounded rail per agent — matches the session cards */}
      <span className="absolute left-[3px] top-1 bottom-1 w-[3px] rounded-full" style={{ background: `color-mix(in srgb, ${aColor} 70%, transparent)` }} />
      <span className="t-dim2 tabular-nums shrink-0">{fmtTime(e.timestamp)}</span>
      {running ? (
        <span className="h-2 w-2 rounded-full shrink-0 animate-pulse" style={{ background: DOT_COLOR.run, boxShadow: `0 0 6px ${DOT_COLOR.run}` }} />
      ) : (
        <span className="h-2 w-2 rounded-full shrink-0" style={{ background: DOT_COLOR[f.dot], boxShadow: `0 0 6px ${DOT_COLOR[f.dot]}` }} />
      )}
      <span className="shrink-0 font-medium" style={{ color: f.color }}>{f.verb}</span>
      {e.tool_name && (
        <span className="chip shrink-0" style={{ color: "var(--info)", background: "color-mix(in srgb, var(--info) 14%, transparent)" }}>{e.tool_name}</span>
      )}
      {d && <span className="truncate t-dim min-w-0" title={d}>{d}</span>}
      {running && <span className="shrink-0 t-dim2 animate-pulse">…</span>}
      {count > 1 && (
        <span className="chip shrink-0" style={{ color: "var(--warning)", background: "color-mix(in srgb, var(--warning) 14%, transparent)" }}>×{count}</span>
      )}
      {e.duration_ms != null && <span className="t-dim2 shrink-0">{fmtMs(e.duration_ms)}</span>}
      {e.cost_usd > 0 && <span className="shrink-0" style={{ color: "var(--success)" }}>{fmtUsd(e.cost_usd)}</span>}
      {/* in a lane the column header already names the agent — the per-row tag is noise there */}
      {!compact && <span className="ml-auto shrink-0 truncate max-w-[120px]" style={{ color: `color-mix(in srgb, ${aColor} 75%, var(--text4))` }} title={aKey}>{aKey}</span>}
    </motion.div>
  );
}

/**
 * Memoized on the row's *contents*, not its identity.
 *
 * Two things made this the most expensive thing on screen. The feed renders 120
 * rows, and App re-renders for any reason at all — a 4s stats poll, a 20s
 * options poll, the 10s tick — so all 120 `motion.div`s were rebuilt several
 * times a second with byte-identical props: 12.1ms of React work per commit
 * that changed nothing. And `buildRows` allocates fresh row objects every call,
 * so a plain memo() would compare identities that never match and buy nothing.
 *
 * Hence the explicit comparator. `count` and `running` are in it because a
 * coalesced ×N row and a running→finished tool change nothing else about the
 * row: leave either out and those rows silently stop updating.
 */
const EventRow = memo(EventRowInner, (a, b) =>
  a.row.key === b.row.key &&
  a.row.e.id === b.row.e.id &&
  a.row.count === b.row.count &&
  a.row.running === b.row.running &&
  a.compact === b.compact &&
  a.onSelect === b.onSelect
);

/** One session's column in the lanes view: its own header and its own scroll,
 *  pinned to the newest line — so three busy Claudes read as three tidy
 *  streams instead of one interleaved wall. */
function Lane({ aKey, rows, onSelect }: { aKey: string; rows: Row[]; onSelect?: (e: WatchEvent) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const color = hashColor(aKey);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [rows.length, rows[rows.length - 1]?.key]);
  return (
    <div className="flex flex-col min-w-0 min-h-0 rounded-lg" style={{ border: "1px solid color-mix(in srgb, var(--border) 35%, transparent)", background: "color-mix(in srgb, var(--bg3) 20%, transparent)" }}>
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b shrink-0" style={{ borderColor: "color-mix(in srgb, var(--border) 30%, transparent)" }}>
        <span className="h-2 w-2 rounded-full shrink-0" style={{ background: color, boxShadow: `0 0 6px ${color}` }} />
        <span className="text-[10.5px] font-medium truncate" style={{ color: `color-mix(in srgb, ${color} 75%, var(--text))` }} title={aKey}>{aKey}</span>
        <span className="ml-auto text-[9.5px] t-dim2 tabular-nums shrink-0">{rows.length}</span>
      </div>
      <div ref={ref} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-1 py-0.5">
        {rows.map((row) => <EventRow key={row.key} row={row} onSelect={onSelect} compact />)}
      </div>
    </div>
  );
}

const MAX_LANES = 4; // beyond four a lane is too narrow to read

function FeedInner({ events, filter, sessionProvider, onSelect, onClearFilter }: { events: WatchEvent[]; filter: { app: string; type: string; provider: string }; sessionProvider?: Map<string, string>; onSelect?: (e: WatchEvent) => void; onClearFilter?: () => void }) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<Category>("all");
  const [lanes, setLanes] = useState(false);
  const [follow, setFollow] = useState(true);
  const [pausedId, setPausedId] = useState<number | null>(null); // newest event id when following stopped
  const [full, setFull] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Toggle follow and remember where we paused, so we can count what's new since.
  const applyFollow = (next: boolean) => {
    setFollow(next);
    setPausedId(next ? null : (events.at(-1)?.id ?? 0));
  };
  const newCount = pausedId != null ? Math.max(0, (events.at(-1)?.id ?? 0) - pausedId) : 0;

  // Esc collapses the fullscreen view.
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFull(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full]);

  const shown = useMemo(() => {
    return events.filter((e) => {
      if (filter.app && e.source_app !== filter.app) return false;
      if (filter.type && e.hook_event_type !== filter.type) return false;
      // Provider filters at the session level, so an event with no model of its
      // own (e.g. a tool call) still matches via the session it belongs to.
      if (filter.provider && sessionProvider?.get(e.session_id) !== filter.provider) return false;
      if (!inCategory(e, cat)) return false;
      if (q) {
        const hay = `${e.hook_event_type} ${e.tool_name ?? ""} ${detail(e)} ${e.source_app}`.toLowerCase();
        try {
          if (!new RegExp(q, "i").test(hay)) return false;
        } catch {
          if (!hay.includes(q.toLowerCase())) return false;
        }
      }
      return true;
    });
    // `sessionProvider` is a fresh Map on every tick and every socket flush, but
    // the filter above only reads it when a provider filter is set — which is
    // not the default. Depending on it unconditionally re-ran this filter, and
    // re-rendered all 120 rows behind it, ten times a minute for a value nobody
    // was looking at.
  }, [events, filter.app, filter.type, filter.provider, filter.provider ? sessionProvider : null, cat, q]);

  const rows = useMemo(() => buildRows(shown, events).slice(-120), [shown, events]);

  // Lanes: the same filtered stream, split one column per session, most
  // recently active first. With several sessions running at once the single
  // feed interleaves into a wall — a lane per session keeps each story linear.
  const laneData = useMemo(() => {
    if (!lanes) return [];
    const by = new Map<string, WatchEvent[]>();
    for (const e of shown) {
      const k = agentKey(e);
      const arr = by.get(k);
      if (arr) arr.push(e); else by.set(k, [e]);
    }
    return [...by.entries()]
      .map(([k, evs]) => ({ key: k, last: evs[evs.length - 1].timestamp, rows: buildRows(evs, events).slice(-80) }))
      .sort((a, b) => b.last - a.last)
      .slice(0, MAX_LANES);
  }, [lanes, shown, events]);

  useEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [rows.length, rows[rows.length - 1]?.key, follow, full]);

  const live = { color: "var(--success)", background: "color-mix(in srgb, var(--success) 14%, transparent)", border: "1px solid color-mix(in srgb, var(--success) 42%, transparent)" };
  const attn = { color: "var(--warning)", background: "color-mix(in srgb, var(--warning) 15%, transparent)", border: "1px solid color-mix(in srgb, var(--warning) 45%, transparent)" };
  const paused = { color: "var(--text4)", background: "color-mix(in srgb, var(--bg3) 35%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" };
  const followToggle = (
    <motion.button
      onClick={() => applyFollow(!follow)}
      whileTap={{ scale: 0.94 }}
      title={follow ? "Following live — click to pause" : "Paused — click to jump back to live"}
      className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-semibold cursor-pointer select-none"
      style={follow ? live : newCount > 0 ? attn : paused}
    >
      {follow ? (
        <>
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full rounded-full opacity-70" style={{ background: "var(--success)", animation: "ping-ring 1.6s ease-out infinite" }} />
            <span className="relative inline-flex rounded-full h-2 w-2" style={{ background: "var(--success)" }} />
          </span>
          following live
        </>
      ) : newCount > 0 ? (
        <AnimatePresence mode="wait">
          <motion.span key={newCount} initial={{ y: -6, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="flex items-center gap-1 tabular-nums">
            <span aria-hidden>▼</span> {newCount > 99 ? "99+" : newCount} new
          </motion.span>
        </AnimatePresence>
      ) : (
        <>
          <span aria-hidden style={{ letterSpacing: "-1px" }}>❚❚</span> paused
        </>
      )}
    </motion.button>
  );

  const filterActive = !!(filter.app || filter.type);
  const filterBanner = filterActive && (
    <div
      className="flex items-center gap-2 mb-2 px-3 py-2 rounded-lg text-[11px]"
      style={{
        background: "color-mix(in srgb, var(--primary) 15%, transparent)",
        border: "1px solid color-mix(in srgb, var(--primary) 50%, transparent)",
        color: "var(--primary-hover)",
      }}
    >
      <span aria-hidden>⧉</span>
      <span className="font-semibold">Filtered</span>
      {filter.app && (
        <span className="chip" style={{ color: "var(--primary-hover)", background: "color-mix(in srgb, var(--primary) 22%, transparent)", borderColor: "color-mix(in srgb, var(--primary) 55%, transparent)" }}>
          app: {filter.app}
        </span>
      )}
      {filter.type && (
        <span className="chip" style={{ color: "var(--primary-hover)", background: "color-mix(in srgb, var(--primary) 22%, transparent)", borderColor: "color-mix(in srgb, var(--primary) 55%, transparent)" }}>
          event: {filter.type}
        </span>
      )}
      <span className="t-dim2 tabular-nums">· {rows.length} shown</span>
      <button
        onClick={onClearFilter}
        className="ml-auto flex items-center gap-1 rounded-md px-2 py-0.5 font-semibold cursor-pointer"
        style={{ color: "var(--bg2)", background: "var(--primary)" }}
      >
        clear ✕
      </button>
    </div>
  );

  const body = (
      <div className="flex flex-col h-full min-h-0">
        {filterBanner}
        <div className="flex items-center gap-2 mb-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search events — type to filter (regex ok, e.g. tool.*fail)"
            className="flex-1 min-w-0 px-3 py-1.5 rounded-lg text-[11px] outline-none"
            style={{ background: "color-mix(in srgb, var(--bg3) 40%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)", color: "var(--text)" }}
          />
          <div className="flex gap-1 shrink-0">
            {CATS.map((c) => (
              <button
                key={c.key}
                onClick={() => setCat(c.key)}
                className="chip cursor-pointer"
                style={
                  cat === c.key
                    ? { color: "var(--primary)", background: "color-mix(in srgb, var(--primary) 16%, transparent)", borderColor: "color-mix(in srgb, var(--primary) 50%, transparent)" }
                    : { color: "var(--text4)" }
                }
              >
                {c.label}
              </button>
            ))}
            <button
              onClick={() => setLanes((l) => !l)}
              title="one column per session — parallel sessions get their own lane"
              className="chip cursor-pointer"
              style={
                lanes
                  ? { color: "var(--primary)", background: "color-mix(in srgb, var(--primary) 16%, transparent)", borderColor: "color-mix(in srgb, var(--primary) 50%, transparent)" }
                  : { color: "var(--text4)" }
              }
            >
              ⫴ lanes
            </button>
          </div>
        </div>
        {lanes ? (
          <div className="flex-1 min-h-0 grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.max(1, laneData.length)}, minmax(0, 1fr))` }}>
            {laneData.map((l) => <Lane key={l.key} aKey={l.key} rows={l.rows} onSelect={onSelect} />)}
            {laneData.length === 0 && <div className="t-dim2 text-center py-8">no events match</div>}
          </div>
        ) : (
          <div ref={ref} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden pr-1"
            onScroll={(e) => {
              const el = e.currentTarget;
              const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
              if (atBottom !== follow) applyFollow(atBottom);
            }}
          >
            <AnimatePresence initial={false}>
              {rows.map((row) => <EventRow key={row.key} row={row} onSelect={onSelect} />)}
            </AnimatePresence>
            {rows.length === 0 && <div className="t-dim2 text-center py-8">no events match</div>}
          </div>
        )}
      </div>
  );

  return (
    <>
      <Panel
        eyebrow={filterActive ? "Live · filtered" : "Live"}
        title={filterActive ? `Live events — ${filter.app || filter.type}` : "Live events"}
        right={
          <div className="flex items-center gap-2.5">
            {!full && followToggle}
            <button
              title="Fullscreen — expand the live feed (Esc closes)"
              onClick={() => setFull(true)}
              className="chip cursor-pointer"
              style={{ color: "var(--text3)" }}
            >
              ⛶ expand
            </button>
          </div>
        }
      >
        {full ? (
          <div className="h-full flex items-center justify-center t-dim2 text-[11px]">feed is fullscreen — Esc to bring it back</div>
        ) : (
          body
        )}
      </Panel>

      <Portal>
        <AnimatePresence>
          {full && (
            <>
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="fixed inset-0" style={{ zIndex: 10000, background: "rgba(0,0,0,0.6)", backdropFilter: "blur(3px)" }} onClick={() => setFull(false)} />
              {/* Flex wrapper centers the card — Motion owns `transform` for its
                  scale/y animation, so Tailwind translate centering can't be used. */}
              <div className="fixed inset-0 flex items-center justify-center pointer-events-none" style={{ zIndex: 10001 }}>
                <motion.div
                  initial={{ opacity: 0, scale: 0.97, y: 12 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.98, y: 8 }}
                  transition={{ type: "spring", stiffness: 330, damping: 30 }}
                  className="w-[92vw] h-[90vh] rounded-2xl flex flex-col pointer-events-auto"
                  style={{ background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)", boxShadow: "0 30px 80px -20px rgba(0,0,0,0.8)" }}
                >
                  <div className="flex items-center justify-between px-5 py-3 border-b shrink-0" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                    <div>
                      <div className="panel-eyebrow">Live</div>
                      <div className="panel-title">Live events</div>
                    </div>
                    <div className="flex items-center gap-3">
                      {followToggle}
                      <button onClick={() => setFull(false)} className="text-[18px] leading-none px-2 t-dim2 hover:opacity-70" title="Collapse (Esc)">✕</button>
                    </div>
                  </div>
                  <div className="flex-1 min-h-0 px-5 pb-4 pt-3">{body}</div>
                </motion.div>
              </div>
            </>
          )}
        </AnimatePresence>
      </Portal>
    </>
  );
}

/** The whole panel, memoized: App re-renders for reasons the feed does not care
 *  about (a stats poll, an options poll), and each one rebuilt every row. */
export const Feed = memo(FeedInner);
