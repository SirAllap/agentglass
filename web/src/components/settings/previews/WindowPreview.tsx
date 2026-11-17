import { LiveWindow } from "./LiveWindow.tsx";
import { DesktopFrame } from "./DesktopFrame.tsx";
import { PreviewNote } from "./Frame.tsx";
import type { RailItem } from "./logic.ts";

export interface WindowPreviewProps {
  /** Display size, percent: 90 to 125. */
  zoomPct: number;
  fullscreen: boolean;
  startAtLogin: boolean;
  launchAnimation: boolean;
  /** The top bar's clock, shown in fullscreen where the desktop's own is hidden. */
  showClock: boolean;
  codexQuota: boolean;
  rail?: readonly RailItem[];
}

/** The window on a desktop: the frame, the size, the tray icon, the clock, the Codex line and the launch cover each follow one control. */
export function WindowPreview(p: WindowPreviewProps) {
  const clock = p.showClock && p.fullscreen;
  return (
    <div className="flex flex-col gap-3 min-w-0">
      <DesktopFrame preview="window" fullscreen={p.fullscreen} tray={p.startAtLogin} quota={p.codexQuota} clock={clock} cover={p.launchAnimation}>
        <LiveWindow view="diff" zoomPct={p.zoomPct} rail={p.rail} aspect={p.fullscreen ? 1.2 : 1.45} />
      </DesktopFrame>
      <PreviewNote>The window is the app's own screens on invented data. The frame, size, clock, Codex line, tray icon and launch cover each follow a control on the left.</PreviewNote>
    </div>
  );
}
