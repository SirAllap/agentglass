import { useEffect, useState } from "react";
import { columnTier } from "./tasksColumnFit.ts";

/**
 * The column tier of the element this is pointed at (see `columnTier`), kept as
 * state only when it changes. `el` is state in the caller (a callback ref), not
 * a ref object: the board's table mounts after its first read, and an effect
 * that ran on `ref.current === null` would never look again.
 */
export function useColumnTier(el: HTMLElement | null): 0 | 1 | 2 {
  const [tier, setTier] = useState<0 | 1 | 2>(2);
  useEffect(() => {
    if (!el) return;
    setTier(columnTier(el.clientWidth));
    if (typeof ResizeObserver !== "function") return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setTier(columnTier(e.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return tier;
}
