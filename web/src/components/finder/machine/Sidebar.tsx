// The places down the left: Home and the folders every desktop has, the
// shelves that come with later phases, and what is not there yet said once.
//
// A row that cannot be opened is drawn as one that cannot, with the reason on
// hover — a button that does nothing is a worse thing to ship than a label
// that says so.
import { StrataIcon, StyledIcon } from "./StrataIcon.tsx";
import { useItemStyle } from "../../../lib/finderStyleStore.ts";
import { SIDE_DEFAULT } from "../../../lib/finderColumns.ts";
import { ICON } from "../../../lib/iconSize.ts";
import { joinPath, RECENT, type SidebarMode } from "../../../lib/finderMiller.ts";
import type { DiskPlace, PinnedPlace, Volume } from "../../../../../shared/types.ts";
import { useState } from "react";
import { activates } from "../../../lib/finderPointer.ts";
import { Popover, MenuItem } from "./Popover.tsx";
import { deviceIcon, lockButton, releaseButton, type LockButton, type ReleaseButton } from "../../../lib/finderVolumes.ts";
import { LINE } from "../../workspace/Chrome.tsx";
import { sideMenu, visiblePlaces, type SideAct, type SideTarget } from "../../../lib/finderSidebarMenu.ts";

/** Strata's default order: home, trash, network, recent, desktop, documents, downloads, music, pictures, videos. */
const XDG = ["Desktop", "Documents", "Downloads", "Music", "Pictures", "Videos"] as const;

/** Strata's own drawing for each place. */
export const PLACE_ICON: Record<string, string> = { home: "house", trash: "trash", network: "network", recent: "clock", Documents: "file-text", Downloads: "download", Music: "music-2", Pictures: "image", Videos: "video" };

export interface Place { id: string; label: string; path?: string; off?: string }

/** The sidebar's places for this machine. `known` is the folders the server says exist; a folder that does not exist is not listed, as in Strata, and until the server answers nothing is dropped on a guess. */
export function placesFor(home: string, known: readonly DiskPlace[]): Place[] {
  const has = (p: string) => known.length === 0 || known.some((k) => k.path === p);
  return [
    { id: "home", label: "Home", path: home },
    { id: "trash", label: "Trash" },
    { id: "network", label: "Network" },
    { id: "recent", label: "Recent", path: RECENT },
    ...XDG.map((n): Place => ({ id: n, label: n, path: joinPath(home, n) })).filter((p) => has(p.path!)),
  ];
}

/** A pinned folder shows the name its bookmark was given, and the folder's own name only when it has none. */
export const pinLabel = (b: PinnedPlace): string => (b.label.trim() || (b.path ?? "").slice((b.path ?? "").lastIndexOf("/") + 1) || b.path || b.uri);

/** Strata pins only the bookmarks that are not already one of the places at the top: a folder listed twice is noise. */
export function pinnedOnly(pins: readonly PinnedPlace[], places: readonly Place[]): PinnedPlace[] {
  const shown = new Set(places.flatMap((p) => (p.path ? [p.path.replace(/\/+$/, "")] : [])));
  return pins.filter((b) => !b.path || !shown.has(b.path.replace(/\/+$/, "")));
}

/** What a button at the end of a DEVICES row asks for. */
export type VolumeAsk = LockButton["act"] | ReleaseButton["act"] | "mount";

/** A pinned folder wears the colour and icon its owner gave it in Customize…; the fixed places keep Strata's own drawings. */
function PlaceIcon({ p }: { p: Place }) {
  const own = useItemStyle(p.id.startsWith("pin:") ? p.path : undefined);
  if (own && p.path) return <StyledIcon style={own} name={p.path.slice(p.path.lastIndexOf("/") + 1)} isDir size={ICON.md} />;
  return <StrataIcon set="act" name={PLACE_ICON[p.id] ?? "folder"} size={ICON.md} />;
}

