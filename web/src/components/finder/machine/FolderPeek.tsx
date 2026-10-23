// Folder peeking: a small card of what is inside the folder under the pointer,
// in Icons and List (Strata's switch of the same name; the numbers, the
// placement and the hover intent are lib/finderPeek). The pointer can leave the
// folder for the card and go on into it: a folder row inside a card opens the
// next card beside it, and a click on any row reveals it in the finder. The gap
// between a row and its card is crossed on the close delay, not on a zone.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../../../lib/api.ts";
import { joinPath } from "../../../lib/finderMiller.ts";
import { PEEK, peekKeep, peekOf, peekPlace, type Peek, type PeekZone } from "../../../lib/finderPeek.ts";
import type { HitTarget } from "../../../lib/finderSearch.ts";
import { ICON } from "../../../lib/iconSize.ts";
import { LAYER } from "../../../lib/layers.ts";
import { Portal } from "../../Portal.tsx";
import { EDGE, LINE } from "../../workspace/Chrome.tsx";
import { BarButton } from "./PreviewBar.tsx";
import { FileTypeIcon, StrataIcon } from "./StrataIcon.tsx";

interface Open { path: string; name: string; box: { left: number; right: number; top: number; bottom: number } }

/** What a row spreads onto itself: bind(path, name) gives its two pointer handlers. */
export interface PeekBinder { bind: (path: string, name: string) => { onMouseEnter: (e: React.MouseEvent<HTMLElement>) => void; onMouseLeave: () => void } }

const rect = (el: HTMLElement): Open["box"] => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
const zoneKey = (z: PeekZone) => (z.kind === "card" ? `card:${z.level}` : `row:${z.level}:${z.path}`);

/** `byPointer` says whether the last way the person moved was the pointer: Strata peeks only then, so a folder the keyboard just reached does not open a card under a resting mouse. */
export function useFolderPeek(enabled: boolean, hidden: boolean, onPick: (t: HitTarget) => void, byPointer: () => boolean = () => true, onBench?: (path: string, mode: "terminal") => void): { peek: PeekBinder | null; node: ReactNode } {
  const [stack, setStackNow] = useState<Open[]>([]);
  const stackRef = useRef<Open[]>([]);
  const setStack = useCallback((s: Open[]) => { stackRef.current = s; setStackNow(s); }, []);
  const over = useRef(new Map<string, PeekZone>());
  const opening = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settling = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => { if (opening.current) clearTimeout(opening.current); if (settling.current) clearTimeout(settling.current); opening.current = settling.current = null; };
  const close = useCallback(() => { clear(); over.current.clear(); setStack([]); }, [setStack]);
  /* When the pointer has left everything for the close delay, the cards nobody is on or heading into go. */
  const settle = useCallback(() => {
    if (settling.current) clearTimeout(settling.current);
    settling.current = setTimeout(() => {
      const s = stackRef.current, keep = peekKeep(s.map((o) => o.path), [...over.current.values()]);
      if (keep < s.length) setStack(s.slice(0, keep));
    }, PEEK.close);
  }, [setStack]);
  const enter = useCallback((z: PeekZone) => { over.current.set(zoneKey(z), z); }, []);
  const leave = useCallback((z: PeekZone) => { over.current.delete(zoneKey(z)); if (opening.current) { clearTimeout(opening.current); opening.current = null; } settle(); }, [settle]);
  /* Level 0 is a row of the view; level k is a row inside card k-1. A different folder's card replaces the ones at its level and deeper. */
  const openAt = useCallback((level: number, next: Open) => {
    if (opening.current) clearTimeout(opening.current);
    if (stackRef.current[level]?.path === next.path) { opening.current = null; return; }
    opening.current = setTimeout(() => { opening.current = null; setStack([...stackRef.current.slice(0, level), next]); }, PEEK.open);
  }, [setStack]);
  useEffect(() => {
    if (!enabled) { close(); return; }
    const on = (e: Event) => { if (e.type === "mousedown" && (e.target as Element | null)?.closest?.("[data-folder-peek]")) return; close(); };
    const evs = ["keydown", "mousedown", "scroll"] as const;
    for (const t of evs) window.addEventListener(t, on, true);
    window.addEventListener("blur", close);
    return () => { for (const t of evs) window.removeEventListener(t, on, true); window.removeEventListener("blur", close); clear(); };
  }, [enabled, close]);
  const bind = useCallback((path: string, name: string) => ({
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      const el = e.currentTarget;
      enter({ kind: "row", level: 0, path });
      if (!byPointer() || stackRef.current[0]?.path === path) return;
      if (opening.current) clearTimeout(opening.current);
      opening.current = setTimeout(() => { opening.current = null; if (el.isConnected) setStack([{ path, name, box: rect(el) }]); }, PEEK.open);
    },
    onMouseLeave: () => leave({ kind: "row", level: 0, path }),
  }), [enter, leave, setStack, byPointer]);
  const pick = useCallback((t: HitTarget) => { close(); onPick(t); }, [close, onPick]);
  const terminal = onBench && ((path: string) => { close(); onBench(path, "terminal"); });
  return {
    peek: enabled ? { bind } : null,
    node: enabled && stack.length ? stack.map((o, level) => <PeekCard key={o.path} at={o} level={level} hidden={hidden} enter={enter} leave={leave} openAt={openAt} pick={pick} onBench={terminal} />) : null,
  };
}

