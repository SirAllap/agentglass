import { useEffect, useState, useSyncExternalStore } from "react";
import { SettingRow, Toggle } from "./SettingRow.tsx";
import { markReadsAtLabelSize } from "../lib/markSize.ts";
import {
  THEMES, isDarkTheme, EXPERIMENTAL_THEME_IDS,
  themeMode, desktopPaletteName, onDesktopPalette,
  type Theme, type ThemeMode,
} from "../lib/themes.ts";
import { ACCENTS, currentAccent } from "../lib/accent.ts";
import { setting, subscribeSettings } from "../lib/settingsRegistry.ts";
import { DENSITIES, UI_FONT_SIZES, resetReduceMotion, reduceMotionChoice, type Density } from "../lib/lookPrefs.ts";
import { IS_DESKTOP, translucentSupported } from "../lib/desktop.ts";
import { Select } from "./Select.tsx";
import { SERVER, authHeaders } from "../lib/api.ts";
import { ICON } from "../lib/iconSize.ts";
import { Button, Segmented } from "./workspace/Chrome.tsx";
import { SettingsCard } from "./SettingsKit.tsx";
import { PreviewCard, WithPreview } from "./settings/PreviewCard.tsx";
import { AppearancePreview, LiveTabs, type LiveView } from "./settings/previews/index.ts";
import { railItems } from "./settings/previews/MiniApp.tsx";
import { loadRail, subscribeRail, SHIPPED_RAIL } from "./workspace/views.ts";
import { ThemeIcon, SlidersIcon } from "./settingsNavIcons.tsx";

/* Settings → Appearance.
 *
 * Three cards. Theme: a System / Dark / Light segment that maps to the two
 * serious neutral defaults (and tracks the OS on "System"), and under it the
 * palettes as large tiles; picking one drops the segment to whatever that
 * palette is. Accent: seven circles, the first meaning "no override". Density
 * & type: how much air rows get, the interface font size, a see-through
 * sidebar (desktop only) and reduced motion. */

/**
 * The palettes the first view offers, in the order they are drawn: the light
 * ones first, then the dark, the way a person reads a row of swatches. Whichever
 * theme is in use is always among them, because a picker that hides your own
 * theme behind "more" is a picker that tells you your choice was not one of
 * the good ones.
 */
const FEATURED_IDS = ["porcelain", "paper", "light", "blue-light", "catppuccin-latte", "solarized-light", "graphite", "tokyo-night"];

/**
 * A palette shown as a palette: a tile with its ground and its card colour side by
 * side, and its name under it. Drawn from `vars`, not from `preview`: preview is
 * three colours somebody chose to represent the theme, and the real ones cannot
 * disagree with the app because they ARE the app.
 */
function ThemeTile({ t, on, onPick }: { t: Theme; on: boolean; onPick: (id: string) => void }) {
  const v = t.vars as Record<string, string>;
  return (
    <button type="button" onClick={() => onPick(t.id)} title={t.name} aria-pressed={on} className="agx-theme-tile">
      <span className="agx-theme-sw" aria-hidden>
        <i style={{ background: v["--bg"] ?? t.preview.primary }} />
        <i style={{ background: v["--bg2"] ?? t.preview.secondary }} />
      </span>
      <span className="agx-theme-name">{t.name}</span>
    </button>
  );
}

function TileGrid({ items, current, onPick }: { items: Theme[]; current: string; onPick: (id: string) => void }) {
  return (
    <div className="agx-theme-grid">
      {items.map((t) => <ThemeTile key={t.id} t={t} on={t.id === current} onPick={onPick} />)}
    </div>
  );
}

