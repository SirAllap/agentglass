// Appearance on the new Settings shell: Look, Theme, Window, Sidebar.
// Every value saves at once with "Saved · Undo". Same stores and setting ids as
// before; only where they live changed. Window values keep the modal's state
// (it feeds the page chip and reset), so they come in as `c`.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { SettingsPage, type PageSection } from "../shell/SettingsPage.tsx";
import { Section } from "../shell/Section.tsx";
import { SettingRow } from "../shell/SettingRow.tsx";
import { instantSave, pushSaveToast, SaveToastHost } from "../save/index.ts";
import { Segmented, Button } from "../../workspace/Chrome.tsx";
import { Select } from "../../Select.tsx";
import { ScaleControl } from "../../SettingsModal.tsx";
import { setting, subscribeSettings } from "../../../lib/settingsRegistry.ts";
import { THEMES, themeMode, desktopPaletteName, onDesktopPalette, type ThemeMode } from "../../../lib/themes.ts";
import { ACCENTS, currentAccent } from "../../../lib/accent.ts";
import { DENSITIES, UI_FONT_SIZES, reduceMotionChoice, type Density } from "../../../lib/lookPrefs.ts";
import { IS_DESKTOP, toggleFullscreen, setAutostart, translucentSupported } from "../../../lib/desktop.ts";
import { SCALES } from "../../../lib/uiScale.ts";
import { setClock24 } from "../../../lib/clockPref.ts";
import { setSplashOn } from "../../../lib/splashPref.ts";
import { VIEWS, RAIL_PLACES, SHIPPED_RAIL, loadRail, moveView, subscribeRail, type RailPlace } from "../../workspace/views.ts";
import { COUNTED_VIEWS, railBadgeOn, railBadgesKey, subscribeRailBadges } from "../../../lib/railBadges.ts";
import { keyRowName } from "../../../lib/keybindings.ts";
import { openSettings } from "../../../lib/openSettings.ts";
import { rowId } from "../../../lib/settingsIndex.ts";
import { Switch } from "../../SettingRow.tsx";
import { APPEARANCE_PURPOSE, APPEARANCE_SECTIONS } from "./appearanceModel.ts";
import { AppearancePreview } from "../previews/AppearancePreview.tsx";
import type { PageCtx } from "./ctx.ts";

/** Help text comes from the model, so the page and its copy test read one list. */
const help = (section: string, label: string) =>
  APPEARANCE_SECTIONS.find((s) => s.id === section)!.rows.find((r) => r.label === label)!.help;

/** A registry value, re-read when anybody (this row, an agent, an Undo) changes it. */
function useSetting<T extends string | number | boolean>(id: string): T {
  return useSyncExternalStore(subscribeSettings, () => setting(id).get() as T, () => setting(id).default as T);
}

const DENSITY_LABEL: Record<Density, string> = { compact: "Compact", comfortable: "Comfortable", roomy: "Roomy" };
const MODES: { id: ThemeMode; label: string }[] = [
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
  { id: "system", label: "System" },
];

/** Registry-backed save: write now, toast, Undo goes back through the same writer. */
function save<T>(id: string, old: T, next: T, message?: string): void {
  instantSave(old, next, (v) => setting(id).set(v as never), { message });
}

function SwitchControl({ on, label, onChange, disabled }: { on: boolean; label: string; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} className="agx-btn" onClick={() => onChange(!on)}>
      <Switch on={on} />
    </button>
  );
}