export function Sidebar({ places, pins, onRemote, here, mode, width, onResize, onGo, onRecent, onNetwork, onTrash, dnd, volumes = [], busy, onVolume, onVolumeAct, hidden = [], onSideAct }: {
  places: Place[]; pins: readonly PinnedPlace[]; onRemote?: (uri: string) => void; here: string; mode: Exclude<SidebarMode, "hidden">;
  /** The DEVICES section: drawn only when there is a volume, as in Strata. `busy` is the ids with an action under way. */
  volumes?: readonly Volume[]; busy?: ReadonlySet<string>; onVolume?: (v: Volume) => void; onVolumeAct?: (v: Volume, ask: VolumeAsk) => void;
  /** Pixels, from lib/finderColumns `sidebarWidth`: the rail's fixed width or what was dragged. */
  /** The place ids hidden with Unpin, and what a row's menu does. */
  hidden?: readonly string[]; onSideAct?: (act: SideAct, t: SideTarget) => void;
  width: number; onResize: (w: number) => void;
  onGo: (path: string) => void; onRecent: () => void; onTrash: () => void; onNetwork?: () => void;
  /** The finder's drag handlers: a place with data-drop-path takes what is dropped on it, and Trash takes it to the trash. */
  dnd?: React.HTMLAttributes<HTMLElement>;
}) {
  const rail = mode === "rail";
  const shownPins = pinnedOnly(pins, places);
  const [menu, setMenu] = useState<{ t: SideTarget; at: DOMRect } | null>(null);
  /** The row's own menu: the right button opens it at the pointer, the Menu key and Shift+F10 at the row. A row with nothing to offer opens none, and the browser's menu never shows. */
  const menuOf = (t: SideTarget) => ({
    onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); if (sideMenu(t).length) setMenu({ t, at: new DOMRect(e.clientX, e.clientY, 1, 1) }); },
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
      if (e.key !== "ContextMenu" && !(e.key === "F10" && e.shiftKey)) return;
      e.preventDefault(); e.stopPropagation();
      const r = e.currentTarget.getBoundingClientRect();
      if (sideMenu(t).length) setMenu({ t, at: new DOMRect(r.left + 24, r.bottom - 4, 1, 1) });
    },
  });
  const row = (p: Place, pin?: PinnedPlace) => {
    const on = !!p.path && (here === p.path);
    const off = !!p.off;
    return (
      <button key={p.id} data-side-row data-drop-path={p.path && !off && p.id !== "recent" && p.id !== "trash" ? p.path : undefined} data-drop-trash={p.id === "trash" ? "" : undefined} disabled={off} aria-current={on ? "true" : undefined} aria-label={rail ? p.label : undefined} title={p.off ?? (rail ? p.label : undefined)}
        {...menuOf(pin ? { kind: "pin", uri: pin.uri, path: pin.path } : { kind: "place", id: p.id, path: p.id === "trash" || p.id === "network" ? undefined : p.path })}
        onClick={(e) => activates(e.button, "click") && (p.id === "recent" ? onRecent() : p.id === "trash" ? onTrash() : p.id === "network" ? onNetwork?.() : p.path && onGo(p.path))}
        className={`agx-btn w-full flex items-center ${rail ? "justify-center" : "gap-2 px-2.5"} rounded-md text-left disabled:cursor-not-allowed`}
        style={{ minHeight: rail ? 28 : 26, color: off ? "var(--text4)" : on ? "var(--text)" : "var(--text2)", fontWeight: on ? 600 : 400, background: on ? "color-mix(in srgb, var(--primary) 18%, transparent)" : undefined }}>
        <span className="shrink-0 flex" style={{ color: "var(--primary-ink)" }}><PlaceIcon p={p} /></span>
        {!rail && <span className="truncate">{p.label}</span>}
      </button>
    );
  };
  /** A pinned remote (sftp, smb): it has no folder here until it is connected, so the row asks the address flow to open it. */
  const remote = (b: PinnedPlace) => (
    <button key={`pin:${b.uri}`} type="button" data-side-row aria-label={rail ? b.label : undefined} title={b.uri} onClick={(e) => { if (activates(e.button, "click")) onRemote?.(b.uri); }} {...menuOf({ kind: "pin", uri: b.uri })}
      className={`agx-btn w-full flex items-center ${rail ? "justify-center" : "gap-2 px-2.5"} rounded-md text-left`} style={{ minHeight: rail ? 28 : 26, color: "var(--text2)" }}>
      <span className="shrink-0 flex" style={{ color: "var(--primary-ink)" }}><StrataIcon set="act" name="folder" size={ICON.md} /></span>
      {!rail && <span className="truncate">{b.label}</span>}
    </button>
  );
  /** One device: the row opens it, the two 24-px buttons at the end lock and eject (hidden on the rail, where the name is the tooltip). */
  const device = (v: Volume) => {
    const on = !!v.mountPoint && (here === v.mountPoint || here.startsWith(v.mountPoint + "/"));
    const lock = lockButton(v), eject = releaseButton(v), working = busy?.has(v.id);
    const act = (b: LockButton | ReleaseButton) => (
      <button key={b.label} type="button" title={b.label} aria-label={`${b.label} ${v.name}`} disabled={working} onClick={(e) => { if (activates(e.button, "click")) onVolumeAct?.(v, b.act); }}
        className="agx-btn flex items-center justify-center rounded-md shrink-0" style={{ width: 24, height: 24, opacity: 0.75 }}>
        <StrataIcon set="act" name={b.icon} size={ICON.sm} />
      </button>
    );
    return (
      <div key={v.id} data-device={v.id} className="flex items-center rounded-md" style={{ background: on ? "color-mix(in srgb, var(--primary) 18%, transparent)" : undefined, paddingRight: rail ? 0 : 2 }}>
        <button type="button" data-side-row aria-current={on ? "true" : undefined} aria-label={rail ? v.name : undefined} title={rail ? v.name : v.mountPoint ?? undefined} aria-busy={working || undefined} onClick={(e) => { if (activates(e.button, "click")) onVolume?.(v); }}
          {...menuOf({ kind: "device", volume: v })}
          className={`agx-btn flex-1 min-w-0 flex items-center ${rail ? "justify-center" : "gap-2 px-2.5"} rounded-md text-left`}
          style={{ minHeight: rail ? 28 : 26, color: on ? "var(--text)" : "var(--text2)", fontWeight: on ? 600 : 400 }}>
          <span className="shrink-0 flex" style={{ color: "var(--primary-ink)" }}><StrataIcon set="act" name={deviceIcon(v)} size={ICON.md} /></span>
          {!rail && <span className="truncate">{v.name}</span>}
        </button>
        {!rail && lock && act(lock)}
        {!rail && eject && act(eject)}
      </div>
    );
  };
  return (
    <div className="relative shrink-0 flex min-h-0" style={{ width }}>
      <nav aria-label="Places" data-finder-sidebar data-mode={mode} {...dnd} className="agx-scroll overflow-y-auto overflow-x-hidden flex-1 min-w-0 py-1.5 px-1 text-[12px] flex flex-col gap-0.5"
        style={{ borderRight: LINE, background: "var(--surface-nav)" }}>
        {visiblePlaces(places, hidden).map((p) => row(p))}
        {shownPins.length > 0 && !rail && <div className="px-2.5 pt-2 pb-0.5 text-[10px] uppercase" style={{ color: "var(--text4)" }}>Pinned</div>}
        {shownPins.length > 0 && rail && <div role="separator" className="mx-1 my-1" style={{ borderTop: LINE }} />}
        {shownPins.map((b) => (b.path ? row({ id: `pin:${b.path}`, label: pinLabel(b), path: b.path }, b) : remote(b)))}
        {volumes.length > 0 && (
          <>
            <div role="separator" style={{ borderTop: LINE, margin: rail ? "6px 2px" : "6px 0" }} />
            {!rail && <div className="px-2.5" style={{ color: "var(--text4)", fontSize: "0.78em", fontWeight: 700, padding: "1px 10px 2px" }}>DEVICES</div>}
            {volumes.map(device)}
          </>
        )}
      </nav>
      {menu && (
        <Popover anchor={menu.at} onClose={() => setMenu(null)} width={190} label="Sidebar item">
          {sideMenu(menu.t).map((i) => (
            <MenuItem key={i.act} icon={i.icon} danger={i.danger} onClick={() => { const t = menu.t; setMenu(null); onSideAct?.(i.act, t); }}>{i.label}</MenuItem>
          ))}
        </Popover>
      )}
      {!rail && (
        <div role="separator" aria-orientation="vertical" aria-label="Resize the sidebar" aria-valuenow={Math.round(width)} tabIndex={0}
          title="Drag to resize, double-click to reset" className="absolute top-0 bottom-0 agx-col-edge" style={{ right: 0, width: 6, cursor: "col-resize", zIndex: 3, touchAction: "none" }}
          onDoubleClick={() => onResize(SIDE_DEFAULT)}
          onPointerDown={(e) => {
            if (!activates(e.button, "mousedown")) return;
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
