/*
 * GO TO A WINDOW — every tmux window on the machine, the ones waiting for you
 * first, one search away.
 *
 * Opened with its chord from anywhere in the app (App.tsx). Type to narrow by
 * window, folder or session; ↑↓ or Ctrl+N/P to move; Enter goes there, switching
 * tmux session if it has to; Alt+1–9 jump straight to a row; the chord again
 * moves to the next window waiting for you. Closing hands the keyboard back to
 * whatever had it — usually the pane the chord was pressed in.
 *
 * No open or close animation. This is used dozens of times an hour from the
 * keyboard, and a palette that fades in is a palette that is late.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { HIT, ICON } from "../../lib/iconSize.ts";
import { LAYER } from "../../lib/layers.ts";
import { appChordFor, chordFromEvent, chordLabel } from "../../lib/keybindings.ts";
import { nextWaiting, rankWindows, windowsFromPanes, type SwitcherRow } from "../../lib/windowSwitcher.ts";
import { STATUS_WORDS } from "../../../../shared/windowStatus.ts";
import { SearchIcon } from "../../lib/glyphIcons.tsx";
import { Portal } from "../Portal.tsx";
import { StatusMark, STATUS_COLOR } from "./StatusMark.tsx";

/** While open, the list is re-read this often: a status is a live thing, and
 *  a row that says "working" after its agent asked a question is the one lie
 *  this list cannot tell. */
const REFRESH_MS = 2000;

