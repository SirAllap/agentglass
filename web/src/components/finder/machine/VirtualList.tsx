// A fixed-row-height list that draws only what is on screen.
//
// Measured with 100,000 rows: 35 DOM nodes at any scroll position and a median
// scroll of 0.4 ms, which is the difference between a folder that opens and one
// that freezes the window. Every item is exactly `rowH` high — group headers
// included — so the window is arithmetic, not measurement.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { scrollToReveal, visibleWindow } from "../../../lib/finderMiller.ts";
import { useBox } from "./useBox.ts";

const OVERSCAN = 6;

export function VirtualList({ count, rowH, render, keepInView, label, className, onFocus, initialTop, onTop, ready = true, tabStop = true }: {
  count: number;
  rowH: number;
  render: (i: number) => ReactNode;
  /** An item index to bring on screen when it changes (the keyboard's cursor). */
  keepInView?: number | null;
  label: string;
  className?: string;
  onFocus?: () => void;
  /** Where to scroll to once, as soon as there are rows: the place a reopened finder left it. */
  initialTop?: number;
  /** Told where it is scrolled, for the next reopening. */
  onTop?: (top: number) => void;
  /** False while the box is not measured yet: the restore waits, or it is clamped by a layout that is about to change. */
  ready?: boolean;
  /** Tab stops here (Strata: each listing is one stop, and the Columns strip is one). False for a column that is not the active one. */
  tabStop?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const { h } = useBox(box);
  const [top, setTop] = useState(0);
  const w = visibleWindow({ count, top, height: h || 400, rowH, overscan: OVERSCAN });

  // Reopened: put the scroll back where it was left, once, when there is enough list to scroll to it. A folder that arrives in
  // pages is as tall as its first page when this runs, and a scroll set then is clamped to it (measured: 2000 became 615 or
  // 1587 depending on how far the folder had streamed); so it waits for the height, and a scroll by the person ends the wait.
  const restored = useRef(false);
  useEffect(() => {
    const el = box.current;
    if (restored.current || !el || count <= 0 || !ready || !h) return;
    if (initialTop === undefined || initialTop <= 0) { restored.current = true; return; }
    if (el.scrollHeight - el.clientHeight < initialTop) return;
    restored.current = true; el.scrollTop = initialTop; setTop(el.scrollTop);
  }, [count, initialTop, ready, h]);

  // The cursor moved by key: scroll just enough to show it, and not at all when it is already visible.
  // A reopening that restored a scroll keeps it: the first pass over the old cursor must not pull the list back to it.
  const kept = useRef(initialTop !== undefined);
  useEffect(() => {
    const el = box.current;
    if (!el || keepInView == null || keepInView < 0 || !h) return;
    if (kept.current) { kept.current = false; return; }
    el.scrollTop = scrollToReveal(keepInView, rowH, el.scrollTop, h);
  }, [keepInView, rowH, h]);

  return (
    <div ref={box} role="listbox" aria-label={label} aria-rowcount={count} tabIndex={tabStop ? 0 : -1} onFocus={onFocus}
      onScroll={(e) => { setTop(e.currentTarget.scrollTop); if (restored.current || e.currentTarget.scrollTop > 0) { restored.current = true; onTop?.(e.currentTarget.scrollTop); } }}
      className={`agx-scroll overflow-y-auto overflow-x-hidden min-h-0 ${className ?? ""}`}>
      <div style={{ paddingTop: w.padTop, paddingBottom: w.padBottom }}>
        {Array.from({ length: w.end - w.start }, (_, k) => render(w.start + k))}
      </div>
    </div>
  );
}
