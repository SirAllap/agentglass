// One tool run, rendered the same way wherever a conversation is shown — the
// session timeline and the live chat. They were drifting apart: the chat
// reduced a tool call to a bare chip with its name, which threw away the
// command, its output and whether it failed. Sharing the row is what keeps
// "what the agent actually did" identical in both places.
//
// The row reads the way the CLI writes it: `Tool(what it acted on)`, one line,
// nothing else. We used to print the command, the description it gave itself
// and two lines of output on every row — three times the ink for the same
// event, so a session's exploration buried the conversation it was supposed to
// sit alongside. All of that detail is still here; it is what you open a row
// FOR, not what you read a hundred rows of.
import { useState } from "react";
import type { TimelineEntry } from "../../../shared/types.ts";
import { fmtTime } from "../lib/format.ts";

// Children shown before the rest fold away, matching the CLI's own
// `… +N tool uses`. Enough to see what a subagent set off doing, not enough to
// bury the thread it was spawned from.
const HEAD = 3;

const MONO = { fontFamily: "var(--font-mono, ui-monospace, monospace)" };
const RULE = "1px solid color-mix(in srgb, var(--border) 40%, transparent)";

export function ToolRow({ e, sub = [], nested = false }: {
  e: TimelineEntry;
  /** A spawned subagent's entries, nested under the call that started it. */
  sub?: TimelineEntry[];
  /** Already inside a group: drop the timestamp gutter, as the CLI does, and
   *  indent against the parent instead. */
  nested?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const target = e.target ?? "";
  // A command can be a whole script. The head of it identifies the run; the
  // rest belongs to the detail.
  const firstLine = target.split("\n")[0];
  const out = (e.output ?? "").trimEnd();
  const detail = target.length > firstLine.length || !!out || !!e.note;
  const tint = e.is_error ? "var(--error)" : "var(--info)";
  const shown = all ? sub : sub.slice(0, HEAD);
  const hidden = sub.length - shown.length;
  const indent = nested ? "ml-3" : "ml-[60px]";

  return (
    <div className="text-[10.5px] leading-relaxed">
      <div className="flex items-start gap-2 pl-1">
        {!nested && (
          <span className="shrink-0 tabular-nums t-dim2 pt-px" style={{ minWidth: 52 }}>{fmtTime(e.ts)}</span>
        )}
        <span
          onClick={detail ? () => setOpen((o) => !o) : undefined}
          className={`min-w-0 flex-1 break-all ${detail ? "cursor-pointer" : ""} ${open ? "" : "truncate"}`}
          style={MONO}
          title={detail && !open ? "Click for the full command and its output" : undefined}>
          <span style={{ color: tint }}>{e.is_error ? "✕ " : ""}{e.tool}</span>
          <span style={{ color: "var(--text4)" }}>(</span>
          <span style={{ color: "var(--text3)" }}>{firstLine}</span>
          <span style={{ color: "var(--text4)" }}>)</span>
          {detail && <span className="t-dim2">{open ? " ▾" : " …"}</span>}
        </span>
        {e.duration_ms != null && e.duration_ms >= 1000 && (
          <span className="shrink-0 tabular-nums t-dim2">{(e.duration_ms / 1000).toFixed(1)}s</span>
        )}
      </div>

      {open && detail && (
        <div className={`${indent} mt-0.5 pl-2 space-y-1`} style={{ borderLeft: RULE }}>
          {/* The tool's own account of what it was for — a Bash `description`.
              Worth showing once you have asked, and never worth a line of its
              own on a row you are only skimming past. */}
          {e.note && <div className="t-dim2">{e.note}</div>}
          {target.length > firstLine.length && (
            <div className="whitespace-pre-wrap break-all" style={{ ...MONO, color: "var(--text3)" }}>{target}</div>
          )}
          {out && (
            <div className="whitespace-pre-wrap break-all"
              style={{ ...MONO, color: e.is_error ? "var(--error)" : "var(--text4)" }}>{out}</div>
          )}
          {e.output_clipped && <div className="t-dim2">…output trimmed</div>}
        </div>
      )}

      {sub.length > 0 && (
        <div className={`${indent} mt-0.5 pl-2`} style={{ borderLeft: RULE }}>
          {shown.map((c, i) =>
            c.kind === "tool" ? (
              <ToolRow key={c.tool_use_id || `${c.ts}-${i}`} e={c} nested />
            ) : (
              // A subagent talking to itself. Dimmed and single-line: it is
              // context for the tools around it, not a turn in the conversation.
              <div key={`${c.ts}-${i}`} className="truncate t-dim2 pl-1" title={c.text ?? ""}>{c.text}</div>
            )
          )}
          {hidden > 0 && (
            <div className="pl-1 t-dim2 cursor-pointer" onClick={() => setAll(true)}>… +{hidden} tool uses</div>
          )}
          {all && sub.length > HEAD && (
            <div className="pl-1 t-dim2 cursor-pointer" onClick={() => setAll(false)}>… fold</div>
          )}
        </div>
      )}
    </div>
  );
}
