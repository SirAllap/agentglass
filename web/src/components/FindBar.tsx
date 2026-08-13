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
import { useEffect, useRef, useSyncExternalStore } from "react";
import { closeFind, findState, runQuery, stepFind, subscribeFind } from "../lib/findScope.ts";
import { CloseButton } from "./CloseButton.tsx";

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

  if (!st.open) return null;

  const nothing = !!st.query && st.total === 0;
  return (
    <div className="fixed z-[10050] flex items-center gap-1.5 rounded-lg px-2 py-1.5 agx-menu"
      style={{ top: 8, right: 12, boxShadow: "0 8px 24px rgba(0,0,0,0.35)" }}
      role="search" aria-label="Find on this screen">
      <span aria-hidden className="text-[11px]" style={{ color: "var(--text3)" }}>⌕</span>
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
      <Arrow dir={-1} disabled={!st.total} />
      <Arrow dir={1} disabled={!st.total} />
      <CloseButton onClick={closeFind} title="Close (Esc)" className="rounded hover:bg-white/10 shrink-0"
        style={{ color: "var(--text3)" }} />
    </div>
  );
}

function Arrow({ dir, disabled }: { dir: 1 | -1; disabled: boolean }) {
  return (
    <button onClick={() => stepFind(dir)} disabled={disabled}
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
