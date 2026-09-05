/*
 * ⌘K over everything the git view can do.
 *
 * The third reader of lib/gitActions.ts, and the reason that file is data
 * rather than JSX: the hover button gives you one action without moving the
 * pointer, the right-click gives you all of a row's, and this gives you all of
 * the REPOSITORY'S without touching the pointer at all — "del super" finds
 * Delete on feat/git-super-tool from any section, including a section you are
 * not looking at.
 *
 * What it deliberately does not do is offer an action a row does not have. It
 * is built from the same `actionsFor` the menu is, per row, with that row's
 * state — so the branch you are standing on never appears with "Delete", and a
 * worktree you are inside never appears with "Remove". A palette that lists
 * everything and fails on Enter is worse than a shorter one.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Portal } from "./Portal.tsx";
import { LAYER } from "../lib/layers.ts";
import { matchPalette, paletteEntries, type GitKind, type GitRowState } from "../lib/gitActions.ts";

export interface PaletteRow {
  kind: GitKind;
  name: string;
  state?: GitRowState;
  /** What running one of this row's actions means. Supplied by the section
   *  that owns the object, the same closure the row's menu uses. */
  run: (id: string) => void;
}

export function GitPalette({ rows, onClose }: { rows: PaletteRow[]; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const entries = useMemo(() => paletteEntries(rows), [rows]);
  const hits = useMemo(() => matchPalette(entries, q).slice(0, 40), [entries, q]);
  // The cursor is an index into a list that changes under it as you type.
  // Clamping on render rather than on change is what keeps Enter honest when
  // the last keystroke shortened the list.
  const at = Math.min(cursor, Math.max(0, hits.length - 1));

  useEffect(() => { inputRef.current?.focus(); }, []);

  /*
   * A destructive action asks twice, here as well as in the menu.
   *
   * The right-click menu already required a confirm before anything
   * irreversible; the palette ran the same action on one Enter. That gap is
   * worse than it sounds, because the list REORDERS as you type — `setCursor(0)`
   * on every keystroke, and the pointer moving across the list sets the cursor
   * too — so "del" followed by Enter fires whatever landed in row 0, which may
   * be a delete on a branch you were not looking at.
   *
   * The second Enter is on the same row: the item turns into "Press again to
   * <label>", and any other key or a change to the query takes it back. Not a
   * dialog, because a palette is a keyboard surface and a modal over a modal is
   * how people learn to hit Enter twice without reading.
   */
  const [arming, setArming] = useState<string | null>(null);

  const runAt = (i: number) => {
    const hit = hits[i];
    if (!hit) return;
    const key = `${hit.kind}-${hit.name}-${hit.action.id}`;
    if (hit.action.danger && arming !== key) { setArming(key); return; }
    onClose();
    const row = rows.find((r) => r.kind === hit.kind && r.name === hit.name);
    row?.run(hit.action.id);
  };

  return (
    <Portal>
      {/* LAYER, not a number: 9999 is BELOW every numbered surface in this app
          (the file viewer is 10020, Settings 10120, a menu 10200), so the
          palette opened underneath anything the user raised next. */}
      <div className="fixed inset-0" style={{ zIndex: LAYER.palette - 1, background: "rgba(0,0,0,.45)" }} onMouseDown={onClose} />
      <div role="dialog" aria-label="Git actions"
        className="fixed left-1/2 rounded-xl overflow-hidden flex flex-col"
        style={{
          top: "14vh", transform: "translateX(-50%)", width: "min(560px, 92vw)", maxHeight: "62vh", zIndex: LAYER.palette,
          background: "color-mix(in srgb, var(--bg2) 97%, black)",
          border: "1px solid color-mix(in srgb, var(--primary) 40%, transparent)",
          boxShadow: "0 30px 70px -20px rgba(0,0,0,.8)",
        }}
        onKeyDown={(e) => {
          // Anything that is not the confirming Enter disarms: an armed row must
          // not survive a change of mind.
          if (e.key !== "Enter") setArming(null);
          if (e.key === "Escape") { e.stopPropagation(); onClose(); }
          else if (e.key === "ArrowDown") { e.preventDefault(); setCursor(Math.min(at + 1, hits.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setCursor(Math.max(at - 1, 0)); }
          else if (e.key === "Enter") { e.preventDefault(); runAt(at); }
        }}>
        <input ref={inputRef} value={q} onChange={(e) => { setQ(e.target.value); setCursor(0); setArming(null); }}
          placeholder="branch, tag, stash, worktree — or what you want to do to one"
          className="px-3 py-2.5 text-[12px] outline-none"
          style={{
            background: "transparent", color: "var(--text)",
            borderBottom: "1px solid color-mix(in srgb, var(--text) 14%, transparent)",
            fontFamily: "var(--font-mono, ui-monospace, monospace)",
          }} />
        <div className="agx-scroll overflow-y-auto overflow-x-hidden py-1">
          {!hits.length && (
            <div className="px-3 py-3 text-[11px]" style={{ color: "var(--text3)" }}>
              Nothing matches. Every word has to appear somewhere — try fewer.
            </div>
          )}
          {hits.map((h, i) => (
            <button key={`${h.kind}-${h.name}-${h.action.id}`}
              onMouseEnter={() => { setCursor(i); setArming(null); }} onClick={() => runAt(i)}
              className="w-full text-left px-3 py-1.5 flex items-center gap-2"
              style={{ background: i === at ? "color-mix(in srgb, var(--primary) 14%, transparent)" : "transparent" }}>
              <span className="text-[9px] uppercase tracking-wider shrink-0 w-16" style={{ color: "var(--text3)" }}>{h.kind}</span>
              <span className="text-[11.5px] shrink-0" style={{ color: h.action.danger ? "var(--error)" : "var(--text)" }}>
                {arming === `${h.kind}-${h.name}-${h.action.id}` ? `Press again to ${h.action.label.toLowerCase()}` : h.action.label}
              </span>
              <span className="text-[11px] min-w-0 truncate" style={{ color: "var(--text2)", fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>{h.name}</span>
              {h.action.command && i === at && (
                <span className="ml-auto text-[9.5px] shrink-0 truncate max-w-[45%]"
                  style={{ color: "var(--text3)", fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>{h.action.command}</span>
              )}
            </button>
          ))}
        </div>
        <div className="px-3 py-1.5 text-[9.5px] flex gap-3"
          style={{ color: "var(--text3)", borderTop: "1px solid color-mix(in srgb, var(--text) 12%, transparent)" }}>
          <span>↑↓ move</span><span>↵ run</span><span>esc close</span>
          <span className="ml-auto">{hits.length} of {entries.length}</span>
        </div>
      </div>
    </Portal>
  );
}
