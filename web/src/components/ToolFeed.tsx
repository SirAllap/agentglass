// A turn's tool calls, folded behind one line.
//
// The rows themselves were already right — `Tool(what it acted on)`, detail on
// click, subagents nested. What was wrong was how many of them a reader is shown
// without asking. A turn that greps twenty files printed twenty rows above the
// sentence it was working towards, so the answer arrived below its own
// machinery and the conversation scrolled away under it.
//
// So: one summary line, and the feed behind it. The information the fold must
// not lose is (a) that something is happening right now, and (b) that something
// failed — a folded failure is worse than no fold at all. Both are on the
// summary line; everything else is what you open it FOR.
import { useState } from "react";
import type { ChatTool } from "../lib/chatStore.ts";
import { toolFeedSummary, toolLabel } from "../lib/toolFeed.ts";

const MONO = { fontFamily: "var(--font-mono, ui-monospace, monospace)" };

/**
 * The fold. `children` is the real feed, rendered by the caller so this stays
 * ignorant of how a row is built.
 *
 * Starts closed even while streaming. Watching the tools scroll past is the
 * thing being fixed, and the running call on the summary line answers "is it
 * alive" without reprinting the whole run to do it.
 */
export function ToolFeed({ tools, streaming, children }: {
  tools: ChatTool[];
  /** The turn is still going, so the last row is the one running now. */
  streaming: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const { n, failed, latest } = toolFeedSummary(tools);
  if (!n) return null;

  const running = streaming && !!latest;
  const tint = failed ? "var(--error)" : "var(--info)";

  return (
    <div className="mb-1.5 pb-1.5" style={{ borderBottom: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center gap-1.5 text-left hover:opacity-80 px-1 py-0.5"
        title={open ? "Fold the tool calls away" : "Show what this turn ran"}>
        <span className="text-[10px] t-dim2 transition-transform shrink-0" style={{ transform: open ? "none" : "rotate(-90deg)" }}>▼</span>
        <span className="text-[10px] uppercase tracking-wider shrink-0" style={{ color: tint }}>
          {n} tool call{n === 1 ? "" : "s"}
        </span>
        {/* Only while it runs: which call is in flight. This is the whole reason
            the fold can default to closed. */}
        {running && !open && (
          <span className="text-[10px] min-w-0 flex-1 truncate" style={{ ...MONO, color: "var(--text4)" }}>
            {toolLabel(latest)}
          </span>
        )}
        {running && <span className="text-[10px] shrink-0" style={{ color: "var(--info)" }}>·</span>}
        {/* A failure never folds silently. */}
        {failed > 0 && (
          <span className="text-[10px] tabular-nums ml-auto shrink-0" style={{ color: "var(--error)" }}>
            ✕ {failed} failed
          </span>
        )}
      </button>
      {open && <div className="flex flex-col gap-0.5 mt-1">{children}</div>}
    </div>
  );
}
