// One tool run, rendered the same way wherever a conversation is shown — the
// session timeline and the live chat. They were drifting apart: the chat
// reduced a tool call to a bare chip with its name, which threw away the
// command, its output and whether it failed. Sharing the row is what keeps
// "what the agent actually did" identical in both places.
import { useState } from "react";
import type { TimelineEntry } from "../../../shared/types.ts";
import { fmtTime } from "../lib/format.ts";

// A tool run in the thread. Deliberately one dense line rather than a bubble:
// a session runs hundreds of these, and giving each the weight of a message
// would bury the conversation it is supposed to sit alongside.
export function ToolRow({ e }: { e: TimelineEntry }) {
  const [open, setOpen] = useState(false);
  const target = e.target ?? "";
  // A command can be a whole script; show its first line and let the rest be
  // opened, rather than either truncating it away or pasting 40 lines inline.
  const firstLine = target.split("\n")[0];
  const out = (e.output ?? "").trimEnd();
  const outLines = out ? out.split("\n") : [];
  // Two lines of result, always. It is usually the difference between "the
  // tests ran" and "the tests passed", and expanding for that every time would
  // make the timeline useless as something you skim.
  const PREVIEW = 2;
  const outMore = outLines.length > PREVIEW || !!e.output_clipped;
  const hasMore = target.length > firstLine.length || firstLine.length > 110 || outMore;
  const tint = e.is_error ? "var(--error)" : "var(--info)";
  return (
    <div className="flex items-start gap-2 text-[10.5px] leading-relaxed pl-1">
      <span className="shrink-0 tabular-nums t-dim2 pt-px" style={{ minWidth: 52 }}>{fmtTime(e.ts)}</span>
      <span className="shrink-0 px-1.5 rounded font-medium"
        style={{ color: tint, background: `color-mix(in srgb, ${tint} 13%, transparent)` }}>
        {e.is_error ? "✕" : "⚙"} {e.tool}
      </span>
      <span className="min-w-0 flex-1">
        <span
          onClick={hasMore ? () => setOpen((o) => !o) : undefined}
          className={`block break-all ${hasMore ? "cursor-pointer" : ""} ${open ? "whitespace-pre-wrap" : "truncate"}`}
          style={{ color: "var(--text3)", fontFamily: "var(--font-mono, ui-monospace, monospace)" }}
          title={hasMore && !open ? "click to expand" : undefined}>
          {open ? target : firstLine}
        </span>
        {e.note && <span className="block t-dim2 truncate">{e.note}</span>}
        {outLines.length > 0 && (
          <span className="block mt-0.5 pl-2" style={{ borderLeft: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}>
            <span className={`block ${open ? "whitespace-pre-wrap break-all" : "truncate"}`}
              style={{ color: e.is_error ? "var(--error)" : "var(--text4)", fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>
              {open ? out : outLines.slice(0, PREVIEW).join(" · ")}
            </span>
            {outMore && !open && (
              <span className="block t-dim2 cursor-pointer" onClick={() => setOpen(true)}>
                +{e.output_clipped ? "more" : `${outLines.length - PREVIEW} lines`}
              </span>
            )}
            {open && e.output_clipped && <span className="block t-dim2">…output trimmed</span>}
          </span>
        )}
      </span>
      {e.duration_ms != null && e.duration_ms >= 1000 && (
        <span className="shrink-0 tabular-nums t-dim2">{(e.duration_ms / 1000).toFixed(1)}s</span>
      )}
    </div>
  );
}
