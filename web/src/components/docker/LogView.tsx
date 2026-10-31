/*
 * A container's log, followed.
 *
 * One `docker logs --follow` stays open (lib/dockerLogFeed.ts owns everything
 * about the feed that a test can reach without a daemon); there is no timer
 * that re-reads the tail. This file is the other half of the care:
 *
 *   - repainting per line. A container can print hundreds of lines a second, so
 *     updates are coalesced into one repaint per frame.
 *   - growing without bound. The feed caps what it keeps; this caps what it
 *     draws, and says so rather than silently showing a slice.
 *
 * What a line is, how the levels count and how the find walks its matches are
 * decided in lib/dockerDetail.ts.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { createLogFeed, type LogFeed } from "../../lib/dockerLogFeed.ts";
import {
  hitsIn, lastIndexOf, levelCounts, markSegments, pauseLabel, readLog, shownBy, stepHit, streamChip,
  type LevelPick, type LogEntry,
} from "../../lib/dockerDetail.ts";
import { CaretIcon, RefreshIcon, SearchIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { Select } from "../Select.tsx";
import { BAR_INPUT, Button, EDGE, IconButton, INPUT_STYLE, Segmented } from "../workspace/Chrome.tsx";

/** How many lines are drawn. The feed keeps more; a browser asked to lay out
 *  five thousand elements while more arrive is a browser that stutters. */
const DRAWN = 1500;
export const TAILS = [100, 200, 400, 1000, 2000];

function Line({ e, q, first, cur, lastErr }: { e: LogEntry; q: string; first: number; cur: number; lastErr: boolean }) {
  return (
    <span className="ln" data-lv={e.level} data-tag={e.tagged || undefined} data-lasterr={lastErr || undefined}>
      {e.time && <span className="ts" title={e.stamp ?? undefined}>{e.time}</span>}
      {markSegments(e.text, q, first).map((s, i) => s.hit === null ? s.t
        : <mark key={i} data-hit={s.hit} data-cur={s.hit === cur || undefined}>{s.t}</mark>)}
      {!e.text && !e.time && "\u200b"}
    </span>
  );
}

