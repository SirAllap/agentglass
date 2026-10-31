/*
 * "Latest output": the way back down after scrolling up through a shell.
 *
 * Shows when the viewport is 80 px or more above the bottom of xterm's buffer
 * (lib/latestOutput.ts) and floats over the pane's bottom edge, above the
 * blocked-command note when that is up. It lives in the pane area and takes no
 * row of its own. Read off xterm's onScroll, so a shell nobody scrolls costs
 * nothing; there is no timer.
 */
import { useEffect, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import { CaretIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { pillBottom, pxBehind, scrollBehavior, showLatest } from "../../lib/latestOutput.ts";
import { CTRL_H, EDGE } from "../workspace/Chrome.tsx";

interface Cell { _core?: { _renderService?: { dimensions?: { css?: { cell?: { height: number } } } } } }

/** One cell's height in px, from xterm's renderer; the element's height over its rows before the first render. */
function cellHeight(term: Terminal): number {
  const h = (term as unknown as Cell)._core?._renderService?.dimensions?.css?.cell?.height;
  if (h) return h;
  const box = term.element?.clientHeight ?? 0;
  return term.rows ? box / term.rows : 0;
}

/** True while the terminal's viewport is far enough above the newest output. */
export function useScrolledUp(term: Terminal | undefined): boolean {
  const [up, setUp] = useState(false);
  useEffect(() => {
    if (!term) { setUp(false); return; }
    const read = () => {
      const b = term.buffer.active;
      setUp(showLatest(pxBehind(b.baseY, b.viewportY, cellHeight(term))));
    };
    read();
    const sub = term.onScroll(read);
    return () => sub.dispose();
  }, [term]);
  return up;
}

const reduced = () => document.documentElement.hasAttribute("data-reduce-motion") || window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Down to the newest line: eased over about 180 ms, or at once with reduced motion. */
export function scrollToLatest(term: Terminal): void {
  if (scrollBehavior(reduced()) === "auto") { term.scrollToBottom(); return; }
  const b = term.buffer.active;
  const from = b.viewportY;
  const t0 = performance.now();
  const step = (now: number) => {
    const k = Math.min(1, (now - t0) / 180);
    const e = 1 - Math.pow(1 - k, 3);
    // The target moves while output arrives, so it is read each frame.
    const end = term.buffer.active.baseY;
    if (k < 1) { term.scrollToLine(Math.round(from + (end - from) * e)); requestAnimationFrame(step); }
    else term.scrollToBottom();
  };
  requestAnimationFrame(step);
}

export function LatestOutputPill({ term, noteUp, z }: { term: Terminal | undefined; noteUp: boolean; z: number }) {
  const up = useScrolledUp(term);
  if (!term || !up) return null;
  return (
    <button type="button" onClick={() => { scrollToLatest(term); term.focus(); }}
      onMouseDown={(e) => e.preventDefault()}
      className="absolute left-1/2 inline-flex items-center gap-1.5 px-3 rounded-full text-[11px] font-semibold whitespace-nowrap transition-colors hover:brightness-110"
      style={{
        bottom: pillBottom(noteUp), height: CTRL_H.regular, zIndex: z, transform: "translateX(-50%)",
        color: "var(--primary-ink)", background: "color-mix(in srgb, var(--primary) 12%, var(--surface-card))",
        border: EDGE, boxShadow: "0 8px 22px -10px var(--shadow)",
        animation: "agx-pill-in 160ms cubic-bezier(0.23, 1, 0.32, 1)",
      }}>
      Latest output<CaretIcon size={ICON.xs} />
    </button>
  );
}
