import { LiveWindow } from "./LiveWindow.tsx";
import { DesktopFrame } from "./DesktopFrame.tsx";
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
  rail?: readonly RailItem[];
}

/** The app's own screens, in the theme and accent being chosen, at the density and font size set. Nothing is painted on the real app. */
export function AppearancePreview(p: AppearancePreviewProps) {
  return (
    <div className="flex flex-col gap-3 min-w-0">
      <DesktopFrame preview="appearance" vars={previewVars(p.theme, p.accent)}>
        <LiveWindow view="diff" zoomPct={100} aspect={1.45} rail={p.rail} density={p.density} fontPx={p.fontPx} translucent={p.translucent} />
      </DesktopFrame>
      <PreviewNote>The app's own screens on invented data, in the theme and accent chosen.</PreviewNote>
    </div>
  );
}
