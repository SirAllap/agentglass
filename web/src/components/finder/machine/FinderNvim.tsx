// The preview's Editing tab: nvim itself, running in the preview pane.
//
// It is the bench's own terminal (BenchTerm) on a bench slot reserved for this
// (FINDER_EDIT_SLOT), so the editor, the keys and the plugins are the person's
// own and there is no editor to keep up here. The slot is never a bench tab: the
// server leaves it out of the bench's list, and this component ends the editor (nvim quits itself, then its tmux
// session is killed by name) when it unmounts, which is what happens when Editing is left, another
// file is chosen or the Finder closes.
import { useEffect } from "react";
import { api } from "../../../lib/api.ts";
import { FINDER_EDIT_SLOT } from "../../../lib/finderEdit.ts";
import { BenchTerm } from "../../bench/BenchTerm.tsx";

export function FinderNvim({ root, path, onEnd }: { root: string; path: string; onEnd: () => void }) {
  useEffect(() => () => { void api.finderEditEnd(root); }, [root, path]);
  return (
    <div className="flex-1 min-h-0 min-w-0 relative" style={{ minHeight: 260 }} data-finder-nvim aria-label="nvim">
      <div className="absolute inset-0">
        <BenchTerm key={path} root={root} slot={FINDER_EDIT_SLOT} view={path} edit active onEnd={onEnd} />
      </div>
    </div>
  );
}
