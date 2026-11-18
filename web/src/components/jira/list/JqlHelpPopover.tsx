/*
 * The JQL box's suggestion list: fields, operators, values or functions for whatever is under the caret
 * (jiraJqlHelp.ts decides which). It sits under the box, not inside AnchoredMenu's own arrow handling, because the
 * caret has to stay in the input while Up/Down move the highlight - the input keeps focus the whole time.
 */
import { useEffect, useRef, useState, type RefObject } from "react";
import { Portal } from "../../Portal.tsx";
import { LAYER } from "../../../lib/layers.ts";
import type { JqlCandidate } from "../../../lib/jiraJqlHelp.ts";

export function JqlHelpPopover({ anchor, rows, hot, onPick }: {
  anchor: RefObject<HTMLElement | null>;
  rows: readonly JqlCandidate[];
  hot: number;
  onPick: (c: JqlCandidate) => void;
}) {
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      if (a) setRect({ left: a.left, top: a.bottom + 4, width: Math.max(a.width, 260) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor]);
  useEffect(() => { list.current?.querySelector<HTMLElement>(`[data-i="${hot}"]`)?.scrollIntoView({ block: "nearest" }); }, [hot]);
  if (!rect || !rows.length) return null;
  return (
    <Portal z={LAYER.menu}>
      <div ref={list} id="jql-help" role="listbox" aria-label="JQL suggestions" data-testid="jql-help"
        className="agx-jmock fixed agx-scroll overflow-y-auto rounded-xl flex flex-col gap-px p-1"
        style={{ left: rect.left, top: rect.top, width: rect.width, maxHeight: 260, background: "var(--surface-card)", boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--text) 12%, transparent), 0 18px 44px -14px var(--shadow)", zIndex: 9999 }}>
        {rows.map((r, i) => (
          <button key={`${r.value}-${i}`} id={`jql-help-${i}`} type="button" role="option" aria-selected={i === hot} data-i={i}
            onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(r)}
            className="flex items-center text-left min-w-0"
            style={{ gap: 10, height: 30, padding: "0 10px", borderRadius: 7, fontSize: 13, background: i === hot ? "color-mix(in srgb, var(--primary) 12%, transparent)" : "transparent" }}>
            <span className="min-w-0 truncate" style={{ color: "var(--text)", fontWeight: 500 }}>{r.display}</span>
            {r.hint && <span className="min-w-0 truncate ml-auto" style={{ fontSize: 12, color: "var(--text3)" }}>{r.hint}</span>}
          </button>
        ))}
      </div>
    </Portal>
  );
}
