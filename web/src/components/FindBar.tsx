/*
 * The find bar: one field, for whatever is on screen.
 *
 * Mounted at the shell, like the file palette and for the same reason — the
 * chord has to reach it from a board, a pull request or a settings page, and
 * what it searches is decided by the scope stack rather than by where it lives
 * (see findScope.ts).
 *
 * Deliberately small and deliberately in the corner. A find bar is a thing you
 * open, type into, and leave, and every pixel it takes is a pixel of the thing
 * you are searching. GitHub, VS Code and Chromium all put it top-right, out of
 * the way of the text that starts at the top-left.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { closeFind, findHidden, findState, runQuery, stepFind, subscribeFind, topScope } from "../lib/findScope.ts";
import { CloseButton } from "./CloseButton.tsx";
import { clear as clearHighlights } from "../lib/mdFind.ts";
import { SearchIcon } from "../lib/glyphIcons.tsx";
import { ICON } from "../lib/iconSize.ts";

export function FindBar() {
  const st = useSyncExternalStore(subscribeFind, findState, findState);
  const box = useRef<HTMLInputElement>(null);

  /* Focus and select on open: opening it again with a query already in it is
     how you search for the next thing, and it must not need a triple-click. */
  useEffect(() => {
    if (!st.open) return;
    const el = box.current;
    requestAnimationFrame(() => { el?.focus(); el?.select(); });
  }, [st.open]);

  /* Whatever takes this component away — a close, a reload of the shell, a
     view that unmounts it — takes the marks with it. The registry is global and
     outlives any one search, which is exactly how forty of them were left
     painted on a board with no bar in sight. */
  useEffect(() => () => clearHighlights(), []);

  // The window can be dragged or resized while the bar is up: follow it. Only a
  // changed rectangle sets state, so a still window costs a read per frame.
  const [, moved] = useState("");
  const anchor = topScope()?.closest<HTMLElement>("[data-find-anchor]") ?? null;
  useEffect(() => {
    if (!anchor) return;
    let raf = 0, last = "";
    const tick = () => {
      const b = anchor.getBoundingClientRect();
      const k = `${b.top}|${b.right}`;
      if (k !== last) { last = k; moved(k); }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [anchor]);
  // After every hook: returning before one changes how many run (React #310).
  if (!st.open || findHidden()) return null;
  const nothing = !!st.query && st.total === 0;
  // A floating window being searched gets the bar in its own corner, not the
  // app's: the bar belongs over what it searches.
  const scope = topScope();
  // `closest`, not the scope itself: a card opened inside the bench is its
  // own scope, and it still lives in the bench.
  const r = scope?.closest<HTMLElement>("[data-find-anchor]")?.getBoundingClientRect() ?? null;
  const at = r ? { top: r.top + 8, right: Math.max(12, window.innerWidth - r.right + 12) } : { top: 8, right: 12 };
  return (
    <div className="fixed z-[10050] flex items-center gap-1.5 rounded-lg px-2 py-1.5 agx-menu"
      style={{ ...at, boxShadow: "0 8px 24px rgba(0,0,0,0.35)" }}
      role="search" aria-label="Find on this screen">
      <span aria-hidden className="flex" style={{ color: "var(--text3)" }}><SearchIcon size={ICON.xs} /></span>
      <input ref={box} value={st.query} spellCheck={false} autoComplete="off"
        onChange={(e) => runQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeFind(); }
          else if (e.key === "Enter") { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); }
          // The bar owns its own arrows, or the list behind it moves instead.
          else if (e.key === "ArrowDown") { e.preventDefault(); stepFind(1); }
          else if (e.key === "ArrowUp") { e.preventDefault(); stepFind(-1); }
        }}
        placeholder={st.label ? `Find in the ${st.label}` : "Find on this screen"}
        aria-label="Find"
        className="bg-transparent outline-none text-[11.5px] min-w-[180px]"
        style={{ color: nothing ? "var(--error)" : "var(--text)", caretColor: "var(--primary)" }} />
      {/* The count, in the shape every find bar uses. `0/0` rather than blank
          while you type: an empty counter reads as "still thinking". */}
      <span className="tabular-nums text-[10px] shrink-0" style={{ color: nothing ? "var(--error)" : "var(--text4)" }}>
        {st.total ? `${st.at}/${st.total}` : st.query ? "0/0" : ""}
      </span>
      <FindArrow dir={-1} disabled={!st.total} onClick={() => stepFind(-1)} />
      <FindArrow dir={1} disabled={!st.total} onClick={() => stepFind(1)} />
      <CloseButton onClick={closeFind} title="Close (Esc)" className="rounded hover:bg-white/10 shrink-0"
        style={{ color: "var(--text3)" }} />
    </div>
  );
}

/** Exported because the terminal's own find wears the same face: it searches a
 *  canvas rather than the document, so it cannot share the logic, and there is
 *  no reason for it to look like a different feature. */
export function FindArrow({ dir, disabled, onClick }: { dir: 1 | -1; disabled: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} disabled={disabled}
      title={dir === 1 ? "Next (Enter)" : "Previous (Shift+Enter)"}
      aria-label={dir === 1 ? "Next match" : "Previous match"}
      className="inline-flex items-center justify-center rounded hover:bg-white/10 shrink-0"
      style={{ width: 20, height: 20, color: "var(--text3)", opacity: disabled ? 0.35 : 1 }}>
      <svg viewBox="0 0 16 16" width={12} height={12} fill="none" stroke="currentColor"
        strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d={dir === 1 ? "M4 6l4 4 4-4" : "M4 10l4-4 4 4"} />
      </svg>
    </button>
  );
}
