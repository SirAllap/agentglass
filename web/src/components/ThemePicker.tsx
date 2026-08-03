import { useState } from "react";
import { THEMES, pickTheme, isDarkTheme, EXPERIMENTAL_THEME_IDS, type Theme } from "../lib/themes.ts";

/* The theme picker, as it lives in Settings → Appearance.
 *
 * Split from the old header dropdown for two reasons: the masthead should not
 * carry a control this heavy, and thirty-five palettes in one flat list read as
 * a toy. The curated run — one strong pick per well-known family, plus the
 * accessibility and neutral palettes — is what shows; the decorative and
 * second-flavour ones sit behind a disclosure, present but not shouting. */

function Swatch({ t }: { t: Theme }) {
  return (
    <span className="flex -space-x-1 shrink-0">
      {[t.preview.primary, t.preview.secondary, t.preview.accent].map((c, i) => (
        <span key={i} className="h-3 w-3 rounded-full ring-1 ring-black/40" style={{ background: c }} />
      ))}
    </span>
  );
}

function ThemeBtn({ t, current, onPick }: { t: Theme; current: string; onPick: (id: string) => void }) {
  const on = t.id === current;
  return (
    <button
      onClick={() => onPick(t.id)}
      className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-[11px] text-left transition-transform hover:scale-[1.02]"
      style={{
        background: on ? "color-mix(in srgb, var(--primary) 20%, transparent)" : "color-mix(in srgb, var(--bg3) 30%, transparent)",
        border: `1px solid ${on ? "var(--primary)" : "transparent"}`,
      }}
    >
      <Swatch t={t} />
      <span className="whitespace-nowrap t-dim">{t.name}</span>
      {on && <span className="ml-auto shrink-0" style={{ color: "var(--primary-hover)" }}>✓</span>}
    </button>
  );
}

/** One list, split into its dark run and its light run — empty runs are dropped
 *  so the experimental section doesn't show a bare "light" header with nothing
 *  under it. */
function Grid({ items, current, onPick }: { items: Theme[]; current: string; onPick: (id: string) => void }) {
  const groups = [
    { label: "dark", items: items.filter(isDarkTheme) },
    { label: "light", items: items.filter((t) => !isDarkTheme(t)) },
  ].filter((g) => g.items.length);
  return (
    <>
      {groups.map((g) => (
        <div key={g.label} className="mb-2">
          <div className="px-1 pt-1 pb-1.5 text-[9px] uppercase tracking-[0.18em] t-dim2">{g.label}</div>
          <div className="grid grid-cols-2 gap-1.5">
            {g.items.map((t) => <ThemeBtn key={t.id} t={t} current={current} onPick={onPick} />)}
          </div>
        </div>
      ))}
    </>
  );
}

export function ThemePicker({ current, onChange }: { current: string; onChange: (id: string) => void }) {
  const [showExperimental, setShowExperimental] = useState(false);
  const curated = THEMES.filter((t) => !EXPERIMENTAL_THEME_IDS.has(t.id));
  const experimental = THEMES.filter((t) => EXPERIMENTAL_THEME_IDS.has(t.id));
  const pick = (id: string) => { pickTheme(id); onChange(id); };

  return (
    <div className="px-3 pb-2">
      <Grid items={curated} current={current} onPick={pick} />

      <button
        onClick={() => setShowExperimental((v) => !v)}
        className="mt-1 w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-[11px]"
        style={{ border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)", background: "color-mix(in srgb, var(--bg3) 22%, transparent)", color: "var(--text3)" }}
      >
        <span className="tabular-nums" style={{ color: "var(--text2)" }}>More themes</span>
        <span className="t-dim2">experimental · {experimental.length}</span>
        <span className="ml-auto t-dim2">{showExperimental ? "▴" : "▾"}</span>
      </button>

      {showExperimental && (
        <div className="mt-2">
          <p className="px-1 pb-1.5 text-[10.5px] t-dim2">Decorative and second-flavour palettes, kept for tinkering.</p>
          <Grid items={experimental} current={current} onPick={pick} />
        </div>
      )}
    </div>
  );
}
