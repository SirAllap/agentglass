// The places down the left: Home and the folders every desktop has, the
// shelves that come with later phases, and what is not there yet said once.
//
// A row that cannot be opened is drawn as one that cannot, with the reason on
// hover — Trash and Network belong to later phases and a button that does
// nothing is a worse thing to ship than a label that says so.
import { ClockIcon, DiskIcon, FolderIcon, HomeIcon, LinkIcon, PinIcon, TagIcon } from "../../../lib/glyphIcons.tsx";
import { ICON } from "../../../lib/iconSize.ts";
import { joinPath } from "../../../lib/finderMiller.ts";
import type { DiskPlace } from "../../../../../shared/types.ts";
import { LINE } from "../../workspace/Chrome.tsx";

const XDG = ["Documents", "Downloads", "Music", "Pictures", "Videos"] as const;

export interface Place { id: string; label: string; path?: string; off?: string }

/** The sidebar's places for this machine. `known` is the folders the server says exist; empty until it answers, and then nothing is greyed on a guess. */
export function placesFor(home: string, known: readonly DiskPlace[]): Place[] {
  const has = (p: string) => known.length === 0 || known.some((k) => k.path === p);
  return [
    { id: "home", label: "Home", path: home },
    { id: "trash", label: "Trash", off: "Trash comes with file operations" },
    { id: "network", label: "Network", off: "Remote folders come in a later phase" },
    { id: "recent", label: "Recent" },
    ...XDG.map((n): Place => {
      const path = joinPath(home, n);
      return has(path) ? { id: n, label: n, path } : { id: n, label: n, off: `${n} does not exist on this machine` };
    }),
  ];
}

const ICONS: Record<string, (s: number) => JSX.Element> = {
  home: (s) => <HomeIcon size={s} />, trash: (s) => <TagIcon size={s} />, network: (s) => <LinkIcon size={s} />, recent: (s) => <ClockIcon size={s} />,
};

export function Sidebar({ places, here, onGo, onRecent }: { places: Place[]; here: string; onGo: (path: string) => void; onRecent: () => void }) {
  const row = (p: Place) => {
    const on = !!p.path && (here === p.path);
    const off = !!p.off;
    return (
      <button key={p.id} disabled={off} aria-current={on ? "true" : undefined} title={p.off}
        onClick={() => (p.id === "recent" ? onRecent() : p.path && onGo(p.path))}
        className="agx-btn w-full flex items-center gap-2.5 px-3 rounded-md text-left disabled:cursor-not-allowed"
        style={{ minHeight: 30, color: off ? "var(--text4)" : on ? "var(--text)" : "var(--text2)", fontWeight: on ? 600 : 400, background: on ? "color-mix(in srgb, var(--text) 10%, transparent)" : undefined }}>
        <span className="shrink-0 flex">{(ICONS[p.id] ?? ((s: number) => <FolderIcon size={s} />))(ICON.sm)}</span>
        <span className="truncate">{p.label}</span>
      </button>
    );
  };
  const cap = (t: string) => <div className="px-4 pt-3.5 pb-1 text-[9.5px] uppercase tracking-[0.14em]" style={{ color: "var(--text4)", fontWeight: 600 }}>{t}</div>;
  return (
    <nav aria-label="Places" className="agx-scroll overflow-y-auto shrink-0 py-1.5 px-1.5 text-[12px]" style={{ width: 188, borderRight: LINE, background: "var(--surface-nav)" }}>
      {places.map(row)}
      {cap("Pinned")}
      <div className="flex items-center gap-2 px-3 text-[11px]" style={{ minHeight: 30, color: "var(--text4)" }} title="Pinning folders comes with file operations">
        <PinIcon size={ICON.sm} /><span className="truncate">Nothing pinned yet</span>
      </div>
      {cap("Devices")}
      <div className="flex items-center gap-2 px-3 text-[11px]" style={{ minHeight: 30, color: "var(--text4)" }} title="Mounting and ejecting come in a later phase">
        <DiskIcon size={ICON.sm} /><span className="truncate">No devices yet</span>
      </div>
    </nav>
  );
}
