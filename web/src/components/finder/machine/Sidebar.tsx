// The places down the left: Home and the folders every desktop has, the
// shelves that come with later phases, and what is not there yet said once.
//
// A row that cannot be opened is drawn as one that cannot, with the reason on
// hover — Trash and Network belong to later phases and a button that does
// nothing is a worse thing to ship than a label that says so.
import { PlaceIcon } from "../../../lib/finderIcons.tsx";
import { SIDE_DEFAULT } from "../../../lib/finderColumns.ts";
import { ICON } from "../../../lib/iconSize.ts";
import { joinPath, type SidebarMode } from "../../../lib/finderMiller.ts";
import type { DiskPlace } from "../../../../../shared/types.ts";
import { LINE } from "../../workspace/Chrome.tsx";

/** Strata's default order: home, trash, network, recent, desktop, documents, downloads, music, pictures, videos. */
const XDG = ["Desktop", "Documents", "Downloads", "Music", "Pictures", "Videos"] as const;

export interface Place { id: string; label: string; path?: string; off?: string }

/** The sidebar's places for this machine. `known` is the folders the server says exist; a folder that does not exist is not listed, as in Strata, and until the server answers nothing is dropped on a guess. */
export function placesFor(home: string, known: readonly DiskPlace[]): Place[] {
  const has = (p: string) => known.length === 0 || known.some((k) => k.path === p);
  return [
    { id: "home", label: "Home", path: home },
    { id: "trash", label: "Trash", off: "Trash comes with file operations" },
    { id: "network", label: "Network", off: "Remote folders come in a later phase" },
    { id: "recent", label: "Recent" },
    ...XDG.map((n): Place => ({ id: n, label: n, path: joinPath(home, n) })).filter((p) => has(p.path!)),
  ];
}

export function Sidebar({ places, here, mode, width, onResize, onGo, onRecent }: {
  places: Place[]; here: string; mode: Exclude<SidebarMode, "hidden">;
  /** Pixels, from lib/finderColumns `sidebarWidth`: the rail's fixed width or what was dragged. */
  width: number; onResize: (w: number) => void;
  onGo: (path: string) => void; onRecent: () => void;
}) {
  const rail = mode === "rail";
  const row = (p: Place) => {
    const on = !!p.path && (here === p.path);
    const off = !!p.off;
    return (
      <button key={p.id} disabled={off} aria-current={on ? "true" : undefined} aria-label={rail ? p.label : undefined} title={p.off ?? (rail ? p.label : undefined)}
        onClick={() => (p.id === "recent" ? onRecent() : p.path && onGo(p.path))}
        className={`agx-btn w-full flex items-center ${rail ? "justify-center" : "gap-2 px-2.5"} rounded-md text-left disabled:cursor-not-allowed`}
        style={{ minHeight: rail ? 28 : 26, color: off ? "var(--text4)" : on ? "var(--text)" : "var(--text2)", fontWeight: on ? 600 : 400, background: on ? "color-mix(in srgb, var(--primary) 18%, transparent)" : undefined }}>
        <span className="shrink-0 flex" style={{ color: on ? "var(--primary-ink)" : undefined }}><PlaceIcon id={p.id} size={ICON.md} /></span>
        {!rail && <span className="truncate">{p.label}</span>}
      </button>
    );
  };
  return (
    <div className="relative shrink-0 flex min-h-0" style={{ width }}>
      <nav aria-label="Places" data-mode={mode} className="agx-scroll overflow-y-auto overflow-x-hidden flex-1 min-w-0 py-1.5 px-1 text-[12px] flex flex-col gap-0.5"
        style={{ borderRight: LINE, background: "var(--surface-nav)" }}>
        {places.map(row)}
      </nav>
      {!rail && (
        <div role="separator" aria-orientation="vertical" aria-label="Resize the sidebar" aria-valuenow={Math.round(width)} tabIndex={0}
          title="Drag to resize, double-click to reset" className="absolute top-0 bottom-0 agx-col-edge" style={{ right: 0, width: 6, cursor: "col-resize", zIndex: 3, touchAction: "none" }}
          onDoubleClick={() => onResize(SIDE_DEFAULT)}
          onPointerDown={(e) => {
            e.preventDefault();
            const x0 = e.clientX, w0 = width, el = e.currentTarget;
            el.setPointerCapture(e.pointerId);
            const move = (ev: PointerEvent) => onResize(w0 + ev.clientX - x0);
            const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", up); };
            el.addEventListener("pointermove", move); el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); onResize(width + (e.key === "ArrowLeft" ? -16 : 16)); }
            else if (e.key === "Enter" || e.key === "0") { e.preventDefault(); e.stopPropagation(); onResize(SIDE_DEFAULT); }
          }} />
      )}
    </div>
  );
}
