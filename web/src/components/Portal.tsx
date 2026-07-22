import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Renders children into document.body so they escape panel stacking contexts.
 *
 *  Every portal lands as a sibling of every other, all at the same z, so which
 *  one wins is decided by the order the effects happened to append them in —
 *  fine while only one is ever open, wrong the moment one overlay opens another.
 *  `z` is the escape hatch for that case: a layer that must sit above the
 *  workspace says so, instead of hoping it mounted late enough.
 */
export function Portal({ children, z = 9999 }: { children: ReactNode; z?: number }) {
  const [el] = useState(() => document.createElement("div"));
  useEffect(() => {
    el.style.position = "relative";
    el.style.zIndex = String(z);
    document.body.appendChild(el);
    return () => {
      document.body.removeChild(el);
    };
  }, [el, z]);
  return createPortal(children, el);
}
