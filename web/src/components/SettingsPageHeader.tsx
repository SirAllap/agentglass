import { useEffect, useRef, type ReactElement, type ReactNode } from "react";
import { ICON } from "../lib/iconSize.ts";
import { hueVar, type HeaderChip, type NavGroup } from "../lib/settingsNav.ts";
import { StatusBadge } from "./SettingsKit.tsx";

/**
 * The top of a page: where you are (group, then page), what it is, how it
 * stands, and the one thing you can do to it as a whole.
 *
 * Sticky, so the title and the status chips stay in view while the cards
 * scroll under them. The chips come from the page's mark (headerChips in
 * lib/settingsNav.ts): a page with no real signal has none. `primary` is the
 * one action slot; Reset page, where the page can be reset, sits beside it.
 */
export function SettingsPageHeader({ label, group, icon: Icon, what, chips, primary, reset }: {
  label: string;
  group: NavGroup | null;
  icon: (p: { size?: number }) => ReactElement;
  what?: string;
  chips: readonly HeaderChip[];
  primary?: ReactNode;
  /** Shown when the page has something to put back. */
  reset?: ReactNode;
}) {
  // The header is sticky, so whatever else sticks under it (the project bar on Orchestration,
  // the index rail, a card scrolled to) needs its height: published on the scroller as --agx-ph-h.
  const head = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = head.current;
    const scroller = el?.parentElement;
    if (!el || !scroller || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => scroller.style.setProperty("--agx-ph-h", `${el.offsetHeight}px`));
    ro.observe(el);
    return () => { ro.disconnect(); scroller.style.removeProperty("--agx-ph-h"); };
  }, []);
  return (
    <header ref={head} className="agx-ph" style={{ "--hue": hueVar(group?.id ?? "system") } as React.CSSProperties}>
      {group && (
        <div className="agx-ph-crumb">
          <i aria-hidden />{group.name}
          {group.name !== label && <><span aria-hidden>›</span>{label}</>}
        </div>
      )}
      <div className="agx-ph-row">
        <span className="agx-ph-pic" aria-hidden><Icon size={ICON.lg} /></span>
        <h2 className="agx-ph-title">{label}</h2>
        {chips.length > 0 && (
          <span className="agx-ph-chips">
            {chips.map((c) => <StatusBadge key={c.text} tone={c.tone}>{c.text}</StatusBadge>)}
          </span>
        )}
        <span className="agx-ph-sp" />
        {reset}
        {primary}
      </div>
      {what && <p className="agx-ph-sum">{what}</p>}
    </header>
  );
}
