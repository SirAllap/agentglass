// The arrow keys of an open menu. Focus stays in the finder's own box while a menu is open (see Popover), so the keys are taken at the window, in the capture phase, and the highlighted row is marked with data-active for the stylesheet to draw.
import { useEffect, type RefObject } from "react";
import { MENU_ROW, stepActive, type MenuKey } from "../../../lib/finderMenu.ts";

const rowsOf = (root: HTMLElement) => [...root.querySelectorAll<HTMLButtonElement>(`.${MENU_ROW}:not(:disabled)`)];
/** "ring": the keyboard's row, outlined; "fill": a row lit without an outline, as a context menu lights its first one. */
const markOf = (rows: HTMLElement[], at: number, how: "ring" | "fill" = "ring") => rows.forEach((r, i) => { if (i === at) r.setAttribute("data-active", how); else r.removeAttribute("data-active"); });

/** `onLeft`: what ArrowLeft does in a submenu (close it). `enabled`: false while another menu on top has the keys. `first`: how the first row is lit when the menu opens (Strata lights it: a button's popover with a ring, a context menu with a fill); a submenu opens with none. */
export function useMenuKeys(root: RefObject<HTMLElement | null>, { enabled = true, onLeft, first }: { enabled?: boolean; onLeft?: () => void; first?: "ring" | "fill" } = {}) {
  useEffect(() => {
    if (!enabled) return;
    const el = root.current; if (!el) return;
    if (first) markOf(rowsOf(el), 0, first);
    const on = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const rows = rowsOf(el);
      const cur = rows.findIndex((r) => r.hasAttribute("data-active"));
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
        e.preventDefault(); e.stopPropagation();
        const at = stepActive(rows.length, cur, e.key as MenuKey);
        markOf(rows, at); rows[at]?.scrollIntoView({ block: "nearest" });
      } else if ((e.key === "Enter" || e.key === " " || e.key === "ArrowRight") && cur >= 0) {
        if (e.key === "ArrowRight" && !rows[cur]!.hasAttribute("aria-haspopup")) return;
        e.preventDefault(); e.stopPropagation(); rows[cur]!.click();
      } else if (e.key === "ArrowLeft" && onLeft) { e.preventDefault(); e.stopPropagation(); onLeft(); }
    };
    // The pointer takes the highlight over from the keys, so two rows are never lit at once; the keys start again from where it is.
    const over = (e: MouseEvent) => { const row = (e.target as HTMLElement).closest?.(`.${MENU_ROW}`); if (row && !row.hasAttribute("disabled")) markOf(rowsOf(el), -1); };
    window.addEventListener("keydown", on, true);
    el.addEventListener("mouseover", over);
    return () => { window.removeEventListener("keydown", on, true); el.removeEventListener("mouseover", over); };
    // `first` is read once, when the menu opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, enabled, onLeft]);
}
