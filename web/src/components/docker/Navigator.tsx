/*
 * The slim section list. One count per section, and on Containers the number
 * that need you comes first in amber ("2 · 14"), so the badge answers the
 * question before the list is opened. The keys footnote is the only help text.
 */
import type { ReactNode } from "react";
import type { NavCounts } from "../../lib/dockerView.ts";
import { CubeIcon, CylinderIcon, DriveIcon, NodesIcon, PictureIcon } from "./DockerIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";

export type View = "containers" | "images" | "volumes" | "networks" | "disk";

const SECTIONS: { id: View; label: string; icon: ReactNode }[] = [
  { id: "containers", label: "Containers", icon: <CubeIcon size={ICON.md} /> },
  { id: "images", label: "Images", icon: <PictureIcon size={ICON.md} /> },
  { id: "volumes", label: "Volumes", icon: <CylinderIcon size={ICON.md} /> },
  { id: "networks", label: "Networks", icon: <NodesIcon size={ICON.md} /> },
  { id: "disk", label: "Disk", icon: <DriveIcon size={ICON.md} /> },
];

const KEYS = ["j", "k", "r", "s", "Enter", "Esc"] as const;

export function Navigator({ section, counts, diskSize, scopeNote, onPick }: {
  section: View; counts: NavCounts | null; onPick: (v: View) => void;
  /** Disk's total, once measured ("148 GB"); the section shows nothing until then. */
  diskSize?: string | null;
  /** "Showing <project> and the worktrees it owns. N containers from other projects are hidden." */
  scopeNote?: string | null;
}) {
  const count = (id: View): ReactNode => {
    if (!counts) return id === "containers" ? "…" : null;
    if (id === "containers") {
      return counts.need ? <><span className="amb"><b>{counts.need}</b> · </span>{counts.containers}</> : counts.containers;
    }
    return id === "disk" ? diskSize ?? null : counts[id];
  };
  return (
    <nav className="dk-nav" aria-label="Docker sections">
      <div className="dk-nvh">Docker</div>
      {SECTIONS.map((s) => (
        <button key={s.id} type="button" className="dk-nv" data-tip={s.label} aria-current={section === s.id ? "page" : undefined} onClick={() => onPick(s.id)}>
          {s.icon}<span>{s.label}</span><span className="n">{count(s.id)}</span>
        </button>
      ))}
      {scopeNote && <div className="dk-note">{scopeNote}</div>}
      <div className="dk-sub">
        <span className="dk-fresh"><i className="dk-live" />Live</span><br />
        Changes arrive from Docker's event stream; nothing is asked on a timer.<br />
        <span data-tip="j / k move through containers · r restart · s start or stop · Enter opens · Esc goes back">
          Keys: {KEYS.map((k) => <span key={k}><kbd>{k}</kbd>{" "}</span>)}
        </span>
      </div>
    </nav>
  );
}
