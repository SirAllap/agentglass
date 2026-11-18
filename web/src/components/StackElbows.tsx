/**
 * The elbow to a card's true parent, drawn in the lane's left gutter.
 * Which card it starts and ends at is decided in lib/prStackElbow.ts; this only
 * measures the cards and draws. Green, like the "on #A" chip of the same pair.
 */
import { useLayoutEffect, useRef, useState } from "react";
import { elbowLanes, type Elbow } from "../lib/prStackElbow.ts";

interface Path { key: number; d: string; end: { x: number; y: number } }
const STEP = 6;
const EDGE = 26;

export function StackElbows({ elbows }: { elbows: readonly Elbow[] }) {
  const host = useRef<HTMLDivElement>(null);
  const [paths, setPaths] = useState<Path[]>([]);
  useLayoutEffect(() => {
    const scroll = host.current?.parentElement;
    if (!scroll) return;
    const draw = () => {
      const base = scroll.getBoundingClientRect(), top = scroll.scrollTop;
      const mid = (n: number) => {
        const el = scroll.querySelector<HTMLElement>(`[data-pr-card="${n}"]`);
        const r = el?.getBoundingClientRect();
        return r ? r.top - base.top + top + 14 : null;
      };
      const cols = elbowLanes(elbows);
      const next: Path[] = [];
      for (const e of elbows) {
        const y1 = mid(e.from), y2 = mid(e.to);
        if (y1 === null || y2 === null) continue;
        const x = EDGE - 6 - (cols.get(e.from) ?? 0) * STEP;
        next.push({ key: e.from, d: `M${EDGE} ${y1} H${x} V${y2} H${EDGE}`, end: { x: EDGE, y: y2 } });
      }
      setPaths(next);
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(scroll);
    scroll.querySelectorAll("[data-pr-card]").forEach((c) => ro.observe(c));
    return () => ro.disconnect();
  }, [elbows]);
  return (
    <div ref={host} aria-hidden className="agx-elbows">
      <svg width={EDGE + 2} height="100%" style={{ overflow: "visible" }}>
        {paths.map((p) => (
          <g key={p.key} className="agx-elbow">
            <path d={p.d} />
            <circle cx={p.end.x} cy={p.end.y} r="2.5" />
          </g>
        ))}
      </svg>
    </div>
  );
}
