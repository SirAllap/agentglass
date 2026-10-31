/*
 * The two controls that sit above a diff wherever one is shown: the syntax
 * theme, and a small on/off button.
 *
 * They lived in the Diff view's own file, which is why the Git panel imported a
 * 1,463-line module — most of it a page it does not render — to draw a dropdown.
 * Here they are what they are: shared chrome for a diff, next to the diff.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useCloseWithOwner } from "../../lib/layerOwner.ts";
import { THEMES, shikiTheme, themeClash } from "../../lib/highlight.ts";
import { ICON } from "../../lib/iconSize.ts";
import { WarningIcon } from "../../lib/glyphIcons.tsx";
import { GearIcon } from "../workspace/icons.tsx";
import { openSettings } from "../../lib/openSettings.ts";
import { Button, EDGE, ListRow } from "../workspace/Chrome.tsx";

/**
 * The syntax theme, as a dropdown. "auto" follows the app's own light/dark; the
 * rest mirror the themes the user already has in their editor, because a diff
 * that colours code differently from the editor beside it reads as a different
 * language.
 */
export function ThemePicker({ value, onChange, error }: { value: string; onChange: (v: string) => void; error?: string | null }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useCloseWithOwner(() => setOpen(false), { open, from: ref });

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    // Capture, and the event is stopped: Escape here must close this list, not
    // the panel or the modal underneath it.
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc, true);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc, true); };
  }, [open]);

  const clash = error ? null : themeClash(value, shikiTheme());
  const label = value === "auto" ? "Auto" : (THEMES.find((t) => t.id === value)?.label ?? value);
  const choice = (id: string, name: string) => (
    <ListRow key={id} onClick={() => { onChange(id); setOpen(false); }} role="menuitemradio" aria-checked={value === id}
      current={value === id} leading={<TickIcon on={value === id} />}>{name}</ListRow>
  );

  return (
    <div ref={ref} className="relative">
      <Button
        size="regular" tint={error || clash ? "var(--warning)" : undefined}
        onClick={() => setOpen((o) => !o)}
        title={error || clash || "Syntax theme"}
        aria-expanded={open}
      >
        {/* The label names the theme that was CHOSEN, so when it could not be
            loaded the button has to say so — otherwise it vouches for colours
            that are not on screen. */}
        {(error || clash) && <span aria-hidden className="flex"><WarningIcon size={ICON.xs} /></span>}
        <span className="truncate" style={{ maxWidth: 92 }}>{label}</span>
        <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 12 12" fill="none" aria-hidden style={{ opacity: 0.7 }}>
          <path d="M3 5l3 3 3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </Button>
      {open && (
        <div
          role="menu"
          className="agx-scroll absolute right-0 mt-1 rounded-lg py-1 text-[10.5px] shadow-2xl"
          /* Must beat the diff's sticky hunk headers, which are also z-20: on a
             tie the later-painted element wins, and those headers striped grey
             bars across this list wherever a `@@ … @@` line sat behind it. */
          style={{ zIndex: 40, background: "var(--surface-card)", border: EDGE, minWidth: 178, maxHeight: 340, overflowY: "auto" }}
        >
          {choice("auto", "Auto (app theme)")}
          <div className="px-2.5 pt-1.5 pb-0.5 text-[9px] uppercase tracking-wider" style={{ color: "var(--text4)" }}>Dark</div>
          {THEMES.filter((t) => t.dark).map((t) => choice(t.id, t.label))}
          <div className="px-2.5 pt-1.5 pb-0.5 text-[9px] uppercase tracking-wider" style={{ color: "var(--text4)" }}>Light</div>
          {THEMES.filter((t) => !t.dark).map((t) => choice(t.id, t.label))}
        </div>
      )}
    </div>
  );
}

/** A small pressed/unpressed button. `aria-pressed` rather than colour alone —
 *  these sit in a row of five and colour is the only other thing telling them
 *  apart. */
export function Toggle({ on, onClick, children, title }: { on?: boolean; onClick: () => void; children: ReactNode; title?: string }) {
  return <Button size="regular" on={!!on} aria-pressed={!!on} onClick={onClick} title={title}>{children}</Button>;
}

/** The way to the settings for everything above: split, wrap and theme all
 *  have their defaults on the Diff page. Sits beside the theme picker in each
 *  toolbar, so there is no row of its own. */
export function DiffSettingsLink() {
  return <Button size="regular" square tone="quiet" label="Diff settings…" onClick={() => openSettings("diff")}><GearIcon size={ICON.xs} /></Button>;
}

/** The check in front of a picker row; kept in the layout when off so labels stay aligned. */
function TickIcon({ on }: { on: boolean }) {
  return (
    <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 12 12" fill="none" aria-hidden className="shrink-0"
      style={{ opacity: on ? 1 : 0, color: "var(--primary-ink)" }}>
      <path d="M2.5 6.4l2.4 2.4L9.5 3.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
