/*
 * The project you are in, at the left of the strip.
 *
 * A project is a space: the strip below shows this one's windows, and every
 * other project is one click away in the Go list this opens. Folder, name, how
 * many windows, a caret that says it opens, and a padlock when the tmux
 * session is locked against being ended. Right-click is the project's menu.
 */
import { forwardRef } from "react";
import { CaretIcon, FolderIcon, LockIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { CTRL_H, EDGE } from "../workspace/Chrome.tsx";

export const ProjectChip = forwardRef<HTMLButtonElement, {
  name: string;
  count: number;
  locked: boolean;
  open: boolean;
  /** Spelled for a title: "Ctrl+Alt+J". */
  chord: string;
  onClick: () => void;
  onMenu?: (x: number, y: number) => void;
}>(function ProjectChip({ name, count, locked, open, chord, onClick, onMenu }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      onContextMenu={onMenu ? (e) => { e.preventDefault(); onMenu(e.clientX, e.clientY); } : undefined}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={`${name}, ${count} ${count === 1 ? "window" : "windows"}. Projects and windows`}
      title={`Projects and windows  ${chord}`}
      className="shrink-0 min-w-0 max-w-[40%] inline-flex items-center gap-1.5 px-2 rounded-lg text-[11px] font-semibold whitespace-nowrap transition-colors hover:brightness-125"
      style={{ height: CTRL_H.strip, color: "var(--text)", background: "var(--surface-inset)", border: EDGE }}>
      <span className="flex shrink-0" style={{ color: "var(--text3)" }}><FolderIcon size={ICON.xs} /></span>
      <span className="min-w-0 truncate">{name}</span>
      <span className="shrink-0 text-[10px] font-normal tabular-nums" style={{ color: "var(--text3)" }}>{count}</span>
      <span className="flex shrink-0" style={{ color: "var(--text3)" }}><CaretIcon size={ICON.xs} /></span>
      {locked && <span className="flex shrink-0" style={{ color: "var(--warning)" }} title="This session is locked: it cannot be ended"><LockIcon size={ICON.xs} /></span>}
    </button>
  );
});
