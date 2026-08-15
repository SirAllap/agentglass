/*
 * The two controls that sit above a diff wherever one is shown: the syntax
 * theme, and a small on/off button.
 *
 * They lived in the Diff view's own file, which is why the Git panel imported a
 * 1,463-line module — most of it a page it does not render — to draw a dropdown.
 * Here they are what they are: shared chrome for a diff, next to the diff.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { THEMES } from "../../lib/highlight.ts";
import { ICON } from "../../lib/iconSize.ts";

/**
 * The syntax theme, as a dropdown. "auto" follows the app's own light/dark; the
 * rest mirror the themes the user already has in their editor, because a diff
 * that colours code differently from the editor beside it reads as a different
 * language.
 */
export function ThemePicker({ value, onChange, error }: { value: string; onChange: (v: string) => void; error?: string | null }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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

  const label = value === "auto" ? "Auto" : (THEMES.find((t) => t.id === value)?.label ?? value);
  const Row = ({ id, name }: { id: string; name: string }) => (
    <button
      onClick={() => { onChange(id); setOpen(false); }}
      role="menuitemradio" aria-checked={value === id}
      className="w-full text-left px-2.5 py-1 flex items-center gap-2 transition-colors"
      style={{ background: value === id ? "color-mix(in srgb, var(--primary) 16%, transparent)" : "transparent", color: value === id ? "var(--text)" : "var(--text2)" }}
    >
      <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 12 12" fill="none" aria-hidden className="shrink-0"
        style={{ opacity: value === id ? 1 : 0, color: "var(--primary)" }}>
        <path d="M2.5 6.4l2.4 2.4L9.5 3.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="truncate">{name}</span>
    </button>
  );

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title={error || "Syntax theme"}
        aria-expanded={open}
        className="px-2 py-1 rounded-md text-[10.5px] transition-colors flex items-center gap-1"
        style={{
          background: error ? "color-mix(in srgb, var(--warning) 16%, transparent)" : "color-mix(in srgb, var(--bg3) 45%, transparent)",
          border: `1px solid color-mix(in srgb, var(--${error ? "warning" : "border"}) ${error ? 55 : 30}%, transparent)`,
          color: error ? "var(--warning)" : "var(--text3)",
        }}
      >
        {/* The label names the theme that was CHOSEN, so when it could not be
            loaded the button has to say so — otherwise it vouches for colours
            that are not on screen. */}
        {error && <span aria-hidden>⚠</span>}
        <span className="truncate" style={{ maxWidth: 92 }}>{label}</span>
        <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 12 12" fill="none" aria-hidden style={{ opacity: 0.7 }}>
          <path d="M3 5l3 3 3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          className="agx-scroll absolute right-0 mt-1 rounded-lg py-1 text-[10.5px] shadow-2xl"
          /* Must beat the diff's sticky hunk headers, which are also z-20: on a
             tie the later-painted element wins, and those headers striped grey
             bars across this list wherever a `@@ … @@` line sat behind it. */
          style={{ zIndex: 40, background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--text) 24%, transparent)", minWidth: 178, maxHeight: 340, overflowY: "auto" }}
        >
          <Row id="auto" name="Auto (app theme)" />
          <div className="px-2.5 pt-1.5 pb-0.5 text-[9px] uppercase tracking-wider" style={{ color: "var(--text4)" }}>Dark</div>
          {THEMES.filter((t) => t.dark).map((t) => <Row key={t.id} id={t.id} name={t.label} />)}
          <div className="px-2.5 pt-1.5 pb-0.5 text-[9px] uppercase tracking-wider" style={{ color: "var(--text4)" }}>Light</div>
          {THEMES.filter((t) => !t.dark).map((t) => <Row key={t.id} id={t.id} name={t.label} />)}
        </div>
      )}
    </div>
  );
}

/** A small pressed/unpressed button. `aria-pressed` rather than colour alone —
 *  these sit in a row of five and colour is the only other thing telling them
 *  apart. */
export function Toggle({ on, onClick, children, title }: { on?: boolean; onClick: () => void; children: ReactNode; title?: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-pressed={!!on}
      className="px-2 py-1 rounded-md text-[10.5px] transition-colors"
      style={{
        background: on ? "color-mix(in srgb, var(--primary) 18%, transparent)" : "color-mix(in srgb, var(--bg3) 45%, transparent)",
        border: `1px solid color-mix(in srgb, var(--border) ${on ? 50 : 30}%, transparent)`,
        color: on ? "var(--text)" : "var(--text3)",
      }}
    >
      {children}
    </button>
  );
}
