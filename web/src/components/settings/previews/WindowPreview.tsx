import { LiveWindow, type LiveView } from "./LiveWindow.tsx";
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
  /** Which of the app's screens the window shows (the tabs live in the card's header). */
  view: LiveView;
  rail?: readonly RailItem[];
}

/** The window on a desktop: the frame, the size, the tray icon, the clock, the Codex line and the launch cover each follow one control. */
export function WindowPreview(p: WindowPreviewProps) {
  const clock = p.showClock && p.fullscreen;
  return (
    <div className="flex flex-col gap-3 min-w-0">
      <div data-preview="window" className="min-w-0 flex flex-col overflow-hidden"
        style={{ background: "linear-gradient(135deg, var(--bg3), color-mix(in srgb, var(--primary) 22%, var(--bg4)))", borderRadius: "0.9rem" }}>
        <div className="flex items-center" style={{ height: 30, padding: "0 12px", gap: 12, fontSize: 11, background: "color-mix(in srgb, var(--bg) 70%, transparent)", color: "var(--text2)" }}>
          {p.startAtLogin && <span data-tray style={{ color: "var(--primary)", fontWeight: 600 }}>agentglass</span>}
          <span className="flex-1" />
          {p.codexQuota && <span data-quota>Codex 41 % · live</span>}
          <span>Tue 23 Oct</span>
          {clock && <b data-clock>10:42</b>}
        </div>
        <div style={{ padding: p.fullscreen ? 0 : "22px 22px 28px", position: "relative" }}>
          {!p.fullscreen && (
            <div data-frame className="flex items-center" style={{ gap: 6, height: 24, padding: "0 10px", background: "var(--surface-card)", color: "var(--text3)", fontSize: 10, borderRadius: "8px 8px 0 0" }}>
              <i style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--text4)" }} /><i style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--text4)" }} /><i style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--text4)" }} />
              <span className="flex-1 text-center">agentglass</span>
            </div>
          )}
          <LiveWindow view={p.view} zoomPct={p.zoomPct} rail={p.rail} aspect={p.fullscreen ? 1.2 : 1.45} />
          {p.launchAnimation && (
            <div data-cover style={{ position: "absolute", right: p.fullscreen ? 12 : 34, bottom: p.fullscreen ? 12 : 40, padding: "6px 12px", borderRadius: 8, background: "var(--bg)", color: "var(--text)", fontSize: 11, boxShadow: "var(--surface-lift)" }}>Launch cover plays first</div>
          )}
        </div>
      </div>
      <PreviewNote>The window is the app's own screens on invented data. The frame, size, clock, Codex line, tray icon and launch cover each follow a control on the left.</PreviewNote>
    </div>
  );
}
