import { LiveWindow, type LiveView } from "./LiveWindow.tsx";
import { PreviewNote } from "./Frame.tsx";
import { previewVars } from "./previewTheme.ts";
import type { Density, RailItem } from "./logic.ts";

export interface AppearancePreviewProps {
  /** A listed theme id; anything else keeps the theme the app wears. */
  theme: string;
  /** An accent id; "" lays nothing over the theme. */
  accent: string;
  density: Density;
  fontPx: number;
  translucent: boolean;
  /** Which of the app's screens the window shows (the tabs live in the card's header). */
  view: LiveView;
  rail?: readonly RailItem[];
}

/** The app's own screens, in the theme and accent being chosen, at the density and font size set. Nothing is painted on the real app. */
export function AppearancePreview(p: AppearancePreviewProps) {
  return (
    <div className="flex flex-col gap-3 min-w-0">
      <div data-preview="appearance" className="min-w-0 rounded-lg"
        style={{ ...previewVars(p.theme, p.accent), background: p.translucent ? "linear-gradient(135deg, var(--bg3), color-mix(in srgb, var(--primary) 22%, var(--bg4)))" : "transparent", padding: p.translucent ? "1.2em" : 0 }}>
        <LiveWindow view={p.view} zoomPct={100} aspect={1.45} rail={p.rail} density={p.density} fontPx={p.fontPx} translucent={p.translucent} />
      </div>
      <PreviewNote>The app's own screens on invented data, in the theme and accent chosen.</PreviewNote>
    </div>
  );
}
