// The appearance menu and the shortcut sheet: the two small surfaces that are
// about the finder itself rather than about a folder.
import { Fragment } from "react";
import { TEXT_MAX, TEXT_MIN, type Prefs } from "../../../lib/finderMiller.ts";
import { HIT } from "../../../lib/iconSize.ts";
import { EDGE } from "../../workspace/Chrome.tsx";
import { MenuCap, MenuItem, MenuRule, Popover } from "./Popover.tsx";

export function AppearanceMenu({ anchor, prefs, onPref, onClose }: { anchor: DOMRect; prefs: Prefs; onPref: (p: Partial<Prefs>) => void; onClose: () => void }) {
  return (
    <Popover anchor={anchor} onClose={onClose} width={260} label="Appearance">
      <MenuCap>View</MenuCap>
      <MenuItem on={prefs.view === "columns"} onClick={() => onPref({ view: "columns" })}>Columns</MenuItem>
      <MenuItem on={prefs.view === "icons"} onClick={() => onPref({ view: "icons" })}>Icons</MenuItem>
      <MenuItem on={prefs.view === "list"} onClick={() => onPref({ view: "list" })}>List</MenuItem>
      <MenuItem on={prefs.preview} hint="Space" onClick={() => onPref({ preview: !prefs.preview })}>Preview panel</MenuItem>
      <MenuRule />
      <MenuCap>Density</MenuCap>
      <MenuItem on={prefs.density === "compact"} onClick={() => onPref({ density: "compact" })}>Compact</MenuItem>
      <MenuItem on={prefs.density === "airy"} onClick={() => onPref({ density: "airy" })}>Airy</MenuItem>
      <MenuRule />
      <MenuCap>Text size</MenuCap>
      <div className="flex items-center gap-2 px-3.5" style={{ minHeight: 30 }}>
        <button className="agx-btn rounded-md grid place-items-center" style={{ width: HIT, height: HIT, border: EDGE }} aria-label="Smaller text" disabled={prefs.textSize <= TEXT_MIN} onClick={() => onPref({ textSize: prefs.textSize - 1 })}>−</button>
        <span className="tabular-nums flex-1 text-center" aria-live="polite">{prefs.textSize} px</span>
        <button className="agx-btn rounded-md grid place-items-center" style={{ width: HIT, height: HIT, border: EDGE }} aria-label="Larger text" disabled={prefs.textSize >= TEXT_MAX} onClick={() => onPref({ textSize: prefs.textSize + 1 })}>+</button>
      </div>
      <MenuRule />
      <MenuItem on={prefs.group} onClick={() => onPref({ group: !prefs.group })}>Group by file type</MenuItem>
      <MenuItem on={prefs.sizes} onClick={() => onPref({ sizes: !prefs.sizes })}>Show sizes in Columns</MenuItem>
      <MenuItem on={prefs.hidden} hint="Ctrl+H" onClick={() => onPref({ hidden: !prefs.hidden })}>Hidden files</MenuItem>
    </Popover>
  );
}

export const SHORTCUTS: [string, string][] = [
  ["↑ ↓", "Move in the column"],
  ["→ / Enter", "Open the folder as the next column"],
  ["←", "Back a column; at the first, up a folder"],
  ["Backspace", "Up a folder"],
  ["Enter on a file", "Open it in nvim (the bench)"],
  ["Space", "Show or hide the preview"],
  ["Ctrl+L", "Type a path"],
  ["Ctrl+H", "Show or hide hidden files"],
  ["Ctrl+B", "Show or hide the sidebar"],
  ["Ctrl+C", "Copy the selected path"],
  ["Home / End", "First or last entry"],
  ["F1", "This list"],
];

export function HelpSheet({ onClose }: { onClose: () => void }) {
  return (
    <div role="dialog" aria-label="Shortcuts" className="absolute inset-0 grid place-items-center p-4" style={{ background: "color-mix(in srgb, var(--bg) 70%, transparent)", zIndex: 8 }}
      onClick={onClose} onKeyDown={(e) => { if (e.key === "Escape" || e.key === "F1") { e.stopPropagation(); onClose(); } }}>
      <div className="rounded-xl p-4 text-[12px] max-w-full" style={{ background: "var(--surface-card)", border: EDGE, width: 380 }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center mb-2"><b className="flex-1 text-[13px]">Shortcuts</b><button className="agx-btn rounded-md px-2" style={{ minHeight: HIT, border: EDGE }} autoFocus onClick={onClose}>Close</button></div>
        <dl className="m-0 grid gap-y-1.5" style={{ gridTemplateColumns: "auto 1fr", columnGap: 14 }}>
          {SHORTCUTS.map(([k, d]) => (<Fragment key={k}><dt><kbd className="rounded px-1.5" style={{ border: EDGE, color: "var(--text2)" }}>{k}</kbd></dt><dd className="m-0" style={{ color: "var(--text2)" }}>{d}</dd></Fragment>))}
        </dl>
      </div>
    </div>
  );
}
