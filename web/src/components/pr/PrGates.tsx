import type { ReactNode } from "react";
import { type Gate, type GateTab } from "../../lib/prGates.ts";
import { ICON } from "../../lib/iconSize.ts";
import { CircleIcon, CrossIcon, DoneIcon, WarningIcon } from "../../lib/glyphIcons.tsx";

/** The glyph a tone wears: colour is never the only carrier. */
export function ToneGlyph({ tone, size = ICON.xs }: { tone: Gate["tone"]; size?: number }): ReactNode {
  if (tone === "ok") return <DoneIcon size={size} />;
  if (tone === "bad") return <CrossIcon size={size} />;
  if (tone === "warn") return <WarningIcon size={size} />;
  return <CircleIcon size={size} />;
}

/**
 * The four gates under the title: Checks, Reviews, Conflicts, Branch. Each is
 * a shortcut to its tab; colour is a 2px top edge and the glyph, nothing else.
 * 2x2 under BP_WIDE, 1x4 above (index.css `.prx-gates`).
 */
export function PrGates({ gates, onGo }: { gates: Gate[]; onGo: (tab: GateTab) => void }) {
  return (
    <div className="prx-gates prx-g" role="group" aria-label="Merge gates">
      {gates.map((g) => (
        <button key={g.key} type="button" className="prx-gate" data-tone={g.tone} data-gate={g.key} onClick={() => onGo(g.tab)} aria-label={`${g.label}: ${g.value}. Open ${g.tab}`}>
          <span className="k"><ToneGlyph tone={g.tone} />{g.label}</span>
          <span className="v">{g.value}</span>
        </button>
      ))}
    </div>
  );
}
