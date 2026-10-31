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
 *  2. THE DESTRUCTIVE STEP is not here. A red item runs on the click and its
 *     handler asks once, in a GitDialog that shows the git command it is about
 *     to run and, where nothing brings the work back, says so. A menu that
 *     replaced itself with a second menu was a second question for the same
 *     answer.
 */
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
  const groups = grouped(actionsFor(kind, name, state));

  const run = (a: GitAction) => { onClose(); onAction(a.id); };

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
