// The appearance menu and the shortcut sheet: the two small surfaces that are
// about the finder itself rather than about a folder.
import { useMemo, useRef, useState } from "react";
import { SECTIONS, filterShortcuts, keyLabel } from "../../../lib/finderShortcuts.ts";
import { TEXT_MAX, TEXT_MIN, THUMB_DEFAULT, THUMB_MAX, THUMB_MIN, resetSort, type Prefs, type SortDir, type SortKey } from "../../../lib/finderMiller.ts";
import { PAGES, ROWS, filterRows, pagesWith, toggleValue, type PageId, type Row } from "../../../lib/finderSettingsModel.ts";
import { StrataIcon } from "./StrataIcon.tsx";
import { useBox } from "./useBox.ts";
import { HIT, ICON } from "../../../lib/iconSize.ts";
import { EDGE, INPUT, INPUT_STYLE, LINE } from "../../workspace/Chrome.tsx";
import { MenuCap, MenuItem, MenuRule, Popover } from "./Popover.tsx";

export function AppearanceMenu({ anchor, prefs, onPref, onClose }: { anchor: DOMRect; prefs: Prefs; onPref: (p: Partial<Prefs>) => void; onClose: () => void }) {
  return (
    <Popover anchor={anchor} onClose={onClose} width={290} label="Appearance">
      <MenuCap>View</MenuCap>
      <MenuItem icon="columns" on={prefs.view === "columns"} onClick={() => onPref({ view: "columns" })}>Columns</MenuItem>
      <MenuItem icon="icons" on={prefs.view === "icons"} onClick={() => onPref({ view: "icons" })}>Icons</MenuItem>
      <MenuItem icon="list" on={prefs.view === "list"} onClick={() => onPref({ view: "list" })}>List</MenuItem>
      <MenuItem icon="eye" on={prefs.preview} hint="Space" onClick={() => onPref({ preview: !prefs.preview })}>Preview panel</MenuItem>
      <MenuRule />
      <MenuCap>Density</MenuCap>
      <MenuItem icon="rows" on={prefs.density === "compact"} onClick={() => onPref({ density: "compact" })}>Compact</MenuItem>
      <MenuItem icon="rows" on={prefs.density === "airy"} onClick={() => onPref({ density: "airy" })}>Airy</MenuItem>
      <MenuRule />
      <MenuCap>Text size</MenuCap>
      <div className="flex items-center gap-2 px-3.5" style={{ minHeight: 40 }}>
        <b className="flex-1" style={{ color: "var(--primary-ink)", fontWeight: 600 }} aria-hidden>Aa</b>
        <div className="flex items-stretch rounded-md overflow-hidden" style={{ border: EDGE }}>
          <button className="agx-btn grid place-items-center" style={{ width: HIT, height: HIT, color: "var(--primary-ink)" }} aria-label="Smaller text" disabled={prefs.textSize <= TEXT_MIN} onClick={() => onPref({ textSize: prefs.textSize - 1 })}>−</button>
          <span className="tabular-nums grid place-items-center px-2" style={{ minWidth: 52, borderInline: EDGE }} aria-live="polite">{prefs.textSize} px</span>
          <button className="agx-btn grid place-items-center" style={{ width: HIT, height: HIT, color: "var(--primary-ink)" }} aria-label="Larger text" disabled={prefs.textSize >= TEXT_MAX} onClick={() => onPref({ textSize: prefs.textSize + 1 })}>+</button>
        </div>
      </div>
      <MenuRule />
      {/* Grouping is a List thing (Strata greys it in Columns and Icons); sizes in the row are Columns' own. Strata greys the first and drops the second elsewhere. */}
      <MenuItem icon="list-checks" disabled={prefs.view !== "list"} on={prefs.group} onClick={() => onPref({ group: !prefs.group })}>Group by file type</MenuItem>
      {prefs.view === "columns" && <MenuItem icon="columns" on={prefs.sizes} onClick={() => onPref({ sizes: !prefs.sizes })}>Show sizes in Columns view</MenuItem>}
      <MenuItem icon={prefs.hidden ? "eye" : "eye-off"} on={prefs.hidden} hint="Ctrl+H" onClick={() => onPref({ hidden: !prefs.hidden })}>Hidden files</MenuItem>
    </Popover>
  );
}

/**
 * Strata's Settings window, as a modal over the finder: a page list on the left under
 * "SETTINGS" with "Search settings", the rows of the open page on the right, each
 * with its title, its one-line description and its control. A change is made the
 * moment it is clicked and clicked again to undo (lib/finderSettingsModel).
 */
