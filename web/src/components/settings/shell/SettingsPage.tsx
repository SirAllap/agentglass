import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { SHELL_COLUMN, SHELL_GROUP_WIDTH, WIDE_COLUMN_WITH_RAIL, wideHasRail, showRailSpacer, SHELL_RAIL_MIN, SHELL_SIZE, hasRail, isChipBand, orderSections, foundTitle, railEntries, sameEntries, type SectionKind, type SectionMeta } from "./shellRules.ts";
import { PageRail, useStickyTop } from "./PageRail.tsx";

/** What a page declares per section; the body is the `Section` / `MoreOptions` / `DangerZone` it renders. */
export interface PageSection extends SectionMeta {
  body: ReactElement;
}

/**
 * Title + one-line purpose + optional scope slot + sections in fixed order
 * (Danger zone forced last). The rail appears from 2 sections.
 * The page is NOT a scroller. Inside the modal the one scroller is `[data-settings-scroll]`, and an
 * inner `h-full overflow-y-auto` here nested a second one inside the column's stable flow
 * (useStableFlow pins each child to a grid of 1px rows sized from its measured height). Measured on
 * the installed app at 2560px/125%: the inner box took the height of the first measurement, so the
 * body painted top to bottom with blank gaps that filled on scroll (Appearance) and Engines & usage
 * was cut at two thirds of the window. The page now flows at its natural height and the modal's
 * scroller scrolls it; the rail sticks inside that scroller. The sections and the rail/aside are
 * one group centred in the pane, with the scope header inside it so both share its left edge.
 */
export function SettingsPage({ title, purpose, scopeSlot, scopeKey, sections, aside, wide = false }: { title: string; purpose: string; scopeSlot?: ReactNode; /** The scope the page shows (a project root, "" for All): a change of it releases the rail's click pin. */ scopeKey?: string; sections: PageSection[]; aside?: ReactNode; /** Drawn across (see WIDE_RAIL_FROM_PX): a wider column, a 192 px rail, none under 1200 px. */ wide?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const getRoot = useCallback(() => root.current?.closest<HTMLElement>("[data-settings-scroll]") ?? root.current, []);
  const ordered = useMemo(() => orderSections(sections), [sections]);
  const meta: SectionMeta[] = useMemo(() => ordered.map(({ id, title: t, kind }) => ({ id, title: t, kind })), [ordered]);
  // The sections the page drew, read from its own DOM: a body may draw several headings (see railEntries).
  const column = useRef<HTMLDivElement>(null);
  const metaRef = useRef(meta);
  metaRef.current = meta;
  const [found, setFound] = useState<SectionMeta[] | null>(null);
  useLayoutEffect(() => {
    const el = column.current;
    if (!el) return;
    const read = () => {
      const next = [...el.querySelectorAll<HTMLElement>("[data-section]")]
        .filter((n) => !n.parentElement?.closest("[data-section]"))
        .flatMap((n) => {
          const title = foundTitle(n.querySelector("[data-section-heading]")?.textContent, n.dataset.section!, metaRef.current);
          return title === null ? [] : [{ id: n.dataset.section!, title, kind: (n.dataset.sectionKind ?? "normal") as SectionKind, ...(n.dataset.sectionCount ? { count: n.dataset.sectionCount } : null) }];
        });
      setFound((prev) => (sameEntries(prev, next) ? prev : next));
    };
    read();
    if (typeof MutationObserver === "undefined") return;
    const mo = new MutationObserver(read);
    // A section's count (data-section-count) changes without a node coming or going.
    mo.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-section-count"] });
    return () => mo.disconnect();
  }, []);
  const entries = railEntries(meta, found);
  // Measured, not a viewport media query: inside the modal the window is always wider than the page.
  const hasAside = !!aside;
  const [chips, setChips] = useState(false);
  const [wideRail, setWideRail] = useState(true);
  const rail = hasRail(entries.length) && (!wide || wideRail);
  const asideRef = useRef<HTMLElement>(null);
  const asideTop = useStickyTop(asideRef, hasAside && !chips);
  useEffect(() => {
    const el = root.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    // A wide page has no chip band: its column is the whole group, and the rail only shows where it fits beside it.
    const measure = () => {
      if (wide) { setChips(false); setWideRail(wideHasRail(el.clientWidth - 48)); return; }
      setChips(isChipBand(el.clientWidth, hasAside));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [hasAside, wide]);
  // A page with no rail, chips or aside keeps the right column's empty width, so its column starts at the
  // same x as every other page (measured: a lone Workers page centred at x=581 while the rest start at x=375).
  const spacer = showRailSpacer({ rail, chips, aside: !!aside, wide, wideRail });
  // A page whose rows are all machine values passes no scopeSlot: a control that changes nothing is not drawn.
  const header = scopeSlot ? <header className="mb-4"><div data-scope-slot>{scopeSlot}</div></header> : null;
  return (
    <div ref={root} data-settings-page role="region" aria-label={title} aria-description={purpose} className="px-6 py-6" style={{ background: "var(--surface-page)" }}>
      {/* SHELL_GROUP_WIDTH (720 + 32 + aside), centred, on a rail or aside page: the rail takes the aside's
          width, so the free space splits evenly and the column starts at the same x on both. A page with
          neither is the column alone, centred: measured at 2540x900, the old invisible spacer left Diffs,
          Activity and an unconnected Jira 478 px free left and 945 px right. Only pages stacked in one
          scroller keep the spacer, so they share one left edge. */}
      <div data-settings-group className="mx-auto max-w-full" style={{ width: chips ? "100%" : wide || rail || aside || spacer ? SHELL_GROUP_WIDTH : SHELL_COLUMN }}>
      {/* No title or purpose here: the modal's page header (SettingsPageHeader) is the one place that
          names the page, so a second heading would say it twice. `title`/`purpose` stay as the page's own
          declaration (accessible name, and the nav's `what` is the single visible purpose line). */}
      {chips && header}
      <div className={`flex gap-8 ${chips ? "flex-col items-stretch" : "flex-row items-start"}`}>
        {rail && chips && <PageRail sections={entries} scrollRoot={getRoot} scopeKey={scopeKey} chips />}
        {/* Outside the chip band the scope header sits in the content column, beside the rail: the rail's top is the row's top, so nothing above the sections (a note under the scope control) can move it. */}
        <div className={`min-w-0 max-w-full shrink${wide ? "" : " w-[720px]"}`} style={wide ? { width: rail ? WIDE_COLUMN_WITH_RAIL : "100%" } : undefined} data-settings-column>
        {!chips && header}
        <div ref={column}>
          {ordered.map((s) => <div key={s.id}>{s.body}</div>)}
        </div>
        </div>
        {/* A page aside (a live preview) takes the right column in place of the rail; in the chip band it drops under the sections. */}
        {aside && <aside ref={asideRef} data-page-aside className={chips ? "min-w-0" : "min-w-0 shrink-0"} style={chips ? undefined : { width: SHELL_SIZE.aside, position: "sticky", top: asideTop ?? 24 }}>{aside}</aside>}
        {rail && !chips && !aside && <PageRail sections={entries} scrollRoot={getRoot} scopeKey={scopeKey} chips={false} narrow={wide} />}
        {/* A page with no rail keeps the rail's empty column, so its column keeps the left edge every other page has. */}
        {spacer && <div data-rail-spacer aria-hidden style={{ width: SHELL_SIZE.aside, minWidth: SHELL_RAIL_MIN }} />}
      </div>
      </div>
    </div>
  );
}

export type { SectionKind };
