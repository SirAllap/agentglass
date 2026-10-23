import { DEFAULT_RAIL, MiniApp } from "./MiniApp.tsx";
import { PreviewNote, Scaled } from "./Frame.tsx";
import { zoomScale, type RailItem } from "./logic.ts";

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
    <Scaled label="The window on a desktop">
      <div data-preview="window" style={{ background: "linear-gradient(135deg, var(--bg3), color-mix(in srgb, var(--primary) 22%, var(--bg4)))", borderRadius: "1em", padding: p.fullscreen ? 0 : "0 0 1.4em" }}>
        <div className="flex items-center" style={{ height: "2.6em", padding: "0 1em", gap: "1em", fontSize: "0.9em", background: "color-mix(in srgb, var(--bg) 70%, transparent)", color: "var(--text2)", borderRadius: "1em 1em 0 0" }}>
          {p.startAtLogin && <span data-tray style={{ color: "var(--primary)", fontWeight: 600 }}>agentglass</span>}
          <span className="flex-1" />
          {p.codexQuota && <span data-quota>Codex 41 % · live</span>}
          <span>Tue 23 Oct</span>
          {clock && <b data-clock>10:42</b>}
        </div>
        <div style={{ margin: p.fullscreen ? "0" : "1.2em 1.6em 0", position: "relative" }}>
          {!p.fullscreen && (
            <div data-frame className="flex items-center" style={{ gap: "0.4em", height: "2em", padding: "0 0.8em", background: "var(--surface-card)", color: "var(--text3)", fontSize: "0.8em", borderRadius: "0.8em 0.8em 0 0" }}>
              <i style={{ width: "0.7em", height: "0.7em", borderRadius: "50%", background: "var(--text4)" }} /><i style={{ width: "0.7em", height: "0.7em", borderRadius: "50%", background: "var(--text4)" }} /><i style={{ width: "0.7em", height: "0.7em", borderRadius: "50%", background: "var(--text4)" }} />
              <span className="flex-1 text-center">agentglass</span>
            </div>
          )}
          <MiniApp view="dash" rail={p.rail ?? DEFAULT_RAIL} fontPx={13 * zoomScale(p.zoomPct)} style={{ borderRadius: p.fullscreen ? 0 : "0 0 0.8em 0.8em" }} />
          {p.launchAnimation && (
            <div data-cover style={{ position: "absolute", right: "0.8em", bottom: "0.8em", padding: "0.5em 1em", borderRadius: "0.7em", background: "var(--bg)", color: "var(--text)", fontSize: "0.85em", boxShadow: "var(--surface-lift)" }}>Launch cover plays first</div>
          )}
        </div>
      </div>
      <div style={{ marginTop: "0.8em" }}><PreviewNote>A miniature on demo data; it follows each control on the left.</PreviewNote></div>
    </Scaled>
  );
}