/** The palette tiles: the featured eight, and a row that opens the rest (dark, then light). Reports a pick and applies nothing, so its parent stays the one place that decides what "picking a theme" means. */
export function PaletteRows({ current, onChange }: { current: string; onChange: (id: string) => void }) {
  const [showAll, setShowAll] = useState(false);
  const experimental = THEMES.filter((t) => EXPERIMENTAL_THEME_IDS.has(t.id));
  const featured = FEATURED_IDS.map((id) => THEMES.find((t) => t.id === id)).filter((t): t is Theme => !!t);
  if (!featured.some((t) => t.id === current)) {
    const mine = THEMES.find((t) => t.id === current);
    if (mine) featured[featured.length - 1] = mine;
  }
  const rest = THEMES.filter((t) => !featured.some((f) => f.id === t.id));
  return (
    <>
      <SettingRow agentExempt label="Palettes" below={<TileGrid items={featured} current={current} onPick={onChange} />} />
      <SettingRow agentExempt label="More palettes"
        hint={`${rest.length} more, ${experimental.length} of them experimental`}
        detail={{ summary: "Details", body: "The rest of the curated palettes, then the decorative and second-flavour ones kept for tinkering." }}
        control={<Button aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>{showAll ? "Hide" : "Show"}</Button>} />
      {showAll && <SettingRow agentExempt label="More dark palettes" below={<TileGrid items={rest.filter(isDarkTheme)} current={current} onPick={onChange} />} />}
      {showAll && <SettingRow agentExempt label="More light palettes" below={<TileGrid items={rest.filter((t) => !isDarkTheme(t))} current={current} onPick={onChange} />} />}
    </>
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
      .then((t) => { if (live && t.startsWith("<svg") && markReadsAtLabelSize(t)) setSvg(t); })
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

/** A look setting's value, read from the registry and re-read when anybody (the row, an agent, an undo) changes it. */
function useSetting<T extends string | number | boolean>(id: string): T {
  return useSyncExternalStore(subscribeSettings, () => setting(id).get() as T, () => setting(id).default as T);
}

const DENSITY_LABEL: Record<Density, string> = { compact: "Compact", comfortable: "Comfortable", roomy: "Roomy" };

/** The whole Appearance page: theme, accent, density and type. Owns the one
 *  decision — a mode click applies the matching serious theme, a grid click
 *  applies that palette and re-labels the segment — and keeps app state in step
 *  through `onChange`. */
export function AppearancePane({ current, onChange, onAccent }: {
  current: string; onChange: (id: string) => void;
  /** Told when the accent changes, so a page-level Reset can tell it moved. */
  onAccent?: (id: string) => void;
}) {
  const [mode, setMode] = useState<ThemeMode>(() => themeMode());
  /* Which desktop palette is on offer, if any — re-read when it moves, so the
     line under the switch names the theme that is actually on. */
  const [desk, setDesk] = useState(() => desktopPaletteName());
  useEffect(() => onDesktopPalette(() => { setDesk(desktopPaletteName()); setMode(themeMode()); }), []);

  const chooseMode = (m: ThemeMode) => {
    setting("appearance.mode").set(m);
    setMode(m);
    onChange(document.documentElement.getAttribute("data-theme") || current);
  };
  const choose = (id: string) => {
    setting("appearance.theme").set(id);
    setMode(themeMode());
    onChange(id);
  };

  const [accent, setAccentState] = useState(() => currentAccent());
  const chooseAccent = (id: string) => {
    setting("appearance.accent").set(id); // stores it and re-asserts the theme, so the overlay (or its removal) lands
    setAccentState(id);
    onAccent?.(id);
  };
  const following = accent === "";

  const density = useSetting<Density>("appearance.density");
  const fontPx = useSetting<number>("appearance.fontSize");
  const translucent = useSetting<boolean>("appearance.translucent");
  const reduce = useSetting<boolean>("appearance.reduceMotion");
  const canSeeThrough = translucentSupported();
  const [, setTick] = useState(0);
  const followsSystem = reduceMotionChoice() === null;

  const [view, setView] = useState<LiveView>("settings");
  const rail = useSyncExternalStore(subscribeRail, loadRail, () => SHIPPED_RAIL);
  return (
    <WithPreview preview={<PreviewCard id="appearance" title="The real app" actions={<LiveTabs view={view} onView={setView} />}>
      <AppearancePreview theme={current} accent={accent} density={density} fontPx={fontPx} translucent={translucent} view={view} rail={railItems(rail)} /></PreviewCard>}>
      <SettingsCard title="Theme" icon={<ThemeIcon size={ICON.sm} />}>
        <SettingRow
          settingId="appearance.mode"
          wide
          label="Mode"
          hint={desk && mode === "desktop" ? <>Wearing {desk.name}, your desktop's theme</> : "System follows your OS's dark or light"}
          detail={{ summary: "Details", body: desk && mode === "desktop"
            ? <>It follows when you switch themes on your desktop.</>
            : desk
              ? <>Your desktop's theme is {desk.name}, one click away. <b>System</b> follows your OS's dark or light.</>
              : <>A serious neutral pair. <b>System</b> follows your OS.</> }}
          control={<Segmented<ThemeMode> track label="Mode" value={mode} onChange={chooseMode}
            options={[...(desk ? [{ id: "desktop" as ThemeMode, label: <DesktopMark source={desk.source} /> }] : []), ...MODES.map(({ m, label }) => ({ id: m, label }))]} />}
        />
        <PaletteRows current={current} onChange={choose} />
      </SettingsCard>

      <SettingsCard title="Accent" icon={<SlidersIcon size={ICON.sm} />}
        desc={<>Laid over the theme's own colour. “Theme” means no override.</>}>
        {/* The first circle is the decision to follow the theme, drawn half
            dark and half light so it reads as "neither", and the seven after it
            are the colours to lay over. It replaces a switch beside them: a
            switch and eight round targets on one line crowded the words, and
            a circle that says "Theme" under the pointer says it in place. */}
        <SettingRow
          settingId="appearance.accent"
          label="Colour" modified={!following}
          hint={following
            ? <>Following {desk && mode === "desktop" ? <b style={{ color: "var(--text3)" }}>{desk.name}</b> : "your theme"}'s own primary</>
            : <>Laid over the theme's own primary</>}
          below={<span role="group" aria-label="Accent" className="flex flex-wrap items-center gap-2.5">
            {ACCENTS.map((a) => {
              const on = accent === a.id;
              const isTheme = a.id === "";
              return (
                <button key={a.id || "theme"} type="button" onClick={() => chooseAccent(a.id)} aria-pressed={on}
                  title={isTheme ? "Theme: no override" : a.name} aria-label={isTheme ? "Theme (no override)" : a.name}
                  className="agx-accent-dot" data-theme-dot={isTheme ? "" : undefined}
                  style={isTheme ? undefined : { background: a.primary }} />
              );
            })}
          </span>}
        />
      </SettingsCard>

      <SettingsCard title="Density & type" icon={<ThemeIcon size={ICON.sm} />}>
        <SettingRow
          settingId="appearance.density" label="Density" modified={density !== "comfortable"}
          hint="How much air rows and cards get."
          below={<Segmented<Density> track label="Density" value={density} onChange={(v) => setting("appearance.density").set(v)}
            options={DENSITIES.map((d) => ({ id: d, label: DENSITY_LABEL[d] }))} />} />
        <SettingRow
          settingId="appearance.fontSize" label="Interface font size" modified={fontPx !== 13}
          hint="Terminals have their own size."
          detail={{ summary: "Details", body: "Scales the text the app sets by a class. An icon, a size set inline and the terminal keep theirs. Display size, under Window & startup, scales everything at once." }}
          below={<Select value={String(fontPx)} onChange={(v) => setting("appearance.fontSize").set(Number(v))}
            options={UI_FONT_SIZES.map((n) => ({ value: String(n), label: `${n} px` }))} />} />
        <Toggle settingId="appearance.translucent" on={translucent} modified={translucent} disabled={!canSeeThrough}
          onClick={() => setting("appearance.translucent").set(!translucent)}
          label="Translucent window"
          hint={canSeeThrough ? "Lets the desktop blur through the sidebar." : IS_DESKTOP ? "Needs a newer desktop shell." : "Only the desktop app can do this."}
          detail={{ summary: "Details", body: "The rail, the top bar and this page's navigation let the desktop show through; the content keeps its own ground. On macOS and Windows it takes effect at once. On Linux a window is made see-through when it opens, so it is from the next launch." }} />
        <Toggle settingId="appearance.reduceMotion" on={reduce} modified={!followsSystem}
          onClick={() => setting("appearance.reduceMotion").set(!reduce)}
          label="Reduce motion"
          hint="Skips the sliding and fade animations."
          detail={{ summary: "Details", body: <>It follows your system's setting until you choose here.{!followsSystem && <> <button type="button" className="underline" onClick={() => { resetReduceMotion(); setTick((n) => n + 1); }}>Follow the system again</button>.</>} Turning it off does not undo the few animations the stylesheet drops by itself when the system asks for less motion.</> }} />
      </SettingsCard>
    </WithPreview>
  );
}
