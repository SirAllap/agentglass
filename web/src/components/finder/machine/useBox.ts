// The width and height of an element, kept current. The finder decides its
// layout (sidebar, preview, how many tiles to a row) from the box it is given,
// not from the window, because the palette is a panel of its own size.
import { useLayoutEffect, useState, type RefObject } from "react";

export function useBox(ref: RefObject<HTMLElement | null>): { w: number; h: number } {
  const [box, set] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => set((b) => (b.w === el.clientWidth && b.h === el.clientHeight ? b : { w: el.clientWidth, h: el.clientHeight }));
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return box;
}
