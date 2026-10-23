import { useState } from "react";
import { DEFAULT_RAIL, MiniApp, MINI_VIEWS, type MiniView } from "./MiniApp.tsx";
import { PreviewNote, Scaled } from "./Frame.tsx";
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

/** The window in the theme and accent being chosen, at the density and font size set, in four views. Nothing is painted on the real app. */
export function AppearancePreview(p: AppearancePreviewProps) {
  const [view, setView] = useState<MiniView>("dash");
  return (
    <div className="flex flex-col gap-3 min-w-0">
      <div role="tablist" aria-label="View" className="agx-seg">
        {MINI_VIEWS.map((v) => (
          <button key={v.id} type="button" role="tab" aria-selected={view === v.id} data-on={view === v.id ? "" : undefined} onClick={() => setView(v.id)}
            className="text-[11px] px-2 py-1 rounded-md border-0 cursor-pointer"
            style={{ background: view === v.id ? "var(--surface-card)" : "transparent", color: view === v.id ? "var(--text)" : "var(--text3)" }}>{v.label}</button>
        ))}
      </div>
      <Scaled label="The window in the chosen theme" vars={previewVars(p.theme, p.accent)}>
        <div data-preview="appearance" style={{ background: p.translucent ? "linear-gradient(135deg, var(--primary), var(--bg4))" : "transparent", padding: p.translucent ? "1.2em" : 0, borderRadius: "1em" }}>
          <MiniApp view={view} rail={p.rail ?? DEFAULT_RAIL} density={p.density} fontPx={p.fontPx} translucent={p.translucent} />
        </div>
      </Scaled>
      <PreviewNote>A miniature on demo data, in the theme and accent chosen.</PreviewNote>
    </div>
  );
}
