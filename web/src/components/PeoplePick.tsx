import { useLayoutEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { Portal } from "./Portal.tsx";
import { menuUnder, PICK_W, PICK_H } from "../lib/menuPos.ts";
import type { ListMember } from "../../../shared/providers.ts";

/*
 * The picker this app uses to put somebody on a card.
 *
 * There was one, in the card view, and it had already learned everything worth
 * knowing: 527 names on a real workspace, so a filter box rather than a scroll;
 * a Portal and a clamp, because a popover anchored inside content that scrolls
 * gets clipped by something eventually ("ilter people…", cut down the middle);
 * and it STAYS OPEN, because putting two people on and taking yourself off is
 * one thought rather than three trips through a list of five hundred.
 *
 * Then a second one appeared beside the pull request, drawn as a plain dropdown
 * of names — it ran off the bottom-right of the window and looked nothing like
 * the first. "That selection modal opens outside the window, and it does not
 * follow the standard, which should be this one." So this is that first one, lifted out, and both places
 * draw it.
 *
 * Presentational only: the caller says who is on, who is saving and what a
 * press means. The card view keeps its optimistic writes; the pull request
 * sends one write per press.
 */

export interface PeoplePickProps {
  /** The control this hangs under. Measured on open and clamped to the window. */
  anchor: RefObject<HTMLElement | null>;
  /** In the order they should be read — the caller decides who comes first. */
  members: ListMember[] | null;
  busy?: boolean;
  isOn: (m: ListMember) => boolean;
  isSaving?: (m: ListMember) => boolean;
  /** A rule between two groups — "everybody above works this board". */
  dividerBefore?: (m: ListMember, prev: ListMember) => boolean;
  onPick: (m: ListMember) => void;
  onClose: () => void;
  /** Drawn for each row: the app's own face, whichever component that is where
   *  this is used. */
  face: (m: ListMember) => ReactNode;
  /** Below this many names the filter box is noise. */
  filterOver?: number;
  empty?: string;
}

export function PeoplePick(p: PeoplePickProps) {
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [q, setQ] = useState("");
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = p.anchor.current;
    if (el) setPos(menuUnder(el.getBoundingClientRect(), window.innerWidth, window.innerHeight));
  }, [p.anchor]);

  const all = p.members ?? [];
  const shown = q.trim()
    ? all.filter((m) => m.name.toLowerCase().includes(q.trim().toLowerCase()))
    : all;

  return (
    <Portal>
      <div data-menu-layer className="fixed inset-0" style={{ zIndex: 9998 }} onClick={p.onClose} />
      <div ref={box} data-menu-layer data-people-pick
        className="agx-scroll fixed rounded-lg shadow-2xl flex flex-col overflow-y-auto py-1"
        style={{ ...pos, zIndex: 9999, background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--text) 28%, transparent)", width: PICK_W, maxHeight: PICK_H }}>
        {!p.busy && all.length > (p.filterOver ?? 12) && (
          <input value={q} onChange={(e) => setQ(e.target.value)} autoFocus
            placeholder="Filter people…" spellCheck={false}
            className="mx-1 mb-1 px-2 py-1 rounded text-[11px] outline-none shrink-0"
            style={{ background: "var(--bg3)", border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)", color: "var(--text)" }} />
        )}
        {p.busy && <div className="px-2.5 py-2 text-[10.5px]" style={{ color: "var(--text3)" }}>Reading the team…</div>}
        {!p.busy && all.length === 0 && (
          <div className="px-2.5 py-2 text-[10.5px]" style={{ color: "var(--text3)" }}>{p.empty ?? "Nobody is a member of this list."}</div>
        )}
        {!p.busy && shown.map((m, i) => {
          const on = p.isOn(m);
          const saving = p.isSaving?.(m) ?? false;
          const divide = i > 0 && !!p.dividerBefore?.(m, shown[i - 1]!);
          return (
            <div key={m.id}>
              {divide && <div className="my-1" style={{ borderTop: "1px solid color-mix(in srgb, var(--text) 14%, transparent)" }} />}
              <button className="w-full text-left px-2 py-1.5 hover:bg-white/5 flex items-center gap-2 disabled:opacity-70"
                disabled={saving} onClick={() => p.onPick(m)}>
                {p.face(m)}
                <span className="flex-1 min-w-0 truncate text-[11.5px]" title={m.name}
                  style={{ color: on ? "var(--success)" : "var(--text2)" }}>
                  {m.name}{m.me ? " · you" : ""}
                </span>
                {saving
                  ? <span className="agx-spin shrink-0" aria-label="Applying" style={{ width: 10, height: 10, borderWidth: 1.5, borderColor: "var(--text3)", borderTopColor: "transparent" }} />
                  : on ? <span className="text-[10px]" style={{ color: "var(--success)" }}>✓</span> : null}
              </button>
            </div>
          );
        })}
        {!p.busy && !shown.length && all.length > 0 && (
          <div className="px-2.5 py-2 text-[10.5px]" style={{ color: "var(--text3)" }}>Nobody matches that.</div>
        )}
      </div>
    </Portal>
  );
}
