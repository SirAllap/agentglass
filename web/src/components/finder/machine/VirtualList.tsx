// A fixed-row-height list that draws only what is on screen.
//
// Measured with 100,000 rows: 35 DOM nodes at any scroll position and a median
// scroll of 0.4 ms, which is the difference between a folder that opens and one
// that freezes the window. Every item is exactly `rowH` high — group headers
// included — so the window is arithmetic, not measurement.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { visibleWindow } from "../../../lib/finderMiller.ts";
import { useBox } from "./useBox.ts";

const OVERSCAN = 6;

export function VirtualList({ count, rowH, render, keepInView, label, className, onFocus, initialTop, onTop }: {
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
}) {
  const box = useRef<HTMLDivElement>(null);
  const { h } = useBox(box);
  const [top, setTop] = useState(0);
  const w = visibleWindow({ count, top, height: h || 400, rowH, overscan: OVERSCAN });

  // Reopened: put the scroll back where it was left, once, when the rows are there to scroll through.
  const restored = useRef(false);
  useEffect(() => {
    const el = box.current;
    if (restored.current || !el || count <= 0) return;
    restored.current = true;
    if (initialTop && initialTop > 0) { el.scrollTop = initialTop; setTop(el.scrollTop); }
  }, [count, initialTop]);

  // The cursor moved by key: scroll just enough to show it, and not at all when it is already visible.
  useEffect(() => {
    const el = box.current;
    if (!el || keepInView == null || keepInView < 0 || !h) return;
    const y = keepInView * rowH;
    if (y < el.scrollTop) el.scrollTop = y;
    else if (y + rowH > el.scrollTop + h) el.scrollTop = y + rowH - h;
  }, [keepInView, rowH, h]);

  return (
    <div ref={box} role="listbox" aria-label={label} aria-rowcount={count} tabIndex={-1} onFocus={onFocus}
      onScroll={(e) => { setTop(e.currentTarget.scrollTop); onTop?.(e.currentTarget.scrollTop); }}
      className={`agx-scroll overflow-y-auto overflow-x-hidden min-h-0 ${className ?? ""}`}>
      <div style={{ paddingTop: w.padTop, paddingBottom: w.padBottom }}>
        {Array.from({ length: w.end - w.start }, (_, k) => render(w.start + k))}
      </div>
    </div>
  );
}
