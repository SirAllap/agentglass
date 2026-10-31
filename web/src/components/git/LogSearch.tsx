import { BAR_INPUT, INPUT, INPUT_STYLE, Segmented } from "../workspace/Chrome.tsx";
import { DockIcon } from "../GitDock.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { INSPECTOR_RULE } from "./ui.tsx";
import { MONO } from "./HistoryFrames.tsx";

/**
 * The search box of a list tab. Escape empties it first; with it empty the key
 * goes on to whatever it did before, so the event is only stopped when it was used.
 */
export function ListSearch({ q, onQ, placeholder, count, total, note }: {
  q: string; onQ: (v: string) => void; placeholder: string; count?: number; total?: number;
  /** One line under the box, for what the filter is not showing. */
  note?: string;
}) {
  return (
    <div className="px-3 pt-2 pb-1">
    <div className="flex items-center gap-2">
      <input value={q} onChange={(e) => onQ(e.target.value)} placeholder={placeholder} aria-label={placeholder}
        onKeyDown={(e) => { if (e.key === "Escape" && q !== "") { e.preventDefault(); e.stopPropagation(); onQ(""); } }}
        className={`min-w-0 flex-1 max-w-md ${INPUT}`} style={INPUT_STYLE} />
      {q.trim() !== "" && count !== undefined && total !== undefined && (
        <span className="text-[10.5px] whitespace-nowrap" style={{ color: "var(--text3)" }}>{count} of {total}</span>
      )}
    </div>
    {note && <div className="mt-1 text-[10.5px] truncate" style={{ color: "var(--warning)" }} title={note}>{note}</div>}
    </div>
  );
}

/** `grow` pushes the dock below it to the bottom; off when a pinned row follows directly. */
export function NothingMatches({ q, grow = true }: { q: string; grow?: boolean }) {
  return (
    <div role="status" className={`${grow ? "flex-1" : ""} px-4 py-6 text-[12px]`} style={{ color: "var(--text3)" }}>
      Nothing matches <b style={{ color: "var(--text2)" }}>{q.trim()}</b>
    </div>
  );
}

export type LogScope = "head" | "all";

/**
 * The Log's one toolbar row: which history, the search, and the key that picks.
 * With no log to search (empty, failed) only the scope shows, so it stays where it was.
 */
export function LogToolbar({ scope, onScope, search }: {
  scope: LogScope; onScope: (s: LogScope) => void;
  search?: { q: string; onQ: (v: string) => void; count: number; total: number };
}) {
  const placeholder = "Search commits by message, author or sha…";
  return (
    <div className="shrink-0 h-11 flex items-center gap-1.5 px-3 min-w-0" style={{ borderBottom: INSPECTOR_RULE }}>
      <Segmented track label="History of" value={scope} onChange={onScope} options={[
        { id: "head", label: "this branch", title: "Only the commits reachable from this checkout's HEAD" },
        { id: "all", label: "all branches", title: "git log --all — every branch, which is a lot on a shared repo" },
      ]} />
      {search && (
        <>
          <span className="relative min-w-0 w-[380px]">
            <span aria-hidden className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: "var(--text4)" }}><DockIcon name="search" size={ICON.sm} /></span>
            <input value={search.q} onChange={(e) => search.onQ(e.target.value)} placeholder={placeholder} aria-label={placeholder}
              onKeyDown={(e) => { if (e.key === "Escape" && search.q !== "") { e.preventDefault(); e.stopPropagation(); search.onQ(""); } }}
              className={`w-full ${BAR_INPUT}`} style={{ ...INPUT_STYLE, paddingLeft: 30 }} />
          </span>
          {search.q.trim() !== "" && (
            <span className="text-[10.5px] whitespace-nowrap" style={{ color: "var(--text3)" }}>{search.count} of {search.total}</span>
          )}
          <span className="flex-1" />
          <span className="text-[11px] whitespace-nowrap" style={{ fontFamily: MONO, color: "var(--text3)" }}>
            press <b style={{ color: "var(--text2)" }}>c</b> to pick
          </span>
        </>
      )}
    </div>
  );
}
