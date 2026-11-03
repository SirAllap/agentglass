import { GRAPH_H, laneColour, laneX, linkPath, type GraphRow } from "../../lib/gitGraph.ts";
import { MINI_LANES, miniRow } from "../../lib/gitMiniGraph.ts";

/** Column width: three lanes and the room for the "+N" tick, the same for every row. The approved Log draws 86. */
export const MINI_WIDTH = 86;

/**
 * One row of the log's graph: at most three lanes, the dot, and "+N" for lanes
 * this row has past the third. Drawn per row — Lists.tsx only mounts the rows in
 * its incremental window — and over the lines `layoutGraph` already computed.
 */
export function MiniGraph({ row, selected }: { row?: GraphRow; selected?: boolean }) {
  if (!row) return <span className="shrink-0" style={{ width: MINI_WIDTH }} />;
  const m = miniRow(row);
  const cap = MINI_LANES - 1;
  const colour = laneColour(row.dot);
  const dotX = laneX(m.dot);
  return (
    <span className="relative block shrink-0 h-full" style={{ width: MINI_WIDTH }}>
      <svg width={MINI_WIDTH} viewBox={`0 0 ${MINI_WIDTH} ${GRAPH_H}`} preserveAspectRatio="none" aria-hidden
        className="absolute inset-0" style={{ width: MINI_WIDTH, height: "100%" }}>
        {m.links.map((l, i) => {
          return <path key={i} d={linkPath(l, cap)} fill="none" stroke={laneColour(l.lane)} strokeWidth={2}
            vectorEffect="non-scaling-stroke" strokeLinecap="round" />;
        })}
      </svg>
      {/* A line that runs into a hidden lane ends in a dot on the last drawn one. */}
      {m.links.filter((l) => l.toEdge).map((l, i) => (
        <span key={`e${i}`} aria-hidden className="absolute rounded-full" style={{
          left: laneX(cap), top: l.hiddenEnd === "from" ? "15%" : "85%", width: 4, height: 4,
          transform: "translate(-50%, -50%)", background: laneColour(l.lane), opacity: 0.8 }} />
      ))}
      {/* HTML, not SVG: the SVG is stretched to the row, so a circle in it is an ellipse.
          Hollow for every commit, as in the approved Log; the row under the cursor draws a bigger one. */}
      <span aria-hidden className="absolute rounded-full" style={{
        left: dotX, top: "50%", transform: "translate(-50%, -50%)",
        width: selected ? 12 : 9, height: selected ? 12 : 9,
        background: "var(--bg)", border: `2.2px solid ${colour}`,
      }} />
      {m.hidden > 0 && (
        <span className="absolute right-0 top-1/2 -translate-y-1/2 text-[9px] leading-none" style={{ color: "var(--text2)" }}
          title={`${m.hidden} more lane${m.hidden === 1 ? "" : "s"} in this row`}>+{m.hidden}</span>
      )}
    </span>
  );
}
