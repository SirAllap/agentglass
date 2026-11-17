/*
 * The family highlight, painted on the board's DOM so a hover re-renders no card: hovering or focusing a card of a family
 * (a parent with sub-tasks and those sub-tasks) lights all of it across columns and dims the rest; the selected card does
 * the same while nothing is hovered. Hovering a sub-task row in a parent's list lights that one card stronger.
 */
import { useCallback, useEffect, type RefObject, type SyntheticEvent } from "react";
import type { ProviderTask } from "../../../../../shared/providers.ts";
import { familyKeyOf } from "./familyModel.ts";
import { keyOf } from "./laneModel.ts";

const esc = (s: string): string => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&"));

export function paintFamily(root: HTMLElement, fam: string | null, child: string | null): void {
  if (fam) root.setAttribute("data-jb-lit", ""); else root.removeAttribute("data-jb-lit");
  for (const el of root.querySelectorAll<HTMLElement>("[data-jb-fam]")) {
    if (fam && el.getAttribute("data-jb-fam") === fam) el.setAttribute("data-jb-in", ""); else el.removeAttribute("data-jb-in");
  }
  for (const el of root.querySelectorAll<HTMLElement>("[data-jb-child]")) el.removeAttribute("data-jb-child");
  if (child) root.querySelector<HTMLElement>(`[data-jb-key="${esc(child)}"]`)?.setAttribute("data-jb-child", "");
}

export function useFamilyLight(root: RefObject<HTMLElement | null>, cards: readonly ProviderTask[], selectedId: string | null | undefined) {
  const selFam = (() => { const c = selectedId ? cards.find((t) => t.id === selectedId || keyOf(t) === selectedId) : undefined; return c ? familyKeyOf(c) ?? null : null; })();
  const rest = useCallback(() => { if (root.current) paintFamily(root.current, selFam, null); }, [root, selFam]);
  useEffect(() => { rest(); }, [rest, cards]);
  const over = useCallback((e: SyntheticEvent) => {
    const el = root.current;
    const t = e.target instanceof Element ? e.target : null;
    if (!el || !t) return;
    const kid = t.closest<HTMLElement>("[data-jb-kid]")?.getAttribute("data-jb-kid") ?? null;
    const card = t.closest<HTMLElement>("[data-jb-card]");
    const fam = card?.getAttribute("data-jb-fam") ?? null;
    if (fam || kid) paintFamily(el, fam ?? selFam, kid); else rest();
  }, [root, rest, selFam]);
  return { over, out: rest };
}
