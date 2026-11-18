import { DrawnChip, PreviewNote, Scaled } from "./Frame.tsx";
import { searchPlaceholder } from "./logic.ts";

export interface BrowserPreviewProps {
  /** Where the view opens; empty is a blank page. */
  home: string;
  /** Display name of the search engine. */
  searchEngine: string;
  /** The small drawing at the right of the rows' card (Browser page): the address bar and the search box only. */
  compact?: boolean;
}

/** A new tab, drawn: the address bar shows the home page and the search box names the engine. Not a capture. */
export function BrowserPreview({ home, searchEngine, compact = false }: BrowserPreviewProps) {
  const url = home.trim() || "about:blank";
  if (compact) return (
    <div data-preview="browser" role="img" aria-label="A new browser tab" className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg" style={{ background: "var(--surface-inset)", border: "0.08em solid var(--surface-line)" }}>
      <div className="flex items-center gap-1.5 px-2 py-1.5" style={{ background: "var(--surface-card)", borderBottom: "0.08em solid var(--surface-line)" }}>
        <span aria-hidden className="flex shrink-0 gap-1">{[0, 1].map((i) => <i key={i} className="block rounded-full" style={{ width: 6, height: 6, background: "var(--border2)" }} />)}</span>
        <span data-url className="min-w-0 flex-1 truncate rounded px-2 py-0.5 font-mono text-[11px]" style={{ background: "var(--surface-inset)", color: "var(--text2)" }}>{url}</span>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-3 py-4">
        <span data-search className="max-w-full truncate rounded-full px-3 py-1 text-[11px]" style={{ background: "var(--surface-card)", border: "0.08em solid var(--surface-line)", color: "var(--text3)" }}>{searchPlaceholder(searchEngine)}</span>
        <span className="text-[11px]" style={{ color: "var(--text3)" }}>Drawn, not a capture</span>
      </div>
    </div>
  );
  return (
    <Scaled label="A new browser tab">
      <div data-preview="browser" style={{ background: "var(--bg)", borderRadius: "0.9em", overflow: "hidden", border: "0.08em solid var(--surface-line)" }}>
        <div className="flex" style={{ gap: "0.3em", padding: "0.5em 0.6em 0", background: "var(--surface-nav)", fontSize: "0.85em" }}>
          <span style={{ padding: "0.4em 1.2em", background: "var(--bg)", borderRadius: "0.6em 0.6em 0 0" }}>New tab</span>
          <span style={{ padding: "0.4em 1.2em", color: "var(--text3)" }}>Docs</span>
        </div>
        <div className="flex items-center" style={{ padding: "0.6em 0.9em", gap: "0.8em", borderBottom: "0.08em solid var(--surface-line)" }}>
          <span style={{ color: "var(--text4)" }}>‹</span>
          <span data-url className="flex-1 min-w-0 truncate" style={{ padding: "0.4em 0.9em", borderRadius: "999px", background: "var(--surface-inset)", color: "var(--text2)", fontFamily: "var(--font-mono, monospace)", fontSize: "0.9em" }}>{url}</span>
        </div>
        <div className="flex flex-col items-center justify-center" style={{ padding: "3em 1em", gap: "1em", color: "var(--text3)", minHeight: "26em" }}>
          <b style={{ color: "var(--text)", fontSize: "1.6em" }}>Orbit</b>
          <span data-search style={{ padding: "0.7em 1.6em", borderRadius: "999px", background: "var(--surface-card)", border: "0.08em solid var(--surface-line)", minWidth: "60%", textAlign: "center" }}>{searchPlaceholder(searchEngine)}</span>
          <span style={{ fontSize: "0.85em" }}>{home.trim() ? "Home opens here" : "Home is a blank page"}</span>
        </div>
      </div>
      <div className="flex items-center" style={{ gap: "0.8em", marginTop: "0.8em" }}><DrawnChip /><PreviewNote>The address bar and the search box follow the two settings.</PreviewNote></div>
    </Scaled>
  );
}