export function AppearancePage({ c }: { c: PageCtx }) {
  const { autostart, fullscreen, h24, onTheme, onZoom, scale, setAccentState, setAutostartState, setFullscreenState, setH24, setSplash, splash } = c;

  // ── Look
  const density = useSetting<Density>("appearance.density");
  const fontPx = useSetting<number>("appearance.fontSize");
  const reduce = useSetting<boolean>("appearance.reduceMotion");
  const translucent = useSetting<boolean>("appearance.translucent");
  const canSeeThrough = translucentSupported();
  useSyncExternalStore(subscribeSettings, () => String(reduceMotionChoice()), () => "null");

  // ── Theme
  const [mode, setMode] = useState<ThemeMode>(() => themeMode());
  const [desk, setDesk] = useState(() => desktopPaletteName());
  useEffect(() => onDesktopPalette(() => { setDesk(desktopPaletteName()); setMode(themeMode()); }), []);
  const palette = useSetting<string>("appearance.theme");
  const [accent, setAccent] = useState(() => currentAccent());
  const writeMode = (m: ThemeMode) => { setting("appearance.mode").set(m); setMode(m); onTheme(document.documentElement.getAttribute("data-theme") || palette); };
  const writePalette = (id: string) => { setting("appearance.theme").set(id); setMode(themeMode()); onTheme(id); };
  const writeAccent = (id: string) => { setting("appearance.accent").set(id); setAccent(id); setAccentState(id); };

  // ── Window: the modal owns these values; Undo goes back through the same setters.
  const prevScale = useRef(scale);
  useEffect(() => {
    const from = prevScale.current;
    prevScale.current = scale;
    if (from === scale) return;
    pushSaveToast("Saved", () => {
      const d = SCALES.indexOf(from) - SCALES.indexOf(scale);
      for (let n = 0; n < Math.abs(d); n++) onZoom(d > 0 ? 1 : -1);
    });
  }, [scale, onZoom]);
  const writeFullscreen = async () => {
    setFullscreenState(await toggleFullscreen());
    pushSaveToast("Saved", async () => setFullscreenState(await toggleFullscreen()));
  };
  const writeAutostart = async () => {
    const was = autostart === true;
    const next = await setAutostart(!was);
    if (next === null) return;
    setAutostartState(next);
    pushSaveToast("Saved", async () => { const back = await setAutostart(was); if (back !== null) setAutostartState(back); });
  };

  // ── Sidebar: one view at a time, so the four rows stay four rows.
  const rail = useSyncExternalStore(subscribeRail, loadRail, () => SHIPPED_RAIL);
  useSyncExternalStore(subscribeRailBadges, railBadgesKey, railBadgesKey);
  const placeOf = (vid: string): RailPlace => RAIL_PLACES.find((p) => rail[p].some((x) => x.id === vid)) ?? "hidden";
  const [pickId, setPickId] = useState<string>(() => (rail.work[0] ?? rail.utility[0] ?? rail.hidden[0])?.id ?? VIEWS[0]!.id);
  const v = VIEWS.find((x) => x.id === pickId) ?? VIEWS[0]!;
  const place = placeOf(v.id);
  const at = rail[place].findIndex((x) => x.id === v.id);
  const lastPlace = useRef(new Map<string, RailPlace>());
  const shippedPlace = (RAIL_PLACES.find((p) => SHIPPED_RAIL[p].some((x) => x.id === v.id)) ?? "work");
  const placeId = `rail.place.${v.id}`;
  const writePlace = (to: string, message?: string) => instantSave(place as string, to, (val) => setting(placeId).set(val as never), { message });

  const sections: PageSection[] = [
    { id: "look", title: "Look", kind: "normal", body: (
      <Section id="look" title="Look">
        <SettingRow kind="control" settingId="appearance.density" label="Density" help={help("look", "Density")}
          control={<Segmented<Density> track label="Density" value={density} onChange={(n) => save("appearance.density", density, n)}
            options={DENSITIES.map((d) => ({ id: d, label: DENSITY_LABEL[d] }))} />} />
        <SettingRow kind="control" settingId="appearance.fontSize" label="Interface font size" help={help("look", "Interface font size")}
          control={<Select value={String(fontPx)} onChange={(n) => save("appearance.fontSize", fontPx, Number(n))}
            options={UI_FONT_SIZES.map((n) => ({ value: String(n), label: `${n} px` }))} />} />
        <SettingRow kind="control" settingId="appearance.reduceMotion" label="Reduce motion" help={help("look", "Reduce motion")}
          control={<SwitchControl on={reduce} label="Reduce motion" onChange={(n) => save("appearance.reduceMotion", reduce, n)} />} />
        {canSeeThrough
          ? <SettingRow kind="control" settingId="appearance.translucent" label="Translucent window" help={help("look", "Translucent window")}
              control={<SwitchControl on={translucent} label="Translucent window" onChange={(n) => save("appearance.translucent", translucent, n)} />} />
          : <SettingRow kind="locked" settingId="appearance.translucent" label="Translucent window" help={help("look", "Translucent window")}
              reason={IS_DESKTOP ? "Needs a newer desktop shell" : "Only the desktop app can do this"}
              control={<SwitchControl on={translucent} label="Translucent window" disabled onChange={() => {}} />} />}
      </Section>
    ) },
    { id: "theme", title: "Theme", kind: "normal", body: (
      <Section id="theme" title="Theme">
        <SettingRow kind="control" settingId="appearance.mode" label="Mode" help={help("theme", "Mode")}
          control={<Segmented<ThemeMode> track label="Mode" value={mode}
            onChange={(m) => instantSave(mode, m, writeMode)}
            options={[...(desk ? [{ id: "desktop" as ThemeMode, label: desk.name }] : []), ...MODES]} />} />
        <SettingRow kind="control" settingId="appearance.theme" label="Palette" help={help("theme", "Palette")}
          control={<Select value={palette} onChange={(id) => instantSave(palette, id, writePalette)}
            options={THEMES.map((t) => ({ value: t.id, label: t.name }))} />} />
        <SettingRow kind="control" settingId="appearance.accent" label="Accent color" help={help("theme", "Accent color")}
          control={<span role="group" aria-label="Accent" className="flex flex-wrap items-center gap-2.5">
            {ACCENTS.map((a) => (
              <button key={a.id || "theme"} type="button" aria-pressed={accent === a.id} aria-label={a.id === "" ? "Theme (no override)" : a.name}
                className="agx-accent-dot" data-theme-dot={a.id === "" ? "" : undefined} style={a.id === "" ? undefined : { background: a.primary }}
                onClick={() => instantSave(accent, a.id, writeAccent)} />
            ))}
          </span>} />
      </Section>
    ) },
    { id: "window", title: "Window", kind: "normal", body: (
      <Section id="window" title="Window">
        <SettingRow kind="control" agentExempt label="Clock" help={help("window", "Clock")}
          control={<Segmented<"12" | "24"> track label="Clock" value={h24 ? "24" : "12"}
            onChange={(n) => instantSave(h24, n === "24", (b) => { setClock24(b); setH24(b); })}
            options={[{ id: "12", label: "12 h" }, { id: "24", label: "24 h" }]} />} />
        <SettingRow kind="control" agentExempt label="Fullscreen" help={help("window", "Fullscreen")}
          control={<SwitchControl on={fullscreen} label="Fullscreen" onChange={() => { void writeFullscreen(); }} />} />
        <SettingRow kind="control" agentExempt label="Launch animation" help={help("window", "Launch animation")}
          control={<SwitchControl on={splash} label="Launch animation" onChange={(n) => instantSave(splash, n, (b) => { setSplashOn(b); setSplash(b); }, { message: "Saved · plays from the next launch" })} />} />
        {autostart !== null && (
          <SettingRow kind="control" agentExempt label="Start at login" help={help("window", "Start at login")}
            control={<SwitchControl on={autostart} label="Start at login" onChange={() => { void writeAutostart(); }} />} />
        )}
        {IS_DESKTOP && (
          <SettingRow kind="control" agentExempt label="Display size" help={help("window", "Display size")}
            control={<ScaleControl scale={scale} onZoom={onZoom} />} />
        )}
      </Section>
    ) },
    { id: "sidebar", title: "Sidebar", kind: "normal", body: (
      <Section id="sidebar" title="Sidebar">
        <SettingRow kind="control" agentExempt label="View" help={help("sidebar", "View")}
          control={<Select value={v.id} onChange={setPickId} options={VIEWS.map((x) => ({ value: x.id, label: x.label }))} />} />
        <SettingRow kind="control" agentExempt label="Shown on the rail" help={help("sidebar", "Shown on the rail")}
          control={<SwitchControl on={place !== "hidden"} label="Shown on the rail" onChange={(on) => {
            if (!on) { lastPlace.current.set(v.id, place); writePlace("hidden"); }
            else writePlace(lastPlace.current.get(v.id) ?? shippedPlace);
          }} />} />
        <SettingRow kind="control" settingId={`rail.place.${v.id}`} label="Sits at" help={help("sidebar", "Sits at")}
          control={<Segmented<"work" | "utility"> track label="Sits at" disabled={place === "hidden"} value={place === "utility" ? "utility" : "work"}
            onChange={(p) => writePlace(p)} options={[{ id: "work", label: "Top" }, { id: "utility", label: "Bottom" }]} />} />
        <SettingRow kind="control" agentExempt label="Order" help={help("sidebar", "Order")}
          control={<span className="flex items-center gap-1.5">
            <Button size="compact" disabled={place === "hidden" || at <= 0} onClick={() => moveView(v.id as never, place, at - 1)}>Move up</Button>
            <Button size="compact" disabled={place === "hidden" || at < 0 || at >= rail[place].length - 1} onClick={() => moveView(v.id as never, place, at + 1)}>Move down</Button>
          </span>} />
        {v.id in COUNTED_VIEWS && (
          <SettingRow kind="control" settingId={`rail.badge.${v.id}`} label="Count badge" help={help("sidebar", "Count badge")}
            control={<SwitchControl on={railBadgeOn(v.id as never)} label="Count badge"
              onChange={(n) => instantSave(railBadgeOn(v.id as never), n, (b) => setting(`rail.badge.${v.id}`).set(b))} />} />
        )}
        <SettingRow kind="link" agentExempt label="Shortcut" help={help("sidebar", "Shortcut")} linkText="Open Shortcuts"
          onOpen={() => openSettings("keys", rowId(keyRowName(`view.${v.id}`)))} />
      </Section>
    ) },
  ];

  return (
    <>
      <SettingsPage title="Appearance" purpose={APPEARANCE_PURPOSE} sections={sections}
        aside={<AppearancePreview theme={palette} accent={accent} density={density} fontPx={fontPx} translucent={translucent} />} />
      <SaveToastHost />
    </>
  );
}