export function WindowSwitcher({ open, onClose, onGone }: {
  open: boolean;
  onClose: () => void;
  /** Called after a window was chosen, so the app can bring the terminal up. */
  onGone: () => void;
}) {
  const [rows, setRows] = useState<SwitcherRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  /*
   * The row under the cursor, held by WINDOW rather than by position. The list
   * is re-read and re-sorted by urgency every two seconds, so an index points
   * at whatever moved into that slot — a window above it going idle was enough
   * to put Enter on a different window, possibly in another session.
   */
  const [selId, setSelId] = useState<string | null>(null);
  /** Where the keyboard was when this opened, to give it back on close. */
  const returnTo = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) { setRows(null); setError(null); setQ(""); setSelId(null); return; }
    let dead = false;
    const load = () => api.agentPanes()
      .then((r) => {
        if (dead) return;
        if (!r.ok) { setError(r.reason ?? "tmux did not answer"); return; }
        setError(null);
        setRows(windowsFromPanes(r.panes ?? []));
      })
      .catch((e: unknown) => { if (!dead) setError(e instanceof Error ? e.message : String(e)); });
    void load();
    const t = setInterval(load, REFRESH_MS);
    return () => { dead = true; clearInterval(t); };
  }, [open]);

  // The field takes the caret by hand: `autoFocus` does not take when the
  // palette mounts while the terminal holds focus, which is the usual case.
  useEffect(() => {
    if (!open) return;
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      cancelAnimationFrame(raf);
      // Back to the pane (xterm's hidden textarea) the chord came from, if it
      // is still there — otherwise the next keys go to <body> and nowhere.
      const back = returnTo.current;
      returnTo.current = null;
      if (back?.isConnected) back.focus();
    };
  }, [open]);

  const ranked = useMemo(() => rankWindows(rows ?? [], q), [rows, q]);
  const sessions = useMemo(() => new Set((rows ?? []).map((r) => r.session)).size, [rows]);
  // The cursor's window, wherever the last re-sort put it; the top row when it
  // has none yet, or when its window has gone.
  const found = selId ? ranked.findIndex((r) => r.windowId === selId) : -1;
  const at = found >= 0 ? found : 0;
  const setSel = (i: number) => setSelId(ranked[i]?.windowId ?? null);

  useEffect(() => { setSelId(null); }, [q]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-row="${at}"]`)?.scrollIntoView({ block: "nearest" });
  }, [at]);

  const go = useCallback((r: SwitcherRow | undefined) => {
    if (!r) return;
    onClose();
    // The view comes up either way. If tmux refused — the window closed
    // between the list and the key — the terminal is still where you were
    // going, showing whatever tmux is actually on.
    void api.focusPane({ sessionId: r.sessionId, windowId: r.windowId, paneId: r.paneId })
      .catch(() => {})
      .finally(onGone);
  }, [onClose, onGone]);

  const onKey = (e: React.KeyboardEvent) => {
    // Every key in here is the switcher's: none should reach the app's
    // single-letter shortcuts, or the terminal under it.
    e.stopPropagation();
    const chord = chordFromEvent(e.nativeEvent);
    if (chord && chord === appChordFor("windows.switcher")) {
      e.preventDefault();
      const i = nextWaiting(ranked, at);
      if (i >= 0) setSel(i);
      return;
    }
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if (e.key === "Enter") { e.preventDefault(); go(ranked[at]); return; }
    if (e.key === "ArrowDown" || (ctrl && e.key.toLowerCase() === "n")) {
      e.preventDefault(); setSel(Math.min(ranked.length - 1, at + 1)); return;
    }
    if (e.key === "ArrowUp" || (ctrl && e.key.toLowerCase() === "p")) {
      e.preventDefault(); setSel(Math.max(0, at - 1)); return;
    }
    // With Alt, so a digit typed into the search is always part of it —
    // window names carry numbers, and "1042" has to be typeable from its
    // first key. `code` rather than `key`: Alt+digit types a symbol on some
    // layouts.
    const digit = /^Digit([1-9])$/.exec(e.code);
    if (e.altKey && !ctrl && digit) {
      const r = ranked[Number(digit[1]) - 1];
      if (r) { e.preventDefault(); go(r); }
    }
  };

  if (!open) return null;
  const chord = chordLabel(appChordFor("windows.switcher"));
  const waiting = ranked.filter((r) => r.status === "waiting").length;

  return (
    <Portal z={LAYER.palette}>
      <div className="fixed inset-0" style={{ zIndex: 1, background: "color-mix(in srgb, var(--bg) 55%, transparent)" }}
        onClick={onClose} />
      <div
        className="fixed inset-x-0 mx-auto flex flex-col overflow-hidden rounded-xl"
        style={{
          zIndex: 2, top: "12vh", width: "min(620px, calc(100vw - 32px))", maxHeight: "64vh",
          background: "var(--bg2)",
          border: "1px solid color-mix(in srgb, var(--primary) 40%, transparent)",
          boxShadow: "0 30px 70px -20px #000",
        }}
        onKeyDown={onKey}
        role="dialog" aria-modal="true" aria-label="Go to a window">
        <div className="px-2.5 py-2.5 shrink-0" style={{ borderBottom: "1px solid color-mix(in srgb, var(--text) 10%, transparent)" }}>
          <div className="flex items-center gap-2.5 px-2.5 py-2 rounded-md"
            style={{ background: "color-mix(in srgb, var(--bg3) 40%, transparent)", border: "1px solid color-mix(in srgb, var(--text) 14%, transparent)" }}>
            <span className="flex" style={{ color: "var(--primary)" }}><SearchIcon size={ICON.xs} /></span>
            <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)}
              spellCheck={false} autoComplete="off"
              placeholder="Go to a window — its name, folder or session"
              role="combobox" aria-expanded="true" aria-controls="agx-window-list"
              aria-activedescendant={ranked[at] ? `agx-win-${ranked[at]!.windowId}` : undefined}
              className="flex-1 min-w-0 bg-transparent outline-none text-[12.5px]" style={{ color: "var(--text)" }} />
            {waiting > 0 && (
              <span className="shrink-0 text-[10.5px] tabular-nums" style={{ color: STATUS_COLOR.waiting }}>
                {waiting} waiting
              </span>
            )}
          </div>
        </div>

        <div ref={listRef} id="agx-window-list" role="listbox" aria-label="Windows" className="overflow-y-auto agx-scroll py-1 min-h-0">
          {error ? (
            <div className="px-4 py-3 text-[12px]" style={{ color: "var(--text3)" }}>
              Could not list tmux windows: {error}
            </div>
          ) : rows === null ? (
            <div className="px-4 py-3 text-[12px]" style={{ color: "var(--text4)" }}>Reading tmux…</div>
          ) : ranked.length === 0 ? (
            <div className="px-4 py-3 text-[12px]" style={{ color: "var(--text3)" }}>
              {rows.length === 0 ? "No tmux windows yet. Open the terminal to start one." : `No window matches “${q}”.`}
            </div>
          ) : ranked.map((r, i) => {
            const lit = i === at;
            return (
              <div key={r.windowId} id={`agx-win-${r.windowId}`} data-row={i}
                role="option" aria-selected={lit}
                onMouseMove={() => { if (!lit) setSel(i); }}
                onClick={() => go(r)}
                className="flex items-center gap-2.5 px-3 mx-1 rounded-md cursor-pointer"
                style={{
                  minHeight: HIT + 4,
                  background: lit ? "color-mix(in srgb, var(--primary) 16%, transparent)" : "transparent",
                }}>
                <span className="shrink-0 w-4 text-center text-[10.5px] tabular-nums" style={{ color: "var(--text4)" }}>
                  {i < 9 ? i + 1 : ""}
                </span>
                <span className="shrink-0 w-3 flex justify-center">
                  {r.status && <StatusMark status={r.status} />}
                </span>
                <span className="min-w-0 truncate text-[12.5px]" style={{ color: lit ? "var(--text)" : "var(--text2)" }}>
                  {r.name || "shell"}
                </span>
                <span className="shrink-0 min-w-0 max-w-[30%] truncate text-[11px]" style={{ color: "var(--text4)" }} title={r.repo}>
                  {r.repo}
                </span>
                {sessions > 1 && (
                  <span className="shrink-0 text-[11px] truncate max-w-[20%]" style={{ color: "var(--text4)" }} title={`tmux session ${r.session}`}>
                    {r.session}:{r.index}
                  </span>
                )}
                <span className="ml-auto shrink-0 text-[11px]" style={{ color: r.status && r.status !== "idle" ? STATUS_COLOR[r.status] : "var(--text4)" }}>
                  {r.status ? STATUS_WORDS[r.status] : ""}
                </span>
              </div>
            );
          })}
        </div>

        <div className="shrink-0 flex flex-wrap gap-x-3 gap-y-0.5 px-3 py-1.5 text-[10.5px]"
          style={{ color: "var(--text4)", borderTop: "1px solid color-mix(in srgb, var(--text) 10%, transparent)" }}>
          <span>↑↓ choose</span><span>⏎ go</span><span>Alt+1–9 jump</span><span>{chord} next waiting</span><span>esc close</span>
        </div>
      </div>
    </Portal>
  );
}
