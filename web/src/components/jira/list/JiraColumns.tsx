/*
 * The quiet captions over the row columns, and the hook that decides which columns fit. The captions and the rows read the
 * same `--jl-cols` variable from the scroller that holds both, so they cannot drift apart by a pixel.
 */
import { useEffect, useState, type RefObject } from "react";
import { columnsFor, type Cols } from "./laneModel.ts";

/** The columns that fit the scroller's width now. A width of 0 (not measured yet) keeps them all. */
export function useColumns(ref: RefObject<HTMLElement | null>, live: boolean): Cols {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || !live) return;
    setWidth(el.clientWidth);
    const watch = new ResizeObserver(() => setWidth(el.clientWidth));
    watch.observe(el);
    return () => watch.disconnect();
  }, [ref, live]);
  return columnsFor(width);
}

export function JiraColumns({ cols }: { cols: Cols; third?: string }) {
  return (
    <div className="agx-jl-caps" aria-hidden>
      <div className="agx-jl-capsin">
        <span />
        <span>Key</span>
        <span>Card</span>
        {cols.status && <span>Status</span>}
        {cols.agent && <span>Agent</span>}
        {cols.pr && <span>PR</span>}
        {cols.who && <span>Who</span>}
      </div>
    </div>
  );
}
