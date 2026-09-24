import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { pushScope } from "../lib/findScope.ts";

/**
 * The lowest layer a portal may take, set by whoever hosts the panel.
 *
 * A panel writes its portals' numbers for the world it was built in. A board
 * shown inside the bench is in a different one — the bench sits above those
 * numbers — so the board is wrapped in a floor and every portal beneath it is
 * lifted to it. Zero, the default, lifts nothing. See LAYER.benchOverlay.
 */
export const PortalFloor = createContext(0);

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
  /*
   * Null where there is no DOM.
   *
   * This ran `document.createElement` during RENDER, which is fine in a browser
   * and throws everywhere else — including under `bun test`, where rendering a
   * component is the only way to catch the class of bug that has twice shipped
   * a black window here. Every panel that contains a Select contains this, so
   * one line in this file was what made all of them untestable.
   *
   * A portal with nowhere to go draws nothing, which is the correct answer
   * rather than a concession: there is no body to escape to.
   */
  const [el] = useState<HTMLElement | null>(() => (typeof document === "undefined" ? null : document.createElement("div")));
  const floor = useContext(PortalFloor);
  /* Below zero is under the app on purpose — the closed bench, see
     FloatingBench — and lifting it to a floor would put it back over the view. */
  const layer = z < 0 ? z : Math.max(z, floor);
  useEffect(() => {
    if (!el) return;
    el.style.position = "relative";
    document.body.appendChild(el);
    return () => {
      document.body.removeChild(el);
    };
  }, [el]);
  /* Its own effect, so a board moving in or out of the bench restacks an open
     card rather than detaching it — a detached element forgets its scroll. */
  useEffect(() => {
    if (el) el.style.zIndex = String(layer);
  }, [el, layer]);
  useEffect(() => {
    if (!el || !find) return;
    return pushScope(el, typeof find === "number" ? find : 1);
  }, [el, find]);
  return el ? createPortal(children, el) : null;
}
