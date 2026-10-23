// Strata's folder tabs: a strip above the path row, one label and one cross per
// tab, a plus at the end. It is drawn only when there is more than one, so a
// finder that never uses tabs looks as it did. The model is lib/finderTabs.
import { useEffect, useRef } from "react";
import { HIT, ICON } from "../../../lib/iconSize.ts";
import { tabLabel, tabWheel, type Tabs } from "../../../lib/finderTabs.ts";
import { LINE } from "../../workspace/Chrome.tsx";
import { activates } from "../../../lib/finderPointer.ts";
import { StrataIcon } from "./StrataIcon.tsx";

export function FinderTabs({ tabs, home, onSelect, onClose, onNew }: { tabs: Tabs; home: string; onSelect: (i: number) => void; onClose: (i: number) => void; onNew: () => void }) {
  // The active tab is scrolled into the strip, and only the strip moves (scrollIntoView would move the page around it too).
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = strip.current, tab = el?.querySelectorAll<HTMLElement>('[role="tab"]')[tabs.active];
    if (!el || !tab) return;
    if (tab.offsetLeft < el.scrollLeft) el.scrollLeft = tab.offsetLeft;
    else if (tab.offsetLeft + tab.offsetWidth > el.scrollLeft + el.clientWidth) el.scrollLeft = tab.offsetLeft + tab.offsetWidth - el.clientWidth;
  }, [tabs.active, tabs.paths.length]);
  if (tabs.paths.length < 2) return null;
  return (
    <div ref={strip} role="tablist" aria-label="Folder tabs" className="flex items-stretch gap-0.5 px-2.5 shrink-0 overflow-x-auto agx-scroll" style={{ borderBottom: LINE }}
      onWheel={(e) => { e.currentTarget.scrollLeft += tabWheel(e.deltaX, e.deltaY); }}>
      {tabs.paths.map((p, i) => {
        const on = i === tabs.active;
        return (
          <div key={i} role="tab" aria-selected={on} data-drop-path={p} data-drop-kind="tab" className="flex items-center gap-1 pl-2.5 pr-1 text-[12px] shrink-0 cursor-pointer"
            style={{ minHeight: HIT, color: on ? "var(--primary-ink)" : "var(--text3)", boxShadow: on ? "inset 0 -2px 0 var(--primary)" : undefined, maxWidth: 200 }}
            onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }} onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(i); } }} onClick={(e) => { if (activates(e.button, "click")) onSelect(i); }}>
            <span className="truncate">{tabLabel(p, home)}</span>
            <button className="agx-btn rounded-md grid place-items-center" style={{ width: HIT - 8, height: HIT - 8 }} aria-label={`Close tab ${tabLabel(p, home)}`} title="Close tab (Ctrl+W)" onClick={(e) => { e.stopPropagation(); onClose(i); }}><StrataIcon set="act" name="x" size={ICON.xs} /></button>
          </div>
        );
      })}
      <button className="agx-btn rounded-md grid place-items-center self-center" style={{ width: HIT, height: HIT, color: "var(--primary-ink)" }} aria-label="New tab" title="New tab (Ctrl+T)" onClick={onNew}><StrataIcon set="act" name="plus" size={ICON.md} /></button>
    </div>
  );
}
