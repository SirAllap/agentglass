import { useEffect, useState } from "react";
import { SettingRow, Switch } from "./SettingRow.tsx";
import {
  THEMES, chooseTheme, applyTheme, isDarkTheme, EXPERIMENTAL_THEME_IDS,
  themeMode, applyThemeMode, desktopPaletteName, onDesktopPalette,
  type Theme, type ThemeMode,
} from "../lib/themes.ts";
import { ACCENTS, currentAccent, setAccentPref, lastAccent } from "../lib/accent.ts";
import { SERVER, authHeaders } from "../lib/api.ts";
import { DoneIcon } from "../lib/glyphIcons.tsx";
import { ICON } from "../lib/iconSize.ts";

/* Settings → Appearance.
 *
 * Two layers: a System / Dark / Light segment that maps to the two serious
 * neutral defaults (and tracks the OS on "System"), then the
 * full palette grid underneath for anyone who wants a specific scheme. Picking
 * from the grid drops the segment to whatever that palette is. */

/**
 * A palette shown as a palette.
 *
 * Three dots eleven pixels wide, in a row with a name, is a bullet — it says
 * "this theme has colours" and stops. What you are choosing between is a
 * GROUND and what sits on it, so the swatch is a band of the ground with the
 * accent and a semantic colour beside it, at a size where the difference
 * between two dark greys is actually visible.
 *
 * Drawn from `vars`, not from `preview`: preview is three colours somebody
 * chose to represent the theme, and the real ones cannot disagree with the app
 * because they ARE the app.
 */
function ThemeBtn({ t, current, onPick }: { t: Theme; current: string; onPick: (id: string) => void }) {
  const on = t.id === current;
  const v = t.vars as Record<string, string>;
  const ground = v["--bg"] ?? t.preview.primary;
  return (
    <button
      onClick={() => onPick(t.id)}
      title={t.name}
      className="rounded-lg overflow-hidden text-left transition-transform hover:scale-[1.02]"
      style={{
        border: `1px solid ${on ? "var(--primary)" : "color-mix(in srgb, var(--border) 45%, transparent)"}`,
        boxShadow: on ? "0 0 0 1px var(--primary)" : undefined,
      }}
    >
      <span className="flex h-7" aria-hidden>
        <span style={{ flex: 3, background: ground }} />
        <span style={{ flex: 1, background: v["--primary"] ?? t.preview.accent }} />
        <span style={{ flex: 1, background: v["--success"] ?? t.preview.secondary }} />
      </span>
      <span className="flex items-center gap-1.5 px-2 py-1 text-[11.5px]"
        style={{ background: "color-mix(in srgb, var(--bg3) 30%, transparent)", color: on ? "var(--primary-hover)" : "var(--text3)" }}>
        <span className="truncate">{t.name}</span>
        {on && <span className="ml-auto shrink-0 flex"><DoneIcon size={ICON.xs} /></span>}
      </span>
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
          <div className="panel-eyebrow pt-1 pb-1.5" style={{ paddingLeft: 0, paddingRight: 0 }}>{g.label}</div>
          <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))" }}>
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
/**
 * How many palettes to show before this becomes a catalogue.
 *
 * Thirty-seven is a list you read; six is a set you recognise. The six are the
 * first of the curated ones plus, always, whichever you are actually using —
 * because a picker that hides your own theme behind "more" is a picker that
 * tells you your choice was not one of the good ones.
 */
const FEATURED = 6;

