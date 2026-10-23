// Folder peeking: a small card of what is inside the folder under the pointer,
// in Icons and List (Strata's switch of the same name; the numbers and the
// placement are lib/finderPeek). It is a tooltip, so the pointer never lands on
// it and it never takes focus: leaving the row, a key, a click or a scroll
// closes it.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../../../lib/api.ts";
import { PEEK, peekOf, peekPlace, type Peek } from "../../../lib/finderPeek.ts";
import { ICON } from "../../../lib/iconSize.ts";
import { LAYER } from "../../../lib/layers.ts";
import { Portal } from "../../Portal.tsx";
import { EDGE, LINE } from "../../workspace/Chrome.tsx";
import { FileTypeIcon, StrataIcon } from "./StrataIcon.tsx";

interface Open { path: string; name: string; box: { left: number; right: number; top: number; bottom: number } }

/** What a row spreads onto itself: bind(path, name) gives its two pointer handlers. */
export interface PeekBinder { bind: (path: string, name: string) => { onMouseEnter: (e: React.MouseEvent<HTMLElement>) => void; onMouseLeave: () => void } }

export function useFolderPeek(enabled: boolean, hidden: boolean): { peek: PeekBinder | null; node: ReactNode } {
  const [open, setOpen] = useState<Open | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  const close = useCallback(() => { clear(); setOpen(null); }, []);
  useEffect(() => {
    if (!enabled) { close(); return; }
    const on = () => close();
    window.addEventListener("keydown", on, true); window.addEventListener("mousedown", on, true); window.addEventListener("scroll", on, true); window.addEventListener("blur", on);
    return () => { window.removeEventListener("keydown", on, true); window.removeEventListener("mousedown", on, true); window.removeEventListener("scroll", on, true); window.removeEventListener("blur", on); clear(); };
  }, [enabled, close]);
  const bind = useCallback((path: string, name: string) => ({
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      const el = e.currentTarget;
      clear();
      timer.current = setTimeout(() => { if (el.isConnected) { const r = el.getBoundingClientRect(); setOpen({ path, name, box: { left: r.left, right: r.right, top: r.top, bottom: r.bottom } }); } }, PEEK.open);
    },
    onMouseLeave: () => { clear(); timer.current = setTimeout(() => setOpen(null), PEEK.close); },
  }), []);
  return { peek: enabled ? { bind } : null, node: enabled && open ? <PeekCard key={open.path} at={open} hidden={hidden} /> : null };
}

function PeekCard({ at, hidden }: { at: Open; hidden: boolean }) {
  const [peek, setPeek] = useState<Peek | null>(null);
  const el = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    const ctl = new AbortController();
    api.browseList(at.path, 0, hidden, ctl.signal).then((r) => { if (r.ok) setPeek(peekOf(at.name, r.entries, r.next === null ? 0 : Math.max(0, r.total - r.entries.length))); }).catch(() => { /* a folder that cannot be read shows no card */ });
    return () => ctl.abort();
  }, [at.path, at.name, hidden]);
  useLayoutEffect(() => {
    if (!peek || !el.current) return;
    setPos(peekPlace(at.box, { w: PEEK.width, h: el.current.offsetHeight }, { w: window.innerWidth, h: window.innerHeight }));
  }, [peek, at.box]);
  if (!peek) return null;
  return (
    <Portal z={LAYER.menu}>
      <div ref={el} role="tooltip" data-finder-menu aria-label="Folder peek" className="fixed rounded-lg text-[12px] shadow-2xl pointer-events-none overflow-hidden"
        style={{ width: PEEK.width, left: pos?.left ?? -9999, top: pos?.top ?? -9999, background: "var(--surface-card)", border: EDGE, color: "var(--text)", transition: "opacity 150ms", opacity: pos ? 1 : 0 }}>
        <div className="flex items-center gap-2 px-3 truncate" style={{ minHeight: 30, borderBottom: LINE, color: "var(--text3)", fontWeight: 600 }}>
          <span className="truncate flex-1">{at.name}</span><span className="tabular-nums text-[11px] shrink-0">{peek.count}</span>
        </div>
        {peek.empty ? <div className="px-3 py-3" style={{ color: "var(--text3)" }}>Empty folder</div> : (
          <ul className="m-0 p-1 list-none">
            {peek.rows.map((r) => (
              <li key={r.name} className="flex items-center gap-2 px-2 rounded-md" style={{ minHeight: 26, color: r.locked ? "var(--text4)" : "var(--text)" }}>
                <FileTypeIcon name={r.name} isDir={r.isDir} size={ICON.sm} /><span className="truncate flex-1">{r.name}</span>
                {r.isDir && <StrataIcon set="act" name="chevron-right" size={ICON.sm} className="opacity-60" />}
              </li>
            ))}
            {peek.more > 0 && <li className="px-2 text-[11px]" style={{ minHeight: 24, color: "var(--text3)" }}>+{peek.more} more</li>}
          </ul>
        )}
      </div>
    </Portal>
  );
}
