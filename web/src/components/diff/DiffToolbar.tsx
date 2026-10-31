/*
 * The six controls that sit above a diff, in one place.
 *
 * The Diff view and the commit modal each drew their own row of them, and the
 * rows drifted: the view had Ignore space, Wrap, Bold and a Split chip, the modal
 * had lowercase "split" and "wrap" toggles and neither of the others, so the same
 * diff offered a different set of controls depending on how you reached it. A
 * caller that cannot honour one (the modal has no whitespace folding) leaves its
 * prop out and the control is not drawn; it never draws a dead one.
 */

import type { ReactNode } from "react";
import { Chip, Segmented } from "../workspace/Chrome.tsx";
import { ThemePicker, DiffSettingsLink } from "./DiffControls.tsx";

const LAYOUTS = [
  { id: "unified" as const, label: "Unified", title: "One column, removed lines above added ones" },
  { id: "split" as const, label: "Split", title: "Side by side" },
];

export function DiffToolbar({ split, onSplit, wrap, onWrap, noWs, onNoWs, bold, onBold, themePref, onTheme, themeError, className = "", children }: {
  split: boolean; onSplit: (v: boolean) => void;
  wrap: boolean; onWrap: (v: boolean) => void;
  /** Left out where the caller cannot fold whitespace. */
  noWs?: boolean; onNoWs?: (v: boolean) => void;
  bold?: boolean; onBold?: (v: boolean) => void;
  themePref: string; onTheme: (v: string) => void; themeError?: string | null;
  className?: string;
  /** What the caller adds after the shared controls (file stepping, in the view). */
  children?: ReactNode;
}) {
  return (
    <div className={`flex items-center gap-1.5 min-w-0 ${className}`.trim()}>
      {onNoWs && (
        <Chip on={!!noWs} onClick={() => onNoWs(!noWs)}
          title={noWs
            ? "Ignoring whitespace in the diff below — a line that only changed its indentation is drawn as unchanged. The counts in the list are still git's own."
            : "Ignore whitespace — fold a line that only changed its indentation back into context"}>Ignore space</Chip>
      )}
      <Segmented value={split ? "split" : "unified"} options={LAYOUTS} onChange={(v) => onSplit(v === "split")} label="Diff layout" track />
      <Chip on={wrap} onClick={() => onWrap(!wrap)} title="Wrap long lines">Wrap</Chip>
      {onBold && <Chip on={!!bold} onClick={() => onBold(!bold)} title="Bold keywords, functions & types (Neovim-style)">Bold</Chip>}
      <ThemePicker value={themePref} onChange={onTheme} error={themeError} />
      <DiffSettingsLink />
      {children}
    </div>
  );
}
