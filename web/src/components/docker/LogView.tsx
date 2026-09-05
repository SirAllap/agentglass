/*
 * A container's log, followed.
 *
 * What this replaces: a timer that re-fetched the whole tail every three
 * seconds and repainted it. That cost the daemon a full read four hundred lines
 * at a time forever, and it lost anything a busy container printed between two
 * polls. Both of those are fixed by holding one `docker logs --follow` open —
 * see lib/dockerLogFeed.ts, which owns everything about the feed that can be
 * tested without a daemon.
 *
 * The care in this file is about the two ways a live log ruins a UI:
 *
 *   - repainting per line. A container can print hundreds of lines a second and
 *     a re-render each would make the whole app stutter. Updates are coalesced
 *     into one repaint per frame.
 *   - growing without bound. The feed caps what it keeps; this caps what it
 *     draws, and says so rather than silently showing you a slice.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { createLogFeed, filterLines, levelOf, type LogFeed, type LogLevel } from "../../lib/dockerLogFeed.ts";
import { CODE_FONT_STYLE } from "../diff/DiffLines.tsx";

/** How many lines are drawn. The feed keeps more; a browser asked to lay out
 *  five thousand elements while more arrive is a browser that stutters. */
const DRAWN = 1500;

const LEVEL_TINT: Record<Exclude<LogLevel, null>, string> = {
  error: "var(--error)", warn: "var(--warning)", info: "var(--info)", debug: "var(--text3)",
};
/** Leading ISO-ish stamp, which is what `--timestamps` prepends. */
const STAMP = /^(\S*\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?)\s?/;

function Line({ line, needle }: { line: string; needle: string }) {
  const m = STAMP.exec(line);
  const stamp = m?.[1];
  const rest = stamp ? line.slice(m![0].length) : line;
  const tint = levelOf(rest);
  return (
    <div style={tint ? { color: LEVEL_TINT[tint] } : undefined}>
      {/* Dimmed rather than dropped: the timestamp is the column you scan by,
          and at full contrast it competes with the message it belongs to. */}
      {stamp && <span style={{ color: "var(--text4)", opacity: 0.55 }}>{stamp} </span>}
      {needle ? <Marked text={rest} needle={needle} /> : rest}
    </div>
  );
}

/** The search term, lit up where it appears. Without this a filtered view tells
 *  you the line matched but not where. */
function Marked({ text, needle }: { text: string; needle: string }) {
  const parts = useMemo(() => {
    const out: { t: string; hit: boolean }[] = [];
    const hay = text.toLowerCase();
    const q = needle.toLowerCase();
    let i = 0;
    for (;;) {
      const at = hay.indexOf(q, i);
      if (at < 0) { out.push({ t: text.slice(i), hit: false }); break; }
      if (at > i) out.push({ t: text.slice(i, at), hit: false });
      out.push({ t: text.slice(at, at + q.length), hit: true });
      i = at + q.length;
    }
    return out;
  }, [text, needle]);
  return <>{parts.map((p, i) => p.hit
    ? <mark key={i} style={{ background: "color-mix(in srgb, var(--warning) 35%, transparent)", color: "inherit", borderRadius: 2 }}>{p.t}</mark>
    : <span key={i}>{p.t}</span>)}</>;
}

const LEVELS: (Exclude<LogLevel, null> | null)[] = [null, "info", "warn", "error"];

