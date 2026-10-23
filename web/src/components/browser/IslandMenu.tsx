/*
 * The island's ⋯ menu: what a person needs from a floating bar, and nothing
 * else. The classic bar's menu (folders, spaces, split, tools, viewports,
 * imports) belongs to the sidebar and stays there; opening it from here put
 * twenty-five rows in front of a page the person was only trying to reload.
 *
 * Dark glass like the capsule it hangs from, and it grows from the ⋯ button.
 * Opened with the keyboard it appears at once: a key press has no origin to
 * grow from, and motion on every keyboard open is motion nobody asked for.
 */
import { useEffect, useRef } from "react";
import { Portal } from "../Portal.tsx";
import { ICON } from "../../lib/iconSize.ts";

export interface IslandMenuItem {
  key: string;
  label: string;
  icon: React.ReactNode;
  hint?: string;
  run: () => void;
  /** A rule above this row. */
  rule?: boolean;
}

export function IslandMenu({ at, byKey, items, onClose }: {
  at: { top: number; right: number };
  /** Opened from the keyboard: no entrance animation. */
  byKey: boolean;
  items: IslandMenuItem[];
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => { box.current?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true }); }, []);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); return; }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const rows = [...(box.current?.querySelectorAll<HTMLElement>("button") ?? [])];
    const cur = rows.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : (cur + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
    rows[next]?.focus();
  };
  return (
    <Portal>
      <div className="fixed inset-0" style={{ zIndex: 40 }} onClick={onClose} />
      <div ref={box} role="menu" aria-label="Page menu" onKeyDown={onKeyDown}
        className={"agx-isl-menu" + (byKey ? "" : " is-anim")} style={{ top: at.top, right: at.right }}>
        {items.map((it) => (
          <div key={it.key} role="none">
            {it.rule && <div className="agx-isl-menu-rule" />}
            <button type="button" role="menuitem" className="agx-isl-menu-row" onClick={() => { onClose(); it.run(); }}>
              <span className="agx-isl-menu-ic" style={{ width: ICON.sm, height: ICON.sm }}>{it.icon}</span>
              <span className="agx-isl-menu-t">{it.label}</span>
              {it.hint && <kbd className="agx-isl-menu-k">{it.hint}</kbd>}
            </button>
          </div>
        ))}
      </div>
    </Portal>
  );
}

/** The magnifier with a plus: the page's zoom, which the sibling icon sets have no glyph for. */
export function ZoomIcon({ size = ICON.sm }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden>
      <circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3M7 5v4M5 7h4" />
    </svg>
  );
}