function PeekCard({ at, level, hidden, enter, leave, openAt, pick, onBench }: {
  at: Open; level: number; hidden: boolean; onBench?: (path: string) => void;
  enter: (z: PeekZone) => void; leave: (z: PeekZone) => void; openAt: (level: number, o: Open) => void; pick: (t: HitTarget) => void;
}) {
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
  const zone: PeekZone = { kind: "card", level };
  if (!peek) return null;
  return (
    <Portal z={LAYER.menu}>
      <div ref={el} role="menu" aria-label="Folder peek" data-finder-menu data-folder-peek className="fixed rounded-lg text-[12px] shadow-2xl overflow-hidden"
        onMouseEnter={() => enter(zone)} onMouseLeave={() => leave(zone)}
        style={{ width: PEEK.width, left: pos?.left ?? -9999, top: pos?.top ?? -9999, background: "var(--surface-card)", border: EDGE, color: "var(--text)", transition: "opacity 150ms", opacity: pos ? 1 : 0 }}>
        <div className="flex items-center gap-2 px-3 truncate" style={{ minHeight: 30, borderBottom: LINE, color: "var(--text3)", fontWeight: 600 }}>
          <span className="truncate flex-1">{at.name}</span><span className="tabular-nums text-[11px] shrink-0">{peek.count}</span>
          {onBench && <BarButton icon="terminal" label="Terminal here" onClick={() => onBench(at.path)} />}
        </div>
        {peek.empty ? <div className="px-3 py-3" style={{ color: "var(--text3)" }}>Empty folder</div> : (
          <ul className="m-0 p-1 list-none">
            {peek.rows.map((r) => {
              const path = joinPath(at.path, r.name);
              const row: PeekZone = { kind: "row", level: level + 1, path };
              return (
                <li key={r.name}>
                  <button role="menuitem" disabled={r.locked} className="agx-btn w-full flex items-center gap-2 px-2 rounded-md text-left" style={{ minHeight: 26, color: r.locked ? "var(--text4)" : "var(--text)" }}
                    onMouseEnter={(e) => { enter(row); if (r.isDir && !r.locked) openAt(level + 1, { path, name: r.name, box: rect(e.currentTarget) }); else leave({ kind: "row", level: level + 1, path: "" }); }}
                    onMouseLeave={() => leave(row)}
                    onClick={() => pick(r.isDir ? { kind: "open-folder", path } : { kind: "select", dir: at.path, name: r.name })}>
                    <FileTypeIcon name={r.name} isDir={r.isDir} size={ICON.sm} /><span className="truncate flex-1">{r.name}</span>
                    {r.isDir && <StrataIcon set="act" name="chevron-right" size={ICON.sm} className="opacity-60" />}
                  </button>
                </li>
              );
            })}
            {peek.more > 0 && <li className="px-2 text-[11px]" style={{ minHeight: 24, color: "var(--text3)" }}>+{peek.more} more</li>}
          </ul>
        )}
      </div>
    </Portal>
  );
}
