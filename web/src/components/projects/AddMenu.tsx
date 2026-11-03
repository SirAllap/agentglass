// "Add…": four routes with one line each. ↑↓ and Enter, or the number keys 1-4.
import { ADD_ROWS, type AddRowKey } from "../../lib/addRows.ts";
import { ICON } from "../../lib/iconSize.ts";
import { FolderIcon, PlusIcon } from "../../lib/glyphIcons.tsx";
import { RIcon } from "../remoteIcons.tsx";
import { EDGE } from "../workspace/Chrome.tsx";
import { Kbd, Tile, wash } from "./ui.tsx";

const ICONS: Record<AddRowKey, React.ReactNode> = {
  folder: <FolderIcon size={ICON.sm} />, github: <RIcon name="cloud" size={ICON.sm} />, clone: <RIcon name="clone" size={ICON.sm} />, new: <PlusIcon size={ICON.sm} />,
};

export function AddMenu({ index, setIndex, onPick }: { index: number; setIndex: (i: number) => void; onPick: (k: AddRowKey) => void }) {
  return (
    <div role="menu" aria-label="Add a project" className="absolute z-[5] rounded-xl p-1.5" style={{ left: 12, bottom: 56, width: 360, background: "var(--surface-card)", border: EDGE, boxShadow: "0 18px 40px -12px rgba(0,0,0,0.45)" }}>
      {ADD_ROWS.map((r, i) => (
        <button key={r.key} role="menuitem" onClick={() => onPick(r.key)} onMouseEnter={() => setIndex(i)}
          className="grid w-full items-center text-left rounded-lg p-2 border-0 cursor-pointer" style={{ gridTemplateColumns: "30px minmax(0,1fr) auto", gap: "0 10px", background: i === index ? wash("var(--text)", 7) : "transparent", color: "var(--text)" }}>
          <Tile hue={r.hue} size={30}>{ICONS[r.key]}</Tile>
          <span className="min-w-0"><b className="block text-[12.5px]">{r.title}</b><small className="block text-[11px]" style={{ color: "var(--text3)" }}>{r.sub}</small></span>
          <Kbd>{i + 1}</Kbd>
        </button>
      ))}
    </div>
  );
}
