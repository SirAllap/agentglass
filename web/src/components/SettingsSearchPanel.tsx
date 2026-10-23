import { useEffect, useRef, useState, type ReactElement, type RefObject } from "react";
import { ICON } from "../lib/iconSize.ts";
import {
  highlightParts, hueVar, jumpTarget, moveSelection, searchSummary, synonymsUsed,
  type MatchIn, type SearchModel,
} from "../lib/settingsNav.ts";
import { ChevronRightIcon, SearchIcon } from "./settingsNavIcons.tsx";

function Marked({ text, q }: { text: string; q: string }) {
  return <>{highlightParts(text, q).map((p, i) => (p.hit ? <mark key={i}>{p.t}</mark> : <span key={i}>{p.t}</span>))}</>;
}

/**
 * The search box in the nav, and the results beside it.
 *
 * Results are grouped by page, each page under a header that names its group,
 * and the arrow keys walk the rows in the order they are drawn. Enter returns
 * the selected row to the caller, which lands on its page and flashes it with
 * the same mechanism a deep link uses. The ranking is the settings index's
 * (searchSettings); this draws it, it does not re-rank it.
 *
 * Esc clears the query first. It is stopped here, so the page-level Escape
 * ("press again to leave settings") only sees an Escape nobody else wanted.
 */
export function SettingsSearchPanel({ q, onQ, mode, onMode, model, absent, onLand, inputRef, icons }: {
  q: string;
  onQ: (q: string) => void;
  mode: MatchIn;
  onMode: (m: MatchIn) => void;
  model: SearchModel;
  /** A sentence for a word that is known not to be a setting ("proxy"). */
  absent: string | null;
  onLand: (t: { pane: string; row: string }) => void;
  inputRef: RefObject<HTMLInputElement>;
  icons: ReadonlyMap<string, (p: { size?: number }) => ReactElement>;
}) {
  const open = q.trim().length > 0;
  const [sel, setSel] = useState(0);
  useEffect(() => { setSel(0); }, [q, mode]);
  const list = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[data-sel="true"]')?.scrollIntoView({ block: "nearest" });
  }, [sel, open, model]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape" && open) { e.stopPropagation(); onQ(""); return; }
    if (!open || !model.flat.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((i) => moveSelection(i, 1, model.flat.length)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((i) => moveSelection(i, -1, model.flat.length)); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const t = jumpTarget(model, sel);
      if (t) onLand(t);
    }
  };

  const syn = open ? synonymsUsed(q, model) : [];
  let at = -1;
  return (
    <>
      <label className="agx-sp-box" data-open={open ? "" : undefined}>
        <SearchIcon size={ICON.md} />
        <input ref={inputRef} className="bg-transparent" value={q} onChange={(e) => onQ(e.target.value)} onKeyDown={onKeyDown}
          placeholder="Search settings" aria-label="Search settings" aria-keyshortcuts="Control+F"
          aria-expanded={open} aria-controls="agx-sp-list" autoComplete="off" spellCheck={false} />
        <kbd>Ctrl F</kbd>
      </label>
      {open && (
        <>
          <div className="agx-sp-scrim" onClick={() => onQ("")} aria-hidden />
          <div className="agx-sp-pop" role="group" aria-label="Search results">
            <div className="agx-sp-head">
              <b>
                {searchSummary(model, q)}
                {syn.length > 0 && <span className="agx-sp-also"> · also: {syn.join(", ")}</span>}
              </b>
              <span>Match in</span>
              <div className="agx-sp-seg" role="group" aria-label="Match in">
                <button type="button" aria-pressed={mode === "help"} onClick={() => onMode("help")}>Names + help</button>
                <button type="button" aria-pressed={mode === "names"} onClick={() => onMode("names")}>Names</button>
              </div>
            </div>
            <div className="agx-sp-list" id="agx-sp-list" ref={list} role="listbox">
              {model.pages.map((pg) => {
                const Icon = icons.get(pg.pane);
                return (
                  <div key={pg.pane} role="presentation">
                    <div className="agx-sp-pg" style={{ "--hue": hueVar(pg.group?.id ?? "system") } as React.CSSProperties}>
                      <span className="agx-sp-ci">{Icon && <Icon size={ICON.sm} />}</span>
                      {pg.label}
                      {pg.group && <span>in {pg.group.name}</span>}
                    </div>
                    {pg.hits.map((h) => {
                      at++;
                      const i = at;
                      return (
                        <div key={`${h.pane}/${h.row}/${h.label}`} className="agx-sp-hit" role="option" aria-selected={sel === i}
                          data-sel={sel === i ? "true" : undefined}
                          onMouseMove={() => { if (sel !== i) setSel(i); }}
                          onClick={() => onLand({ pane: h.pane, row: h.row })}>
                          <div className="agx-sp-n">
                            <Marked text={h.label} q={q} />
                            {h.section && h.row && <span className="agx-sp-tag">{h.section}</span>}
                          </div>
                          {h.hint && <div className="agx-sp-h"><Marked text={h.hint} q={q} /></div>}
                          <div className="agx-sp-w"><ChevronRightIcon size={ICON.sm} /></div>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
              {model.flat.length === 0 && (
                <div className="agx-sp-none">{absent ?? <>Nothing matches “{q.trim()}”. Try a shorter word.</>}</div>
              )}
            </div>
            <div className="agx-sp-keys">
              <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
              <span><kbd>↵</kbd> jump to the setting and flash it</span>
              <span><kbd>Esc</kbd> close</span>
            </div>
          </div>
        </>
      )}
    </>
  );
}
