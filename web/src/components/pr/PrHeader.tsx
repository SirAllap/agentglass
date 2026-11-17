import { useEffect, useRef, useState, type ReactNode } from "react";
import { gateDots, type Gate, type GateTab, type GateTone } from "../../lib/prGates.ts";

/**
 * The pull request's header, as the mockup draws it: badge, repo and number,
 * the title (up to four lines, then clamped), one facts row, the branch, the
 * stack crumb, and the actions at the top right. What goes in each slot is
 * wired by PrPanel from the data it already has; this draws the frame.
 *
 * The header scrolls with the page. Once the full title has left the top of the
 * scroller (an IntersectionObserver, not scroll maths), a one-line bar with the
 * badge, the number, the title and the four gate dots overlays the top edge. It
 * is drawn over the content at zero height, so it appearing moves nothing.
 */
export type PrHeaderBadge = { tone: GateTone; label: string; glyph: ReactNode };

export function PrHeader({ badge, lock, repo, number, onCopyNumber, copied, title, actions, facts, branch, crumb, gates, onGate, gatesSlot, miniMenu, miniCard }: {
  badge: PrHeaderBadge;
  /** The merge-lock badge, when there is a lock. */
  lock?: ReactNode;
  repo: string;
  number: number;
  onCopyNumber: () => void;
  copied: boolean;
  title: string;
  /** Refresh, terminal, GitHub, the more menu. */
  actions: ReactNode;
  /** Author, age, +/-, files, card: the one facts row. */
  facts: ReactNode;
  /** The branch chip and its copy button, then "into base" and the stack. */
  branch: ReactNode;
  /** The stack crumb, when this pull request is in a stack. */
  crumb?: ReactNode;
  gates: Gate[];
  onGate: (tab: GateTab) => void;
  /** The gates strip, drawn by the caller so the full header and the fold share one copy of the data. */
  gatesSlot: ReactNode;
  /** The "…" at the right of the title bar: the header's actions, reachable once the header has scrolled away. */
  miniMenu?: ReactNode;
  /** The card chip in the title bar; it scrolls the Overview to the card block. */
  miniCard?: ReactNode;
}) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  /* The header's height, for the tab strip to stick under it when the panel is tall (index.css, data-tall). */
  useEffect(() => {
    const el = topRef.current;
    const root = el?.closest<HTMLElement>("[data-pr-scroller]") ?? null;
    if (!el || !root || typeof ResizeObserver === "undefined") return;
    const set = () => root.style.setProperty("--prx-head-h", `${el.offsetHeight}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => { ro.disconnect(); root.style.removeProperty("--prx-head-h"); };
  }, []);
  /* True once the full title is above the top of the scroller. Below it, or in view, the bar stays away. */
  const [gone, setGone] = useState(false);
  useEffect(() => {
    const el = titleRef.current;
    const root = el?.closest<HTMLElement>("[data-pr-scroller]") ?? null;
    if (!el || !root || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((es) => {
      const e = es[es.length - 1];
      if (e) setGone(!e.isIntersecting && e.boundingClientRect.top < (e.rootBounds?.top ?? 0));
    }, { root });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div className="prx-header" data-masthead data-gone={gone ? "1" : undefined}>
      <div className="prx-minislot" aria-hidden={gone ? undefined : true}>
      <div className="prx-mini prx-g" data-pr-mini>
        <span className="prx-state state" data-tone={badge.tone} aria-label={badge.label}><span aria-hidden className="flex">{badge.glyph}</span><span>{badge.label}</span></span>
        <button type="button" className="prx-ref" onClick={onCopyNumber} aria-label={`Copy #${number}`}><b>#{number}</b></button>
        <h2 className="ttl">{title}</h2>
        {miniCard}
        <div className="prx-dots" role="group" aria-label="Merge gates">
          {gateDots(gates).map((d, i) => (
            <button key={d.key} type="button" className="prx-dot" data-tone={d.tone} aria-label={d.label} onClick={() => onGate(gates[i]!.tab)}><i /></button>
          ))}
        </div>
        {miniMenu}
      </div>
      </div>
      <div ref={topRef} className="prx-top">
        <div className="prx-head prx-g">
          <div className="prx-r1">
            <span className="prx-state" data-tone={badge.tone}><span aria-hidden className="flex">{badge.glyph}</span>{badge.label}</span>
            {lock}
            <button type="button" className="prx-ref" onClick={onCopyNumber} aria-live="polite" aria-label={copied ? "Copied" : `Copy #${number}`}>
              <b>{repo ? `${repo} ` : ""}#{number}</b>{copied ? " · copied" : ""}
            </button>
            <span className="flex-1" />
            <div className="prx-acts">{actions}</div>
          </div>
          <h2 ref={titleRef} className="prx-title">{title}</h2>
          <div className="prx-facts">{facts}<span className="prx-branchrow">{branch}</span></div>
          {crumb && <div className="prx-crumb">{crumb}</div>}
        </div>
        {gatesSlot}
      </div>
    </div>
  );
}
