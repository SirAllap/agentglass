// The appearance menu and the shortcut sheet: the two small surfaces that are
// about the finder itself rather than about a folder.
import { Fragment, useState } from "react";
import { SECTIONS, filterShortcuts } from "../../../lib/finderShortcuts.ts";
import { TEXT_MAX, TEXT_MIN, THUMB_DEFAULT, THUMB_MAX, THUMB_MIN, type Prefs } from "../../../lib/finderMiller.ts";
import { HIT } from "../../../lib/iconSize.ts";
import { EDGE, INPUT, INPUT_STYLE } from "../../workspace/Chrome.tsx";
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
      <MenuCap>Thumbnail size</MenuCap>
      <div className="flex items-center gap-2 px-3.5" style={{ minHeight: 30 }}>
        <input type="range" min={THUMB_MIN} max={THUMB_MAX} step={16} value={prefs.thumb} aria-label="Thumbnail size" className="flex-1 min-w-0" onChange={(e) => onPref({ thumb: Number(e.target.value) })} />
        <span className="tabular-nums text-center" style={{ minWidth: 44 }} aria-live="polite">{prefs.thumb} px</span>
        <button className="agx-btn rounded-md px-2" style={{ minHeight: HIT, border: EDGE }} disabled={prefs.thumb === THUMB_DEFAULT} onClick={() => onPref({ thumb: THUMB_DEFAULT })}>Reset</button>
      </div>
      <MenuRule />
      <MenuItem on={prefs.group} onClick={() => onPref({ group: !prefs.group })}>Group by file type</MenuItem>
      <MenuItem on={prefs.sizes} onClick={() => onPref({ sizes: !prefs.sizes })}>Show sizes in Columns</MenuItem>
      <MenuItem on={prefs.hidden} hint="Ctrl+H" onClick={() => onPref({ hidden: !prefs.hidden })}>Hidden files</MenuItem>
    </Popover>
  );
}

/** Strata's BROWSING settings that mean something here. A change is made the moment it is clicked and clicked again to undo. */
export function FinderSettings({ anchor, prefs, onPref, onReset, onClose }: { anchor: DOMRect; prefs: Prefs; onPref: (p: Partial<Prefs>) => void; onReset: () => void; onClose: () => void }) {
  return (
    <Popover anchor={anchor} onClose={onClose} width={280} label="Finder settings">
      <MenuCap>Browsing</MenuCap>
      <MenuItem on={prefs.sizes} onClick={() => onPref({ sizes: !prefs.sizes })}>Show sizes in Columns view</MenuItem>
      <MenuItem on={prefs.mirror} onClick={() => onPref({ mirror: !prefs.mirror })}>Mirror columns selection</MenuItem>
      <MenuItem on={prefs.f1} hint="F1" onClick={() => onPref({ f1: !prefs.f1 })}>Show F1 Shortcuts button</MenuItem>
      <MenuRule />
      <MenuItem onClick={() => { onReset(); onClose(); }}>Reset finder settings</MenuItem>
    </Popover>
  );
}

export function HelpSheet({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const sections = filterShortcuts(SECTIONS, q);
  return (
    <div role="dialog" aria-label="Keyboard shortcuts" className="absolute inset-0 grid place-items-center p-4" style={{ background: "color-mix(in srgb, var(--bg) 70%, transparent)", zIndex: 8 }}
      onClick={onClose} onKeyDown={(e) => { if (e.key === "Escape" || e.key === "F1") { e.stopPropagation(); onClose(); } }}>
      <div className="rounded-xl p-4 text-[12px] max-w-full max-h-full flex flex-col min-h-0" style={{ background: "var(--surface-card)", border: EDGE, width: 440 }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-2 shrink-0">
          <b className="flex-1 text-[13px]">Keyboard shortcuts</b>
          <button className="agx-btn rounded-md px-2" style={{ minHeight: HIT, border: EDGE }} onClick={onClose}>Close</button>
        </div>
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search actions or keys…" aria-label="Search actions or keys" spellCheck={false}
          onKeyDown={(e) => { if (e.key !== "Escape" && e.key !== "F1") e.stopPropagation(); }}
          className={`${INPUT} w-full mb-2 shrink-0`} style={INPUT_STYLE} />
        <div className="agx-scroll overflow-y-auto min-h-0">
          {sections.length === 0 ? <p className="m-0 py-3" style={{ color: "var(--text3)" }}>No matching shortcuts</p> : sections.map((s) => (
            <section key={s.title} aria-label={s.title} className="mb-3">
              <h4 className="m-0 mb-1 text-[9.5px] uppercase tracking-[0.14em]" style={{ color: "var(--text4)", fontWeight: 600 }}>{s.title}</h4>
              <dl className="m-0 grid gap-y-1.5" style={{ gridTemplateColumns: "auto 1fr", columnGap: 14 }}>
                {s.rows.map((r) => (<Fragment key={r.keys}><dt><kbd className="rounded px-1.5" style={{ border: EDGE, color: "var(--text2)" }}>{r.keys}</kbd></dt><dd className="m-0" style={{ color: "var(--text)" }}>{r.does}</dd></Fragment>))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
