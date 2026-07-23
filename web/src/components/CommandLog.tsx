// The git commands this app ran, live.
//
// Everything else in the panel is a button that quietly runs git on your
// repository. That's a black box, and the more powerful it gets — staging
// hunks, deleting branches in bulk, rebasing — the less comfortable the box
// should be. lazygit's command log is the answer: show every invocation as it
// happens. It costs almost nothing, it turns "I hope that did what I wanted"
// into something you can read, and it makes a bug report a copy-paste.
//
// Reads are hidden by default. The panel polls, so `status` and `for-each-ref`
// would otherwise scroll the one line you cared about off the top within
// seconds.

import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import type { GitLogEntry } from "../../../shared/types.ts";

const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour12: false });

export function CommandLog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [entries, setEntries] = useState<GitLogEntry[]>([]);
  const [writesOnly, setWritesOnly] = useState(true);
  const since = useRef(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Whether to keep pinned to the newest line. Scrolling up to read means you
  // want to stay there, so new output must not yank you back down.
  const stuck = useRef(true);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const tick = () =>
      api.gitCommandLog(since.current)
        .then(({ entries: fresh }) => {
          if (!alive || !fresh.length) return;
          since.current = fresh[fresh.length - 1].id;
          // Bounded here as well as on the server: a long session would
          // otherwise grow this array without limit.
          setEntries((prev) => [...prev, ...fresh].slice(-500));
        })
        .catch(() => {});
    tick();
    const id = setInterval(tick, 1000);
    return () => { alive = false; clearInterval(id); };
  }, [open]);

  const shown = writesOnly ? entries.filter((e) => e.write) : entries;

  useEffect(() => {
    if (stuck.current) bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [shown.length]);

  if (!open) return null;
  return (
    <div className="shrink-0 flex flex-col border-t" style={{ height: 168, borderColor: "color-mix(in srgb, var(--border) 40%, transparent)", background: "color-mix(in srgb, var(--bg3) 25%, transparent)" }}>
      <div className="shrink-0 flex items-center gap-2 px-3 py-1">
        <span className="text-[9.5px] uppercase tracking-wider font-semibold" style={{ color: "var(--text2)" }}>Command log</span>
        <span className="text-[9px] tabular-nums t-dim2">{shown.length}</span>
        <button onClick={() => setWritesOnly((v) => !v)}
          title={writesOnly ? "Also show the read-only queries the panel runs while polling" : "Show only commands that can change the repository"}
          className="text-[9px] px-1.5 py-0.5 rounded"
          style={{ color: writesOnly ? "var(--text)" : "var(--text3)", border: "1px solid color-mix(in srgb, var(--border) 28%, transparent)" }}>
          {writesOnly ? "Writes only" : "Everything"}
        </button>
        <button onClick={onClose} className="ml-auto text-[11px] px-1.5 t-dim2 hover:opacity-70" title="Hide (@)">✕</button>
      </div>
      <div ref={bodyRef} className="agx-scroll flex-1 min-h-0 overflow-y-auto px-3 pb-1.5 font-mono text-[10px] leading-[1.5]"
        onScroll={(e) => {
          const el = e.currentTarget;
          stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}>
        {shown.map((e) => (
          <div key={e.id} className="flex items-baseline gap-2 whitespace-pre-wrap break-all">
            <span className="shrink-0 t-dim2">{time(e.at)}</span>
            <span className="shrink-0 tabular-nums t-dim2" style={{ minWidth: 44, textAlign: "right" }}>{e.ms < 1 ? "<1ms" : `${Math.round(e.ms)}ms`}</span>
            <span className="min-w-0" style={{ color: e.exitCode === 0 ? (e.write ? "var(--text)" : "var(--text3)") : "var(--error)" }}>
              git {e.args.join(" ")}
              {e.error && <span style={{ color: "var(--error)" }}> — {e.error}</span>}
            </span>
          </div>
        ))}
        {!shown.length && (
          <div className="py-6 text-center t-dim2 text-[10px]">
            {writesOnly ? "Nothing has changed the repository yet" : "No commands yet"}
          </div>
        )}
      </div>
    </div>
  );
}
