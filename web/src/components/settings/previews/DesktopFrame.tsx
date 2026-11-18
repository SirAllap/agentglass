import type { CSSProperties, ReactNode } from "react";

/**
 * The desktop the preview windows sit on: the surround, the top bar ("agentglass" tray name, quota line, date, clock) and
 * the window's own title bar with its three dots. Window & startup and Appearance both draw their window inside this one
 * component; a preview differs only in what it passes (its theme as `vars`, which bar items show).
 */
export function DesktopFrame({ preview, vars, fullscreen = false, tray = false, quota = false, clock = false, cover = false, children }: {
  /** The `data-preview` name the settings tests and captures look for. */
  preview: string;
  /** Theme variables laid over the frame, so the desktop and the window wear the same theme. */
  vars?: CSSProperties;
  fullscreen?: boolean;
  /** The tray name at the bar's start. */
  tray?: boolean;
  quota?: boolean;
  clock?: boolean;
  /** The launch cover chip. */
  cover?: boolean;
  children: ReactNode;
}) {
  return (
    <div data-preview={preview} data-desktop-frame className="min-w-0 flex flex-col overflow-hidden"
      style={{ ...vars, background: "linear-gradient(135deg, var(--bg3), color-mix(in srgb, var(--primary) 22%, var(--bg4)))", borderRadius: "0.9rem" }}>
      <div className="flex items-center" style={{ height: 30, padding: "0 12px", gap: 12, fontSize: 11, background: "color-mix(in srgb, var(--bg) 70%, transparent)", color: "var(--text2)" }}>
        {tray && <span data-tray style={{ color: "var(--primary)", fontWeight: 600 }}>agentglass</span>}
        <span className="flex-1" />
        {quota && <span data-quota>Codex 41 % · live</span>}
        <span>Tue 23 Oct</span>
        {clock && <b data-clock>10:42</b>}
      </div>
      <div style={{ padding: fullscreen ? 0 : "22px 22px 28px", position: "relative" }}>
        {!fullscreen && (
          <div data-frame className="flex items-center" style={{ gap: 6, height: 24, padding: "0 10px", background: "var(--surface-card)", color: "var(--text3)", fontSize: 10, borderRadius: "8px 8px 0 0" }}>
            <i style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--text4)" }} /><i style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--text4)" }} /><i style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--text4)" }} />
            <span className="flex-1 text-center">agentglass</span>
          </div>
        )}
        {children}
        {cover && (
          <div data-cover style={{ position: "absolute", right: fullscreen ? 12 : 34, bottom: fullscreen ? 12 : 40, padding: "6px 12px", borderRadius: 8, background: "var(--bg)", color: "var(--text)", fontSize: 11, boxShadow: "var(--surface-lift)" }}>Launch cover plays first</div>
        )}
      </div>
    </div>
  );
}
