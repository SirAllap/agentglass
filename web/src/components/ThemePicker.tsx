import { useState } from "react";
import {
  THEMES, pickTheme, applyTheme, isDarkTheme, EXPERIMENTAL_THEME_IDS,
  themeMode, applyThemeMode, persistThemeMode, SERIOUS_DARK, SERIOUS_LIGHT,
  type Theme, type ThemeMode,
} from "../lib/themes.ts";
import { ACCENTS, currentAccent, setAccentPref } from "../lib/accent.ts";

/* Settings → Appearance.
 *
 * Two layers: a System / Dark / Light segment that maps to the two serious
 * neutral defaults (and tracks the OS on "System"), then the
 * full palette grid underneath for anyone who wants a specific scheme. Picking
 * from the grid drops the segment to whatever that palette is. */

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

/** One list, split into its dark run and its light run — empty runs dropped so
 *  the experimental section never shows a bare header with nothing under it. */
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

/** The palette grid alone — curated run plus a disclosure for the rest. Dumb by
 *  design: it reports a pick and applies nothing, so its parent stays the single
 *  place that decides what "picking a theme" means. */
export function ThemePicker({ current, onChange }: { current: string; onChange: (id: string) => void }) {
  const [showExperimental, setShowExperimental] = useState(false);
  const curated = THEMES.filter((t) => !EXPERIMENTAL_THEME_IDS.has(t.id));
  const experimental = THEMES.filter((t) => EXPERIMENTAL_THEME_IDS.has(t.id));

  return (
    <div>
      <Grid items={curated} current={current} onPick={onChange} />

      <button
        onClick={() => setShowExperimental((v) => !v)}
        className="mt-1 w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-[11px]"
        style={{ border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)", background: "color-mix(in srgb, var(--bg3) 22%, transparent)", color: "var(--text3)" }}
      >
        <span style={{ color: "var(--text2)" }}>More themes</span>
        <span className="t-dim2">experimental · {experimental.length}</span>
        <span className="ml-auto t-dim2">{showExperimental ? "▴" : "▾"}</span>
      </button>

      {showExperimental && (
        <div className="mt-2">
          <p className="px-1 pb-1.5 text-[10.5px] t-dim2">Decorative and second-flavour palettes, kept for tinkering.</p>
          <Grid items={experimental} current={current} onPick={onChange} />
        </div>
      )}
    </div>
  );
}

const MODES: { m: ThemeMode; label: string }[] = [
  { m: "system", label: "System" },
  { m: "dark", label: "Dark" },
  { m: "light", label: "Light" },
];

/** The whole Appearance page: mode segment on top, palette grid below. Owns the
 *  one decision — a mode click applies the matching serious theme, a grid click
 *  applies that palette and re-labels the segment — and keeps app state in step
 *  through `onChange`. */
export function AppearancePane({ current, onChange }: { current: string; onChange: (id: string) => void }) {
  const [mode, setMode] = useState<ThemeMode>(() => themeMode());

  const chooseMode = (m: ThemeMode) => {
    const id = applyThemeMode(m);
    setMode(m);
    if (id) onChange(id);
  };
  const chooseTheme = (id: string) => {
    pickTheme(id);
    const m: ThemeMode = id === SERIOUS_DARK ? "dark" : id === SERIOUS_LIGHT ? "light" : "custom";
    persistThemeMode(m);
    setMode(m);
    onChange(id);
  };

  const [accent, setAccentState] = useState(() => currentAccent());
  const chooseAccent = (id: string) => {
    setAccentPref(id);
    applyTheme(current); // re-assert the theme so the overlay (or its removal) lands
    setAccentState(id);
  };

  return (
    <div className="px-3 pb-2">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[11px]" style={{ color: "var(--text2)" }}>Mode</span>
        <div className="ml-auto flex p-0.5 rounded-lg" style={{ background: "color-mix(in srgb, var(--bg3) 40%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}>
          {MODES.map(({ m, label }) => {
            const on = mode === m;
            return (
              <button key={m} onClick={() => chooseMode(m)}
                className="px-3 py-1 rounded-md text-[11px] transition-colors"
                style={on
                  ? { background: "var(--bg2)", color: "var(--text)", boxShadow: "0 1px 2px rgba(0,0,0,0.25)" }
                  : { color: "var(--text3)" }}>
                {label}
              </button>
            );
          })}
        </div>
      </div>
      <p className="text-[10.5px] t-dim2 mb-3">A serious neutral pair. <b style={{ color: "var(--text3)" }}>System</b> follows your OS.</p>

      {/* Accent — a colour laid over the theme's grey primary, for the things
          that read as "live". "Theme" (dashed) is no override. */}
      <div className="flex items-center gap-2 mb-3">
        <span className="text-[11px]" style={{ color: "var(--text2)" }}>Accent</span>
        <div className="ml-auto flex items-center gap-1.5">
          {ACCENTS.map((a) => {
            const on = accent === a.id;
            const isDefault = !a.primary;
            return (
              <button key={a.id || "theme"} onClick={() => chooseAccent(a.id)} title={a.name}
                className="w-5 h-5 rounded-full transition-transform hover:scale-110"
                style={{
                  background: isDefault ? "transparent" : a.primary,
                  border: isDefault ? "1.5px dashed color-mix(in srgb, var(--text4) 80%, transparent)" : "none",
                  outline: on ? "2px solid var(--text)" : "none",
                  outlineOffset: "1.5px",
                }} />
            );
          })}
        </div>
      </div>

      <div className="text-[9px] uppercase tracking-[0.18em] t-dim2 px-1 pb-1.5" style={{ borderTop: "1px solid color-mix(in srgb, var(--border) 30%, transparent)", paddingTop: 12 }}>Or pick a palette</div>
      <ThemePicker current={current} onChange={chooseTheme} />
    </div>
  );
}