export function ThemePicker({ current, onChange }: { current: string; onChange: (id: string) => void }) {
  const [showAll, setShowAll] = useState(false);
  const curated = THEMES.filter((t) => !EXPERIMENTAL_THEME_IDS.has(t.id));
  const experimental = THEMES.filter((t) => EXPERIMENTAL_THEME_IDS.has(t.id));

  const featured = curated.slice(0, FEATURED);
  if (!featured.some((t) => t.id === current)) {
    const mine = THEMES.find((t) => t.id === current);
    if (mine) featured[FEATURED - 1] = mine;
  }
  const rest = THEMES.filter((t) => !featured.some((f) => f.id === t.id));

  return (
    /* Bottom padding of its own: this is the last thing in the card, and without
       it the "N more" row sat directly on the card's bottom border. */
    <div className="pb-3">
      <Grid items={featured} current={current} onPick={onChange} />

      <button
        onClick={() => setShowAll((v) => !v)}
        className="mt-1.5 w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-[12px]"
        style={{ border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)", background: "color-mix(in srgb, var(--bg3) 22%, transparent)", color: "var(--text3)" }}
      >
        <span className="inline-block w-2.5 text-[10px]" aria-hidden>{showAll ? "▾" : "▸"}</span>
        <span style={{ color: "var(--text2)" }}>{rest.length} more</span>
        <span className="t-dim">including {experimental.length} experimental</span>
      </button>

      {showAll && (
        <div className="mt-2">
          <p className="pb-1.5 text-[12px] t-dim">
            The rest of the curated palettes, then the decorative and second-flavour ones kept for
            tinkering.
          </p>
          <Grid items={rest} current={current} onPick={onChange} />
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

/**
 * The desktop's own mark, as the label of its segment.
 *
 * Inlined, so it takes the segment's text colour — dim at rest, bright when on
 * — like the words beside it. The first version drew it as a CSS mask and it
 * drew nothing. What comes back is safe to inline because the server rebuilds
 * it from geometry alone (see rebuildMark); if it cannot be had the button says
 * the name instead, because a blank button is worse than a word.
 */
function DesktopMark({ source }: { source: string }) {
  const name = source === "omarchy" ? "Omarchy" : source;
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`${SERVER}/desktop/logo`, { headers: authHeaders() })
      .then((r) => (r.ok ? r.text() : ""))
      .then((t) => { if (live && t.startsWith("<svg")) setSvg(t); })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  if (!svg) return <>{name}</>;
  return (
    <span role="img" aria-label={name} className="inline-flex items-center align-middle"
      style={{ height: 12 }}
      /* Sized by height; the view box gives the width. */
      dangerouslySetInnerHTML={{ __html: svg.replace("<svg ", '<svg height="12" style="display:block" ') }} />
  );
}

/** The whole Appearance page: mode segment on top, palette grid below. Owns the
 *  one decision — a mode click applies the matching serious theme, a grid click
 *  applies that palette and re-labels the segment — and keeps app state in step
 *  through `onChange`. */
export function AppearancePane({ current, onChange }: { current: string; onChange: (id: string) => void }) {
  const [mode, setMode] = useState<ThemeMode>(() => themeMode());
  /* Which desktop palette is on offer, if any — re-read when it moves, so the
     line under the switch names the theme that is actually on. */
  const [desk, setDesk] = useState(() => desktopPaletteName());
  useEffect(() => onDesktopPalette(() => { setDesk(desktopPaletteName()); setMode(themeMode()); }), []);

  const chooseMode = (m: ThemeMode) => {
    const id = applyThemeMode(m);
    setMode(m);
    if (id) onChange(id);
  };
  const choose = (id: string) => {
    setMode(chooseTheme(id));
    onChange(id);
  };

  const [accent, setAccentState] = useState(() => currentAccent());
  /* The colour the theme brings by itself, for the swatch beside the switch.
     `--theme-primary` is stamped by `applyAccent` before the overlay goes on,
     so this is the theme's own even while an accent is laid over it. */
  const [own, setOwn] = useState("");
  useEffect(() => {
    setOwn(getComputedStyle(document.documentElement).getPropertyValue("--theme-primary").trim());
  }, [accent, current, desk]);
  const chooseAccent = (id: string) => {
    setAccentPref(id);
    applyTheme(current); // re-assert the theme so the overlay (or its removal) lands
    setAccentState(id);
  };
  /* Following is the absence of an override, so the switch writes "" going on
     and the last colour going off — never nothing, or the row would look
     broken with every circle dark. */
  const following = accent === "";

  /* Mode and accent are settings and read as rows; the palette grid is a
     picker and stays a grid. Both used a label floated left with the control
     pushed right by `ml-auto`, which is the row shape drawn by hand — and drawn
     to a different left edge than every other page in the dialog. */
  return (
    <>
      <SettingRow
        label="Mode"
        hint={desk && mode === "desktop"
          ? <>Wearing <b style={{ color: "var(--text3)" }}>{desk.name}</b>, your desktop's theme — it follows when you switch there.</>
          : desk
            ? <>Your desktop's theme is {desk.name}, one click away. <b style={{ color: "var(--text3)" }}>System</b> follows your OS's dark or light.</>
            : <>A serious neutral pair. <b style={{ color: "var(--text3)" }}>System</b> follows your OS.</>}
        control={<span className="flex p-0.5 rounded-lg" style={{ background: "color-mix(in srgb, var(--bg3) 40%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}>
          {[...(desk ? [{ m: "desktop" as ThemeMode, label: "" }] : []), ...MODES].map(({ m, label }) => {
            const on = mode === m;
            return (
              <button key={m} onClick={() => chooseMode(m)}
                title={m === "desktop" && desk ? `Wear ${desk.name}, your desktop's theme, and follow it when you switch` : undefined}
                className="px-3 py-1 rounded-md text-[12px] transition-colors"
                style={on
                  ? { background: "var(--bg2)", color: "var(--text)", boxShadow: "0 1px 2px rgba(0,0,0,0.25)" }
                  : { color: "var(--text3)" }}>
                {m === "desktop" && desk ? <DesktopMark source={desk.source} /> : label}
              </button>
            );
          })}
        </span>}
      />

      {/* Accent. The switch is the decision — follow the theme, or choose —
          and the circles are only the second half of it. It was a dashed
          circle in the row with the other seven, which reads as an eighth
          colour: somebody ran this app for weeks laying a hand-picked green
          over a desktop theme whose own accent they wanted, because nothing on
          that circle said what it did. A sentence can say it; a swatch cannot. */}
      <SettingRow
        label="Accent"
        hint={following
          ? <>Following your theme{desk && mode === "desktop" ? <> — <b style={{ color: "var(--text3)" }}>{desk.name}</b> brings its own</> : <>'s own primary</>}.</>
          : <>Laid over the theme's own primary, for the things that read as live.</>}
        control={<span className="flex items-center gap-4">
          <button onClick={() => chooseAccent(following ? lastAccent() : "")}
            role="switch" aria-checked={following} aria-label="Follow the theme's accent"
            title="Follow the theme's accent" className="flex items-center gap-1.5">
            <Switch on={following} />
            {own
              /* Smaller than the seven on purpose: it is the colour being
                 followed, not an eighth colour to pick. The wider gap before
                 the row says the same thing again. */
              ? <span className="w-3.5 h-3.5 rounded-full shrink-0" style={{ background: own, opacity: following ? 1 : 0.35 }} />
              : null}
          </button>
          <span className="flex items-center gap-1.5" aria-hidden={following}
            style={{ opacity: following ? 0.3 : 1, pointerEvents: following ? "none" : undefined }}>
            {ACCENTS.filter((a) => a.primary).map((a) => {
              const on = accent === a.id;
              return (
                <button key={a.id} onClick={() => chooseAccent(a.id)} title={a.name}
                  className="w-5 h-5 rounded-full transition-transform hover:scale-110"
                  style={{
                    background: a.primary,
                    outline: on ? "2px solid var(--text)" : "none",
                    outlineOffset: "1.5px",
                  }} />
              );
            })}
          </span>
        </span>}
      />

      <div className="panel-eyebrow pt-3 pb-1.5">Or pick a palette</div>
      <ThemePicker current={current} onChange={choose} />
    </>
  );
}
