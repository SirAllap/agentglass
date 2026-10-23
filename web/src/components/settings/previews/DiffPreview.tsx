import { useEffect, useMemo } from "react";
import { SplitDiff, UnifiedDiff } from "../../diff/DiffLines.tsx";
import { HiliteCtx, useDiffHighlight } from "../../../lib/diffHighlight.ts";
import type { DiffHunk } from "../../../../../shared/types.ts";
import { PreviewBox, PreviewNote } from "./Frame.tsx";

export interface DiffPreviewProps {
  split: boolean;
  wrap: boolean;
  /** The page's syntax-theme choice ("auto" or a theme id); left out, the saved one read at mount. */
  syntaxTheme?: string;
}

/** A hunk with one long line, so Wrap shows what it does. Invented code. */
const HUNKS: DiffHunk[] = [{
  oldStart: 12, oldLines: 8, newStart: 12, newLines: 10,
  lines: [
    " function reconnect(socket) {",
    "-  const wait = 500;",
    "+  const wait = backoff(attempt);",
    "   if (!socket.open) {",
    "+    log.warn(\"retrying in \" + wait + \" ms, attempt \" + attempt + \" of \" + MAX_ATTEMPTS + \" on \" + socket.url);",
    "     return schedule(wait);",
    "   }",
    " }",
    "-export const MAX_WAIT = 30_000;",
    "+export const MAX_WAIT = 30_000; // ms, capped",
    "+export const JITTER = 0.2;",
  ],
}];

/** The real diff renderer on a small invented diff: Split or Inline, Wrap or scroll. */
export function DiffPreview({ split, wrap, syntaxTheme }: DiffPreviewProps) {
  // The hook reads the saved syntax theme once, at mount; the page's control moves after that.
  const { hilite, setThemePref } = useDiffHighlight("src/net/reconnect.ts");
  useEffect(() => { if (syntaxTheme) setThemePref(syntaxTheme); }, [syntaxTheme, setThemePref]);
  const hunks = useMemo(() => HUNKS, []);
  return (
    <PreviewBox label="A diff, split or inline">
      <div data-preview="diff" className="rounded-lg overflow-hidden min-w-0" style={{ background: "var(--bg)", borderWidth: 1, borderStyle: "solid", borderColor: "var(--surface-line)" }}>
        <div className="px-3 py-1.5 text-[11px]" style={{ color: "var(--text3)", background: "var(--surface-nav)" }}>src/net/reconnect.ts</div>
        <HiliteCtx.Provider value={hilite}>
          {split ? <SplitDiff hunks={hunks} wrap={wrap} /> : <UnifiedDiff hunks={hunks} wrap={wrap} />}
        </HiliteCtx.Provider>
      </div>
      <PreviewNote>The app's own diff view on an invented change.</PreviewNote>
    </PreviewBox>
  );
}
