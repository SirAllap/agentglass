import { useEffect, useState, type RefObject } from "react";
import { currentToc, tocItems, type TocItem } from "../lib/settingsNav.ts";

/** A card that needs a decision, or is the danger zone, marks its index entry the way its edge marks it. */
const CARD_DOT: Record<string, string> = { decision: "warn", danger: "err" };

/**
 * "On this page": the cards of the page you are on, each a link that scrolls
 * to it. A sticky rail at the right from 1760px, a row of chips above the
 * cards under that — one element, the stylesheet decides which.
 *
 * The cards are read out of the page after it draws (every SettingsCard is a
 * `section.agx-scard` with a titled heading), so a page does not declare an
 * index it could forget to keep. A page that draws its cards late is picked up
 * by the observer; one with fewer than two titled cards gets no index.
 */
export function SettingsToc({ scope, scroller, page }: {
  /** Where the page's cards are. */
  scope: RefObject<HTMLElement | null>;
  /** The element that scrolls: its top edge plus the header is where "current" is read. */
  scroller: RefObject<HTMLElement | null>;
  /** The page id: the index is read again when it changes. */
  page: string;
}) {
  const [items, setItems] = useState<TocItem[]>([]);
  const [cur, setCur] = useState(0);

  useEffect(() => {
    const root = scope.current;
    if (!root) return;
    let raf = 0;
    const read = () => {
      const cards = [...root.querySelectorAll<HTMLElement>("section.agx-scard")]
        .map((el) => ({ el, title: el.querySelector(".agx-settings-head-t")?.textContent ?? "", tone: CARD_DOT[el.dataset.tone ?? ""] ?? el.querySelector(".agx-scard-head .agx-badge")?.getAttribute("data-tone") ?? null }))
        .filter((c) => c.title.trim());
      const next = tocItems(cards);
      // Anchors go on the cards themselves, so a link is a plain scroll to an id.
      if (next.length) cards.forEach((c, i) => { c.el.id = next[i]!.id; });
      setItems((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    const soon = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(read); };
    soon();
    const mo = new MutationObserver(soon);
    mo.observe(root, { childList: true, subtree: true, characterData: true });
    return () => { mo.disconnect(); cancelAnimationFrame(raf); };
  }, [scope, page]);

  useEffect(() => {
    const sc = scroller.current;
    if (!sc || !items.length) return;
    let raf = 0;
    const look = () => {
      const head = sc.querySelector<HTMLElement>(".agx-ph")?.getBoundingClientRect().bottom ?? sc.getBoundingClientRect().top;
      const tops = items.map((it) => document.getElementById(it.id)?.getBoundingClientRect().top ?? Infinity);
      setCur(currentToc(tops, head + 24));
    };
    const soon = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(look); };
    soon();
    sc.addEventListener("scroll", soon, { passive: true });
    return () => { sc.removeEventListener("scroll", soon); cancelAnimationFrame(raf); };
  }, [scroller, items]);

  if (!items.length) return null;
  return (
    <nav className="agx-toc" aria-label="On this page">
      <div className="agx-toc-lab">On this page</div>
      {items.map((it, i) => (
        <a key={it.id} href={`#${it.id}`} aria-current={i === cur ? "location" : undefined}
          onClick={(e) => {
            e.preventDefault();
            setCur(i);
            const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
            document.getElementById(it.id)?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
          }}>
          {it.dot && <i className="agx-toc-dot" data-tone={it.dot} aria-hidden />}{it.label}
        </a>
      ))}
    </nav>
  );
}