export function FinderSettings({ prefs, onPref, onReset, onForget, onClose }: { prefs: Prefs; onPref: (p: Partial<Prefs>) => void; onReset: () => void; onForget: () => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [page, setPage] = useState<PageId>("general");
  const frame = useRef<HTMLDivElement>(null);
  /* Narrow: the page list folds above the rows and each row puts its control under its text, as Strata's window does at 700. */
  const fw = useBox(frame).w;
  const narrow = fw > 0 && fw < 640;
  const shown = useMemo(() => filterRows(ROWS, q), [q]);
  const withHits = useMemo(() => pagesWith(shown), [shown]);
  const open: PageId = q.trim() && !withHits.has(page) ? ([...withHits][0] ?? page) : page;
  const rows = shown.filter((r) => r.page === open);
  const sections = [...new Set(rows.map((r) => r.section))];
  const def = resetSort(prefs);
  const Switch = ({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) => (
    <button role="switch" aria-checked={on} aria-label={label} onClick={onClick} className="agx-btn shrink-0 relative rounded-full"
      style={{ width: 38, height: 22, border: EDGE, background: on ? "var(--primary)" : "transparent" }}>
      <span className="absolute rounded-full" style={{ top: 2, left: on ? 18 : 2, width: 16, height: 16, background: on ? "var(--bg)" : "var(--text3)", transition: "left 120ms" }} />
    </button>
  );
  const control = (r: Row) => {
    switch (r.kind) {
      case "toggle": return <Switch on={toggleValue(prefs, r.id)} label={r.title} onClick={() => onPref({ [r.id]: !prefs[r.id] } as Partial<Prefs>)} />;
      case "button": return <button className="agx-btn rounded-md px-3" style={{ minHeight: HIT, border: EDGE }} onClick={onForget}>{r.action}</button>;
      case "sort": return (
        <span className="flex items-center gap-1.5">
          <select aria-label="Default sort field" className={INPUT} style={INPUT_STYLE} value={def.sortKey} onChange={(e) => onPref({ defSort: { ...def, sortKey: e.target.value as SortKey } })}>
            {(["name", "size", "modified", "type"] as const).map((k) => <option key={k} value={k}>{k[0]!.toUpperCase() + k.slice(1)}</option>)}
          </select>
          <select aria-label="Default sort direction" className={INPUT} style={INPUT_STYLE} value={def.sortDir} onChange={(e) => onPref({ defSort: { ...def, sortDir: e.target.value as SortDir } })}>
            <option value="asc">Ascending</option><option value="desc">Descending</option>
          </select>
        </span>
      );
      case "stepper": return (
        <div className="flex items-stretch rounded-md overflow-hidden" style={{ border: EDGE }}>
          <button className="agx-btn grid place-items-center" style={{ width: HIT, height: HIT, color: "var(--primary-ink)" }} aria-label="Smaller text" disabled={prefs.textSize <= TEXT_MIN} onClick={() => onPref({ textSize: prefs.textSize - 1 })}>−</button>
          <span className="tabular-nums grid place-items-center px-2" style={{ minWidth: 52, borderInline: EDGE }} aria-live="polite">{prefs.textSize} px</span>
          <button className="agx-btn grid place-items-center" style={{ width: HIT, height: HIT, color: "var(--primary-ink)" }} aria-label="Larger text" disabled={prefs.textSize >= TEXT_MAX} onClick={() => onPref({ textSize: prefs.textSize + 1 })}>+</button>
        </div>
      );
      case "density": return (
        <span className="flex gap-1">
          {(["compact", "airy"] as const).map((d) => <button key={d} aria-pressed={prefs.density === d} className="agx-btn rounded-md px-3" style={{ minHeight: HIT, border: EDGE, background: prefs.density === d ? "color-mix(in srgb, var(--primary) 18%, transparent)" : undefined }} onClick={() => onPref({ density: d })}>{d === "compact" ? "Compact" : "Airy"}</button>)}
        </span>
      );
      case "slider": return (
        <span className="flex items-center gap-2">
          <input type="range" min={THUMB_MIN} max={THUMB_MAX} step={16} value={prefs.thumb} aria-label="Thumbnail size" style={{ width: 140 }} onChange={(e) => onPref({ thumb: Number(e.target.value) })} />
          <span className="tabular-nums text-center" style={{ minWidth: 44 }} aria-live="polite">{prefs.thumb} px</span>
          <button className="agx-btn rounded-md px-2" style={{ minHeight: HIT, border: EDGE }} disabled={prefs.thumb === THUMB_DEFAULT} onClick={() => onPref({ thumb: THUMB_DEFAULT })}>Reset</button>
        </span>
      );
    }
  };
  return (
    <div ref={frame} role="dialog" aria-label="Settings" className="absolute inset-0 flex flex-col" style={{ background: "var(--bg)", zIndex: 8 }}
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}>
      <div className="flex items-center gap-2 px-3 shrink-0" style={{ minHeight: 40, borderBottom: LINE }}>
        <b className="flex-1 text-[13px]">Settings</b>
        <button className="agx-btn rounded-md grid place-items-center" style={{ width: HIT, height: HIT, color: "var(--primary-ink)" }} title="Close (Esc)" aria-label="Close settings" onClick={onClose}><StrataIcon set="act" name="x" size={ICON.sm} /></button>
      </div>
      <div className={`flex-1 min-h-0 flex ${narrow ? "flex-col" : ""}`}>
        <nav aria-label="Settings pages" className={`shrink-0 flex gap-1 p-2.5 ${narrow ? "flex-wrap items-center" : "flex-col"}`} style={narrow ? { borderBottom: LINE } : { width: 220, borderRight: LINE }}>
          {!narrow && <span className="px-1.5 pb-1 text-[10.5px] uppercase tracking-[0.1em]" style={{ color: "var(--text3)", fontWeight: 600 }}>Settings</span>}
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search settings" aria-label="Search settings" spellCheck={false}
            onKeyDown={(e) => { if (e.key !== "Escape") e.stopPropagation(); }} className={`${INPUT} ${narrow ? "flex-1 min-w-[140px]" : "w-full mb-1.5"}`} style={INPUT_STYLE} />
          {PAGES.map((p) => (
            <button key={p.id} aria-current={open === p.id ? "page" : undefined} disabled={!!q.trim() && !withHits.has(p.id)} onClick={() => setPage(p.id)}
              className="agx-btn rounded-md px-2.5 py-1.5 text-left disabled:opacity-40" style={{ background: open === p.id ? "color-mix(in srgb, var(--primary) 14%, transparent)" : undefined }}>
              <div className="text-[12.5px]">{p.title}</div>
              <div className="text-[10.5px]" style={{ color: "var(--text3)" }}>{p.hint}</div>
            </button>
          ))}
          {!narrow && <span className="flex-1" />}
          <button className="agx-btn rounded-md px-2.5" style={{ minHeight: HIT, border: EDGE, color: "var(--text2)" }} onClick={onReset}>{narrow ? "Reset" : "Reset finder settings"}</button>
        </nav>
        <div className={`agx-scroll flex-1 min-w-0 min-h-0 overflow-y-auto ${narrow ? "px-4" : "px-6"} py-4`}>
          <h2 className="m-0 mb-3 text-[16px]">{PAGES.find((p) => p.id === open)!.title}</h2>
          {rows.length === 0 && <p style={{ color: "var(--text3)" }}>No matching settings</p>}
          {sections.map((sec) => (
            <section key={sec} aria-label={sec} className="mb-5">
              <h4 className="m-0 mb-1 text-[10.5px] uppercase tracking-[0.1em]" style={{ color: "var(--text3)", fontWeight: 600 }}>{sec}</h4>
              {rows.filter((r) => r.section === sec).map((r) => (
                <div key={r.id} className={`flex gap-4 py-2.5 ${narrow ? "flex-col items-start gap-2" : "items-center"}`} style={{ borderTop: LINE }}>
                  <div className="flex-1 min-w-0">
                    <div className="text-[12.5px]">{r.title}</div>
                    <div className="text-[11px]" style={{ color: "var(--text3)" }}>{r.desc}</div>
                  </div>
                  {control(r)}
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Strata's F1 sheet: a title and search along the top, the categories with their counts on the left, the rows of the chosen one in two columns, and the keys that work in the footer. */
export function HelpSheet({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string>("All");
  const search = useRef<HTMLInputElement>(null);
  const card = useRef<HTMLDivElement>(null);
  /* Narrow: the categories become chips under the field and the rows stack one per line, as Strata does at 700. */
  const w = useBox(card).w;
  const narrow = w > 0 && w < 640;
  const found = filterShortcuts(SECTIONS, q);
  const total = found.reduce((n, sec) => n + sec.rows.length, 0);
  const cats = [{ title: "All", n: total }, ...found.map((sec) => ({ title: sec.title, n: sec.rows.length }))];
  const open = cats.some((c) => c.title === cat) ? cat : "All";
  const shown = open === "All" ? found : found.filter((sec) => sec.title === open);
  const step = (d: 1 | -1) => { const i = cats.findIndex((c) => c.title === open); setCat(cats[(i + d + cats.length) % cats.length]!.title); };
  return (
    <div role="dialog" aria-label="Keyboard shortcuts" className="absolute inset-0 grid place-items-center p-4" style={{ background: "color-mix(in srgb, var(--bg) 70%, transparent)", zIndex: 8 }}
      onClick={onClose} onKeyDown={(e) => {
        if (e.key === "Escape" || e.key === "F1") { e.stopPropagation(); onClose(); }
        else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") { e.preventDefault(); e.stopPropagation(); search.current?.focus(); }
      }}>
      <div ref={card} className="rounded-xl text-[12px] max-w-full max-h-full flex flex-col min-h-0" style={{ background: "var(--surface-card)", border: EDGE, width: "min(1080px, 100%)", height: "min(640px, 100%)" }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-4 px-5 shrink-0 flex-wrap" style={{ minHeight: 56, borderBottom: LINE }}>
          <b className="text-[13px]">Keyboard shortcuts</b>
          <input ref={search} autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search actions or keys…" aria-label="Search actions or keys" spellCheck={false}
            onKeyDown={(e) => { if (e.key !== "Escape" && e.key !== "F1" && !((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f")) e.stopPropagation(); }}
            className={`${INPUT} flex-1 min-w-[180px]`} style={INPUT_STYLE} />
        </div>
        <div className={`flex-1 min-h-0 flex ${narrow ? "flex-col" : ""}`}>
          <nav aria-label="Categories" className={`shrink-0 ${narrow ? "flex flex-wrap gap-1.5 p-2.5" : "py-2"}`} style={narrow ? { borderBottom: LINE } : { width: 210, borderRight: LINE }}
            onKeyDown={(e) => { if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); step(1); } else if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); step(-1); } }}>
            {cats.map((c) => (
              <button key={c.title} aria-current={open === c.title ? "true" : undefined} onClick={() => setCat(c.title)} className={`agx-btn flex items-center text-left ${narrow ? "gap-2 px-3 rounded-full" : "w-full px-4"}`}
                style={{ minHeight: narrow ? 30 : 40, color: open === c.title ? "var(--text)" : "var(--text3)", outline: open === c.title ? "1px solid var(--primary)" : undefined, outlineOffset: -1, background: open === c.title ? "color-mix(in srgb, var(--primary) 10%, transparent)" : undefined }}>
                <span className="flex-1 min-w-0 truncate">{c.title}</span><span className="tabular-nums text-[11px]">{c.n}</span>
              </button>
            ))}
          </nav>
          <div className={`agx-scroll flex-1 min-w-0 min-h-0 overflow-y-auto ${narrow ? "px-4" : "px-6"} py-4`}>
            {shown.length === 0 ? <p className="m-0 py-3" style={{ color: "var(--text3)" }}>No matching shortcuts</p> : shown.map((sec) => (
              <section key={sec.title} aria-label={sec.title} className="mb-5">
                <h4 className="m-0 mb-3 flex items-center gap-2 text-[11px] uppercase tracking-[0.1em]" style={{ color: "var(--primary-ink)", fontWeight: 600 }}>
                  {sec.title}<span style={{ color: "var(--text3)" }}>{sec.rows.length}</span><span className="flex-1" style={{ borderTop: LINE }} />
                </h4>
                <dl className="m-0 grid gap-x-10 gap-y-2.5" style={{ gridTemplateColumns: narrow ? "1fr" : "repeat(auto-fit, minmax(300px, 1fr))" }}>
                  {sec.rows.map((r) => (
                    <div key={r.keys} className="flex items-center gap-3 min-w-0">
                      <dd className="m-0 flex-1 min-w-0" style={{ color: "var(--text)" }}>{r.does}</dd>
                      <dt className="shrink-0"><kbd className="rounded px-1.5 py-0.5 whitespace-nowrap" style={{ border: EDGE, color: "var(--text2)" }}>{keyLabel(r.keys)}</kbd></dt>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        </div>
        <div className="px-5 shrink-0 flex items-center text-[11px]" style={{ minHeight: 40, borderTop: LINE, color: "var(--text3)" }}>Ctrl+F search · ↑ / ↓ category · Esc close</div>
      </div>
    </div>
  );
}
