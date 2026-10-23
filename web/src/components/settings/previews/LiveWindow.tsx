import { useEffect, useRef, useState, type CSSProperties } from "react";
import { DEFAULT_RAIL, MiniRail } from "./MiniApp.tsx";
import { LanternDemo } from "./LanternPreview.tsx";
import { DiffDemo } from "./DiffPreview.tsx";
import { SettingRow, Toggle } from "../../SettingRow.tsx";
import { SegControl, SettingsCard } from "../../SettingsKit.tsx";
import { SettingsPageHeader } from "../../SettingsPageHeader.tsx";
import { ThemeIcon } from "../../settingsNavIcons.tsx";
import { SURFACE_CSS } from "./Frame.tsx";
import { zoomScale, type RailItem } from "./logic.ts";
import type { Density } from "./logic.ts";

/** The views a live window can show. All three are the app's own components on invented data; the Dashboard is not one of them. */
export const LIVE_VIEWS = [
  { id: "settings", label: "Settings" }, { id: "lantern", label: "Lantern" }, { id: "diff", label: "Diff" },
] as const;
export type LiveView = (typeof LIVE_VIEWS)[number]["id"];

/** The width, in CSS px, the window is laid out at when Display size is 100 % (the preview is small, so this is narrower than a real window, which keeps its text readable). */
export const LIVE_BASE_W = 960;
/** The largest a miniature is drawn, as a share of real size: wider boxes show more of the window, not bigger text. */
const MINIATURE_MAX = 0.75;

const BORDER = "0.08em solid var(--surface-line)";

/** The width and height of the box the window is drawn into, as the browser lays it out. */
function useBox(): [React.RefObject<HTMLDivElement>, { w: number; h: number }] {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setBox({ w: el.clientWidth, h: el.clientHeight });
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, box];
}

/** Two cards of Settings rows, to show how density, type size, Display size and the toggles read. The controls do nothing here. */
function SettingsDemo({ zoomPct }: { zoomPct: number }) {
  const noop = () => {};
  const size = [90, 100, 110, 125].includes(zoomPct) ? String(zoomPct) : undefined;
  return (
    <div data-view-body="settings" className="agx-settings-page" style={{ padding: "0 0 16px" }}>
      <SettingsPageHeader label="Appearance" group={null} icon={ThemeIcon} what="How the window looks." chips={[]} />
      <div className="agx-settings-col" data-flow="single" style={{ padding: "0 24px", maxWidth: 620 }}>
        <SettingsCard title="Size and startup" icon={<ThemeIcon size={16} />}>
          <SettingRow agentExempt label="Display size" hint="How big everything inside the window is."
            below={<SegControl label="Display size" value={size} onPick={noop}
              options={[90, 100, 110, 125].map((n) => ({ v: String(n), label: `${n} %` }))} />} />
          <Toggle on={false} onClick={noop} label="Fullscreen" hint="Hide the window frame." />
          <Toggle on onClick={noop} label="Start at login" hint="Open agentglass when you log in." />
        </SettingsCard>
        <SettingsCard title="Density & type" icon={<ThemeIcon size={16} />}>
          <SettingRow agentExempt label="Density" hint="How much air rows and cards get."
            below={<SegControl label="Density" value="comfortable" onPick={noop}
              options={[{ v: "compact", label: "Compact" }, { v: "comfortable", label: "Comfortable" }, { v: "roomy", label: "Roomy" }]} />} />
          <Toggle on={false} onClick={noop} label="Translucent window" hint="Lets the desktop blur through the sidebar." />
          <Toggle on onClick={noop} label="Reduce motion" hint="Skips the flight and fade animations." />
        </SettingsCard>
      </div>
    </div>
  );
}

/** The tab pills that choose the view: they sit in the preview card's header, beside "The real app". */
export function LiveTabs({ view, onView }: { view: LiveView; onView: (v: LiveView) => void }) {
  return <SegControl label="View" value={view} onPick={onView} options={LIVE_VIEWS.map((v) => ({ v: v.id, label: v.label }))} />;
}

export interface LiveWindowProps {
  view: LiveView;
  /** Display size, percent: the window is laid out at 960 px / this. */
  zoomPct: number;
  /** The drawers of the rail; the rail the person arranged, else the shipped one. */
  rail?: readonly RailItem[];
  /** The width over the height of the box this fills. */
  aspect: number;
  density?: Density;
  fontPx?: number;
  /** The rail and top strip let the desktop through (the wallpaper behind shows). */
  translucent?: boolean;
}

/**
 * The app's window at its real size, drawn into a box smaller than it:
 * the components are the app's own (a Settings page, the Lantern's cards, a
 * diff), laid out in a window `LIVE_BASE_W / zoom` wide and scaled down to fit,
 * so Display size changes how much of the app fits, as it does on the desktop,
 * and density and type size act on the real rows because they are real rows.
 */
export function LiveWindow({ view, zoomPct, rail, aspect, density, fontPx, translucent }: LiveWindowProps) {
  const [ref, box] = useBox();
  const z = zoomScale(zoomPct);
  // The box is a screen. At 100 % its pixels are drawn at `s0` of their size, never larger than a
  // miniature should be; Display size multiplies that, so a bigger size makes the app bigger inside
  // the same window and less of it fits, as on the desktop.
  const w = box.w || 480;
  const s0 = Math.min(w / LIVE_BASE_W, MINIATURE_MAX);
  const k = s0 * z;
  const vw = w / k;
  const vh = (box.h || w / aspect) / k;
  const look: CSSProperties = {
    ...(fontPx ? ({ "--agx-fs": fontPx / 13 } as CSSProperties) : null),
  };
  return (
    <div ref={ref} data-live-window={view} role="img" aria-label="The app's window" className="min-w-0 w-full relative overflow-hidden"
      style={{ aspectRatio: String(aspect), borderRadius: "0.5em" }}>
      <style>{`${SURFACE_CSS}.agx-pv-ic svg{width:1.25em;height:1.25em}`}</style>
      <div data-preview-box data-density={density && density !== "comfortable" ? density : undefined} data-ui-font={fontPx && fontPx !== 13 ? String(fontPx) : undefined}
        className="flex" style={{ ...look, width: vw, height: vh, transform: `scale(${k})`, transformOrigin: "0 0", background: "var(--bg)", color: "var(--text)", fontSize: 13, border: BORDER }}>
        <div style={{ background: "var(--surface-nav)", borderRight: BORDER, backdropFilter: translucent ? "blur(8px)" : undefined }}>
          <MiniRail items={rail ?? DEFAULT_RAIL} selected={view === "settings" ? "plugins" : view === "diff" ? "diff" : "lantern"} />
        </div>
        <div className="flex-1 min-w-0 overflow-hidden" style={{ background: "var(--bg)" }}>
          {view === "settings" && <SettingsDemo zoomPct={zoomPct} />}
          {view === "lantern" && <div data-view-body="lantern" style={{ padding: 16 }}><LanternDemo watch everyMin={5} wakeMin={5} /></div>}
          {view === "diff" && <div data-view-body="diff" style={{ padding: 16 }}><DiffDemo split wrap={false} /></div>}
        </div>
      </div>
    </div>
  );
}
