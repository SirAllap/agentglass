/*
 * Step 2: how the window looks.
 *
 * The three modes and the palette under them, as the mock draws them. A mode
 * click applies at once; a palette click applies its theme and leaves the mode
 * at "custom", which is what the Appearance page already does.
 */
import { ICON } from "../../lib/iconSize.ts";
import { modeTiles, paletteRows, type PaletteRow } from "../../lib/setupTheme.ts";
import { THEMES } from "../../lib/themes.ts";
import { ThemePreview, Tile } from "./Tile.tsx";

export function ThemeStep({ mode, theme, desk, onMode, onTheme }: {
  mode: string;
  theme: string;
  /** The desktop's palette name, when the desktop publishes one. */
  desk: { name: string } | null;
  onMode: (id: "system" | "light" | "dark") => void;
  onTheme: (id: string) => void;
}) {
  const modes = modeTiles(mode);
  const palettes: PaletteRow[] = paletteRows(THEMES, theme, desk);
  return (
    <>
      <div className="setup-eyebrow">Appearance</div>
      <h1 className="setup-h1">Make it yours</h1>
      <p className="setup-lede">
        System follows your desktop, so this window changes with the rest of it. The palette is what the
        app paints; a theme can be changed any time in Settings › Appearance.
      </p>

      <div className="setup-tiles setup-tiles-3" role="group" aria-label="Mode">
        {modes.map((m) => (
          <Tile
            key={m.id}
            id={`setup-mode-${m.id}`}
            preview={<ThemePreview kind={m.id} />}
            name={m.name}
            what={m.what}
            state={m.state}
            tone="off"
            selected={m.selected}
            onPick={() => onMode(m.id)}
          />
        ))}
      </div>

      <div className="setup-group">
        <div className="setup-group-head">
          <span className="setup-group-title">Palette</span>
          <span className="setup-group-why">· the colours inside that</span>
        </div>
        {palettes.length === 0 ? (
          <p className="setup-note">No palette could be read. The app's own colours are used.</p>
        ) : (
          <div className="setup-palettes">
            {palettes.map((p) => (
              <button
                type="button"
                key={p.id}
                className="setup-pal"
                data-on={p.selected ? "1" : "0"}
                aria-pressed={p.selected}
                onClick={() => onTheme(p.id)}
              >
                <span className="setup-pal-sw" aria-hidden="true">
                  {p.swatches.map((c, i) => <i key={i} style={{ background: c }} />)}
                </span>
                <span className="setup-pal-name">{p.name}</span>
                {p.selected && <span className="setup-pal-check" aria-label="Selected"><Check /></span>}
                {!p.selected && p.id === "desktop" && <span className="setup-pal-why">from your desktop</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function Check() {
  return (
    <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 8.5 6.2 11.7 13 4.9" />
    </svg>
  );
}
