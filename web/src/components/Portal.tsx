import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { pushScope } from "../lib/findScope.ts";

/** Renders children into document.body so they escape panel stacking contexts.
 *
 *  Every portal lands as a sibling of every other, all at the same z, so which
 *  one wins is decided by the order the effects happened to append them in —
 *  fine while only one is ever open, wrong the moment one overlay opens another.
 *  `z` is the escape hatch for that case: a layer that must sit above the
 *  workspace says so, instead of hoping it mounted late enough.
 */
export function Portal({ children, z = 9999, find }: {
  children: ReactNode;
  z?: number;
  /**
   * This portal is a surface somebody reads, so "find on this screen" means
   * find in HERE while it is open.
   *
   * Opt-in rather than automatic, because most portals are not that: a context
   * menu, a toast and a tooltip all render through this one, and a find bar
   * that searched the menu you happen to have open would be worse than one
   * that searched the view behind it. Settings, a card, the file viewer say
   * yes; menus say nothing.
   *
   * Rank 1, above the view's 0 — see findScope.ts. Nested overlays can pass a
   * higher one.
   */
  find?: boolean | number;
}) {
  const [el] = useState(() => document.createElement("div"));
  useEffect(() => {
    el.style.position = "relative";
    el.style.zIndex = String(z);
    document.body.appendChild(el);
    return () => {
      document.body.removeChild(el);
    };
  }, [el, z]);
  useEffect(() => {
    if (!find) return;
    return pushScope(el, typeof find === "number" ? find : 1);
  }, [el, find]);
  return createPortal(children, el);
}
