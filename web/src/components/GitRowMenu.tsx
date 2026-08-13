/*
 * The git view's row menu.
 *
 * One component for branches, tags, stashes, worktrees, remotes, submodules and
 * commits, because the LIST of actions is data (lib/gitActions.ts) and only the
 * rendering is here. That is what keeps the right-click, the hover button and
 * the palette offering the same things: there is one list and three readers.
 *
 * Two rules the plain ContextMenu does not give you, and both are why this
 * wrapper exists rather than each section building its own items:
 *
 *  1. GROUPS. Where you go, what you compare, the remote, what you copy, and
 *     last and alone, what cannot be undone. A separator between each.
 *  2. The DESTRUCTIVE STEP. A red item does not run on the first click: it
 *     replaces the menu with the git command it is about to run and asks once.
 *     The command is shown because this app runs git for you and the honest
 *     version of that is letting you read it — and because "Delete locally" and
 *     "Delete on the remote too" are one word apart in a menu and a world apart
 *     in effect.
 */
import { useState } from "react";
import { ContextMenu, MenuItem } from "./ContextMenu.tsx";
import { actionsFor, grouped, type GitAction, type GitKind, type GitRowState } from "../lib/gitActions.ts";

export function GitRowMenu({ kind, name, state, x, y, onClose, onAction }: {
  kind: GitKind;
  name: string;
  state?: GitRowState;
  x: number;
  y: number;
  onClose: () => void;
  onAction: (id: string) => void;
}) {
  /** The destructive action waiting for its second click, if any. */
  const [confirming, setConfirming] = useState<GitAction | null>(null);
  const groups = grouped(actionsFor(kind, name, state));

  const run = (a: GitAction) => {
    // Ask once, and only for the ones that cannot be undone. Everything else
    // runs on the click, because a confirm on a harmless action teaches people
    // to click through confirms.
    if (a.danger && !confirming) { setConfirming(a); return; }
    onClose();
    onAction(a.id);
  };

  if (confirming) {
    return (
      <ContextMenu x={x} y={y} onClose={onClose}>
        <div className="px-2 pt-1 pb-1.5 text-[10px]" style={{ color: "var(--text3)" }}>
          {confirming.label} · <span style={{ color: "var(--text2)" }}>{name}</span>
        </div>
        {confirming.command && (
          <div className="px-2 py-1.5 mb-1 rounded-lg text-[10.5px] select-all"
            style={{
              fontFamily: "var(--font-mono, ui-monospace, monospace)",
              color: "var(--text)",
              background: "color-mix(in srgb, var(--error) 12%, transparent)",
              border: "1px solid color-mix(in srgb, var(--error) 34%, transparent)",
              wordBreak: "break-all",
            }}>
            {confirming.command}
          </div>
        )}
        <MenuItem danger onClick={() => { onClose(); onAction(confirming.id); }}>
          <Row label="Yes, run it" hint="↵" />
        </MenuItem>
        <MenuItem onClick={() => setConfirming(null)}>
          <Row label="Back" hint="esc" />
        </MenuItem>
      </ContextMenu>
    );
  }

  return (
    <ContextMenu x={x} y={y} onClose={onClose}>
      <div className="px-2 pt-0.5 pb-1 text-[9.5px] uppercase tracking-wider truncate"
        style={{ color: "var(--text3)", maxWidth: 260 }}>
        {kind} · <span style={{ color: "var(--text2)", textTransform: "none" }}>{name}</span>
      </div>
      {groups.map((g, i) => (
        <div key={g[0].group} className="flex flex-col gap-0.5">
          {i > 0 && <hr className="my-1 mx-1 border-0 border-t"
            style={{ borderColor: "color-mix(in srgb, var(--text) 14%, transparent)" }} />}
          {g.map((a) => (
            <MenuItem key={a.id} danger={a.danger} onClick={() => run(a)}>
              <Row label={a.label} hint={a.shortcut} />
            </MenuItem>
          ))}
        </div>
      ))}
    </ContextMenu>
  );
}

/** Label left, shortcut right. `MenuItem` gives us the button and the colour;
 *  the two-column line is ours. */
function Row({ label, hint }: { label: string; hint?: string }) {
  return (
    <span className="flex items-center gap-4">
      <span className="flex-1 min-w-0 truncate">{label}</span>
      {hint && <span className="text-[9.5px] shrink-0"
        style={{ color: "var(--text3)", fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>{hint}</span>}
    </span>
  );
}