export function LogView({ id, tail, onTail, running, errorTick = 0 }: {
  id: string; tail: number; onTail: (n: number) => void; running: boolean;
  /** Bumped by "Show in log": scroll to the last error, whatever the filter. */
  errorTick?: number;
}) {
  const feedRef = useRef<LogFeed | null>(null);
  const [tick, bump] = useState(0);
  const frame = useRef(0);
  const boxRef = useRef<HTMLPreElement>(null);
  const stuck = useRef(true);
  const wantErr = useRef(false);
  const wantHit = useRef(false);
  const [away, setAway] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [pick, setPick] = useState<LevelPick>("all");
  const [q, setQ] = useState("");
  const [fi, setFi] = useState(0);
  /** Set when the engine refuses to follow (too many streams, no daemon): the
   *  snapshot is then fetched once, which is what the panel did before. */
  const [snapshot, setSnapshot] = useState<string | null>(null);

  const onChange = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => { frame.current = 0; bump((n) => n + 1); });
  }, []);

  useEffect(() => {
    setSnapshot(null);
    const feed = createLogFeed({ open: (signal) => api.dockerLogStream(id, tail, signal), onChange });
    feedRef.current = feed;
    return () => {
      feed.close();
      if (frame.current) { cancelAnimationFrame(frame.current); frame.current = 0; }
      feedRef.current = null;
    };
  }, [id, tail, onChange, epoch]);

  const ended = feedRef.current?.ended() ?? null;
  const feedLines = feedRef.current?.lines() ?? [];
  const noStream = !!ended && !feedLines.length;
  useEffect(() => {
    if (!noStream || snapshot !== null) return;
    let live = true;
    void api.dockerLogs(id, tail).then((r) => { if (live) setSnapshot(r.ok ? r.text : (r.error || "No logs")); });
    return () => { live = false; };
  }, [noStream, snapshot, id, tail]);

  const lines = snapshot !== null ? snapshot.split("\n") : feedLines;
  // `tick` is the version: the feed trims in place, so its length alone can stand still while the lines move.
  const entries = useMemo(() => readLog(lines), [tick, snapshot, lines.length]);
  const counts = levelCounts(entries);
  const shown = shownBy(entries, pick);
  const drawn = shown.length > DRAWN ? shown.slice(-DRAWN) : shown;
  const hits = hitsIn(drawn, q);
  const at = hits.total ? ((fi % hits.total) + hits.total) % hits.total : 0;
  const errAt = lastIndexOf(drawn, "error");
  const paused = feedRef.current?.paused() ?? false;
  const waiting = feedRef.current?.waiting() ?? 0;
  const chip = streamChip({ running, ended: snapshot !== null ? "snapshot" : ended, paused });

  useEffect(() => {
    if (!errorTick) return;
    setPick("all");
    wantErr.current = true;
    bump((n) => n + 1);
  }, [errorTick]);

  // Pinned to the bottom unless scrolled up, the one gesture that means "I am reading, stop moving".
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    if (wantErr.current) {
      wantErr.current = false;
      const t = el.querySelector<HTMLElement>("[data-lasterr]");
      if (t) { t.scrollIntoView({ block: "center" }); t.dataset.flash = "true"; }
      return;
    }
    if (wantHit.current) {
      wantHit.current = false;
      const t = el.querySelector("mark[data-cur]");
      if (t) { t.scrollIntoView({ block: "center" }); return; }
    }
    if (stuck.current && !paused) el.scrollTop = el.scrollHeight;
  });

  const go = (dir: 1 | -1) => { setFi(stepHit(at, hits.total, dir)); wantHit.current = true; };
  const countText = q.trim() ? (hits.total ? `${at + 1} of ${hits.total}` : "no match") : `last ${drawn.length}`;
  const levels: { id: LevelPick; name: string }[] = [{ id: "all", name: "All" }, { id: "error", name: "Errors" }, { id: "warn", name: "Warnings" }, { id: "info", name: "Info" }];

  return (
    <>
      <div className="dk-lt">
        <span className="dk-st" data-k={chip.key} role="status"
          title={ended ?? (running ? "following this container" : "the container is not running")}>
          <i />{chip.word}
        </span>
        <Segmented track label="Log level" value={pick} onChange={setPick}
          options={levels.map((l) => ({
            id: l.id,
            label: <>{l.name}<span className="dk-cn" data-l={l.id}>{counts[l.id]}</span></>,
          }))} />
        <div className="fld">
          <SearchIcon size={ICON.sm} />
          <input value={q} onChange={(e) => { setQ(e.target.value); setFi(0); wantHit.current = true; }} placeholder="Find in log" aria-label="Find in log"
            spellCheck={false} autoComplete="off" className={`w-full ${BAR_INPUT}`} style={{ ...INPUT_STYLE, paddingLeft: 28 }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); go(e.shiftKey ? -1 : 1); } }} />
        </div>
        <span className="cnt">{countText}</span>
        <IconButton onClick={() => go(-1)} title="Previous match (Shift+Enter)" bare disabled={!hits.total}><span style={{ display: "flex", transform: "rotate(180deg)" }}><CaretIcon size={ICON.sm} /></span></IconButton>
        <IconButton onClick={() => go(1)} title="Next match (Enter)" bare disabled={!hits.total}><span style={{ display: "flex" }}><CaretIcon size={ICON.sm} /></span></IconButton>
        <span className="sp" />
        <Select value={String(tail)} onChange={(v) => onTail(Number(v))} align="right" title="How many lines to read"
          className="text-[11px] px-2.5 min-h-[28px] rounded-lg outline-none"
          style={{ background: "var(--surface-inset)", color: "var(--text2)", border: EDGE }}
          options={TAILS.map((n) => ({ value: String(n), label: `Last ${n} lines` }))} />
        {chip.key === "ended"
          ? <Button onClick={() => setEpoch((n) => n + 1)} title="Open the stream again"><RefreshIcon size={ICON.sm} />Reconnect</Button>
          : (chip.key === "live" || chip.key === "paused") && (
            <Button onClick={() => { const f = feedRef.current; if (!f) return; if (f.paused()) f.resume(); else f.pause(); }}
              title={paused ? "Show what has arrived since" : "Hold the view still; the log keeps arriving"}
              {...(paused ? { tone: "warn" as const } : {})}>
              {pauseLabel(paused, waiting)}
            </Button>
          )}
      </div>

      <div className="dk-logwrap">
        <pre ref={boxRef} className="dk-log agx-scroll" tabIndex={0} aria-label="Log" data-cid={id}
          onScroll={(e) => {
            const el = e.currentTarget;
            const near = el.scrollHeight - el.scrollTop - el.clientHeight < 28;
            stuck.current = near;
            setAway(!near);
          }}>
          {drawn.length
            ? drawn.map((e, i) => <Line key={i} e={e} q={q} first={hits.offsets[i]!} cur={at} lastErr={i === errAt} />)
            : <span className="dim">{entries.length ? "Nothing matches." : ended ? ended : "Waiting for the first line…"}</span>}
        </pre>
        {away && (
          <span className="dk-jump">
            <Button tone="primary" onClick={() => { const el = boxRef.current; if (el) el.scrollTop = el.scrollHeight; stuck.current = true; setAway(false); }}>
              <span style={{ display: "flex", transform: "rotate(90deg)" }}><CaretIcon size={ICON.xs} /></span>Jump to latest
            </Button>
          </span>
        )}
      </div>
      {chip.key === "ended" && <div className="dk-logend">The stream ended ({ended}). What was already read stays above.</div>}
      {drawn.length < shown.length && <div className="dk-logend">{shown.length} lines held, the last {DRAWN} drawn.</div>}
    </>
  );
}