export function LogView({ id, tail, running }: { id: string; tail: number; running: boolean }) {
  const feedRef = useRef<LogFeed | null>(null);
  const [, bump] = useState(0);
  const frame = useRef(0);
  const boxRef = useRef<HTMLPreElement>(null);
  const stuck = useRef(true);
  const [min, setMin] = useState<Exclude<LogLevel, null> | null>(null);
  const [q, setQ] = useState("");
  /** Set when the engine refuses to follow (too many streams, no daemon) — the
   *  snapshot is then fetched once, which is what the panel did before. */
  const [snapshot, setSnapshot] = useState<string | null>(null);

  // One repaint per frame however fast the lines arrive. Without this a chatty
  // container turns every line into a React render and the app stutters.
  const onChange = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => { frame.current = 0; bump((n) => n + 1); });
  }, []);

  useEffect(() => {
    setSnapshot(null);
    const feed = createLogFeed({
      open: (signal) => api.dockerLogStream(id, tail, signal),
      onChange,
    });
    feedRef.current = feed;
    return () => {
      feed.close();
      if (frame.current) { cancelAnimationFrame(frame.current); frame.current = 0; }
      feedRef.current = null;
    };
  }, [id, tail, onChange]);

  // A refusal is not a dead end: fall back to the one-shot the panel used
  // before, once, and say that it is a snapshot rather than pretending it will
  // keep moving.
  const ended = feedRef.current?.ended() ?? null;
  const noStream = !!ended && !feedRef.current?.lines().length;
  useEffect(() => {
    if (!noStream || snapshot !== null) return;
    let live = true;
    void api.dockerLogs(id, tail).then((r) => { if (live) setSnapshot(r.ok ? r.text : (r.error || "No logs")); });
    return () => { live = false; };
  }, [noStream, snapshot, id, tail]);

  const all = feedRef.current?.lines() ?? [];
  const shown = useMemo(() => filterLines(all, min, q), [all, min, q, feedRef.current?.lines().length]);
  const drawn = shown.length > DRAWN ? shown.slice(-DRAWN) : shown;
  const paused = feedRef.current?.paused() ?? false;
  const waiting = feedRef.current?.waiting() ?? 0;

  // Pinned to the bottom unless you have scrolled up, which is the one gesture
  // that means "I am reading, stop moving".
  useEffect(() => {
    const el = boxRef.current;
    if (el && stuck.current && !paused) el.scrollTop = el.scrollHeight;
  });

  return (
    <>
      <div className="flex items-center gap-1.5 px-3 py-1 border-b shrink-0" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
        {/* Live, or the reason it is not. Silence here would read as a frozen
            panel, which is the one thing a log viewer must never look like. */}
        <span className="text-[9.5px] px-1.5 py-0.5 rounded-md shrink-0"
          title={ended ?? (running ? "following this container" : "the container is not running")}
          style={ended
            ? { color: "var(--text4)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }
            : { color: "var(--success)", border: "1px solid color-mix(in srgb, var(--success) 40%, transparent)", background: "color-mix(in srgb, var(--success) 10%, transparent)" }}>
          {ended ? (snapshot !== null ? "snapshot" : "ended") : "live"}
        </span>

        {LEVELS.map((l) => (
          <button key={l ?? "all"} onClick={() => setMin(l)}
            className="text-[9.5px] px-1.5 py-0.5 rounded-md shrink-0 min-h-[20px]"
            title={l ? `Only ${l} and worse` : "Everything"}
            style={min === l
              ? { color: "var(--text)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)", background: "color-mix(in srgb, var(--primary) 14%, transparent)" }
              : { color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--border) 35%, transparent)" }}>
            {l ?? "all"}
          </button>
        ))}

        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="find in log"
          className="text-[10px] px-2 py-0.5 rounded-md outline-none min-w-0 flex-1 max-w-[220px]"
          style={{ background: "color-mix(in srgb, var(--bg3) 50%, transparent)", color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }} />

        {(q || min) && (
          <span className="text-[9.5px] t-dim2 tabular-nums shrink-0">{shown.length} of {all.length}</span>
        )}

        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          {drawn.length < shown.length && (
            <span className="text-[9.5px] t-dim2" title={`${shown.length} lines held, the last ${DRAWN} drawn`}>last {DRAWN}</span>
          )}
          <button onClick={() => { const f = feedRef.current; if (!f) return; f.paused() ? f.resume() : f.pause(); }}
            disabled={!!ended}
            className="text-[9.5px] px-2 py-0.5 rounded-md min-h-[20px] disabled:opacity-40"
            title={paused ? "Show what has arrived since" : "Hold the view still — the log keeps arriving"}
            style={paused
              ? { color: "var(--warning)", border: "1px solid color-mix(in srgb, var(--warning) 45%, transparent)", background: "color-mix(in srgb, var(--warning) 12%, transparent)" }
              : { color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--border) 35%, transparent)" }}>
            {paused ? (waiting ? `resume · ${waiting}` : "resume") : "pause"}
          </button>
        </div>
      </div>

      <pre ref={boxRef}
        onScroll={(e) => { const el = e.currentTarget; stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 28; }}
        className="agx-scroll flex-1 min-h-0 overflow-auto text-[11px] leading-[1.55] px-4 py-2 whitespace-pre-wrap break-all"
        style={{ ...CODE_FONT_STYLE, background: "var(--bg)", color: "var(--text2)" }}>
        {snapshot !== null
          ? snapshot.split("\n").map((l, i) => <Line key={i} line={l} needle={q} />)
          : drawn.length
            ? drawn.map((l, i) => <Line key={i} line={l} needle={q} />)
            : ended ? ended : "…"}
      </pre>
    </>
  );
}
