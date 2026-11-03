import { Button } from "../workspace/Chrome.tsx";
import { useFurnitureClear } from "../../lib/useFurnitureClear.ts";
import { DockIcon } from "../GitDock.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { pickedLabel } from "../../lib/gitLogView.ts";
import { INSPECTOR_RULE, wash } from "./ui.tsx";
import { MONO } from "./HistoryFrames.tsx";

/**
 * The picked commits' bulk actions, between the list and the dock: one run, oldest first.
 * The dock under it keeps acting on the commit under the cursor.
 */
export function PickBar({ shas, branch, disabled, picking, onPick, onStage, onSquash, onClear }: {
  /** Oldest first. */
  shas: readonly string[];
  branch?: string;
  disabled?: boolean;
  picking?: boolean;
  onPick: () => void; onStage: () => void; onSquash: () => void; onClear: () => void;
}) {
  const n = shas.length;
  // The bench button floats over the bottom right, where Clear sits.
  const [bar, clear] = useFurnitureClear<HTMLDivElement>([n]);
  return (
    <div ref={bar} className="shrink-0 h-10 flex items-center gap-1.5 px-3 min-w-0 text-[12px]" data-pick-bar
      style={{ paddingRight: 12 + clear, borderTop: INSPECTOR_RULE, background: wash("--info", 6), color: "var(--text2)" }}>
      <span style={{ color: "var(--info)" }} className="shrink-0"><DockIcon name="pick" size={ICON.sm} /></span>
      <b className="shrink-0" style={{ color: "var(--text)" }}>{n} picked</b>
      <span className="min-w-0 truncate" title={shas.join(", ")} style={{ color: "var(--text3)" }}>
        <span style={{ fontFamily: MONO }}>{pickedLabel(shas)}</span> — in graph order
      </span>
      <span className="flex-1" />
      <Button tone="primary" onClick={onPick} disabled={disabled} pending={picking} className="shrink-0"
        title="Replay the picked commits onto this branch in one run — a conflict pauses the series, and Continue finishes it">
        <DockIcon name="pick" />Cherry-pick {n} onto
        <span className="px-1 rounded" style={{ fontFamily: MONO, border: "1px solid color-mix(in srgb, currentColor 35%, transparent)" }}>{branch ?? "this branch"}</span>
      </Button>
      <Button onClick={onStage} disabled={disabled} className="shrink-0"
        title="Cherry-pick without committing — the changes land staged, so you can review or amend them first">Stage only</Button>
      {n >= 2 && (
        <Button onClick={onSquash} disabled={disabled} className="shrink-0"
          title="Fold the picked commits into one, tree preserved. Must be a consecutive run ending at the tip of this branch.">Squash {n}</Button>
      )}
      <Button tone="quiet" onClick={onClear} className="shrink-0" title="Clear the selection"><DockIcon name="x" />Clear</Button>
    </div>
  );
}
