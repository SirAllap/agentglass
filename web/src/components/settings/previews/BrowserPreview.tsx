import { DrawnChip, PreviewNote, Scaled } from "./Frame.tsx";
import { searchPlaceholder } from "./logic.ts";

export interface BrowserPreviewProps {
  /** Where the view opens; empty is a blank page. */
  home: string;
  /** Display name of the search engine. */
  searchEngine: string;
}

/** A new tab, drawn: the address bar shows the home page and the search box names the engine. Not a capture. */
export function BrowserPreview({ home, searchEngine }: BrowserPreviewProps) {
  const url = home.trim() || "about:blank";
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
