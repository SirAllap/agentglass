// The arrow keys of an open menu. Focus stays in the finder's own box while a menu is open (see Popover), so the keys are taken at the window, in the capture phase, and the highlighted row is marked with data-active for the stylesheet to draw.
import { useEffect, type RefObject } from "react";
import { MENU_ROW, stepActive, type MenuKey } from "../../../lib/finderMenu.ts";

const rowsOf = (root: HTMLElement) => [...root.querySelectorAll<HTMLButtonElement>(`.${MENU_ROW}:not(:disabled)`)];
const markOf = (rows: HTMLElement[], at: number) => rows.forEach((r, i) => { if (i === at) r.setAttribute("data-active", ""); else r.removeAttribute("data-active"); });

/** `onLeft`: what ArrowLeft does in a submenu (close it). `enabled`: false while another menu on top has the keys. */
export function useMenuKeys(root: RefObject<HTMLElement | null>, { enabled = true, onLeft }: { enabled?: boolean; onLeft?: () => void } = {}) {
  useEffect(() => {
    if (!enabled) return;
    const el = root.current; if (!el) return;
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
    // The pointer takes the highlight with it, so two rows are never lit at once.
    const over = (e: MouseEvent) => { const row = (e.target as HTMLElement).closest?.(`.${MENU_ROW}`); if (row && !row.hasAttribute("disabled")) markOf(rowsOf(el), rowsOf(el).indexOf(row as HTMLButtonElement)); };
    window.addEventListener("keydown", on, true);
    el.addEventListener("mouseover", over);
    return () => { window.removeEventListener("keydown", on, true); el.removeEventListener("mouseover", over); };
  }, [root, enabled, onLeft]);
}
