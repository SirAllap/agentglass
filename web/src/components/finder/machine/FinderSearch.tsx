// The Ctrl+K overlay: Strata's global search, over Home.
//
// Names are fuzzy and come from the server's incremental index; Contents is the
// existing text search. The overlay holds its own focus and its own keys, so
// the finder behind it does not move while somebody types.
import { useEffect, useRef, useState } from "react";
import { api } from "../../../lib/api.ts";
import { hitTarget, emptyText, partialResults, stepHot, hitPath, closesOnPress, contentsNote, flipMode, grepPath, hasScopeChoice, inScope, modeKey, scopeName, scopeRoot, searchPlaceholder, splitMatch, CONTENTS_MIN, type HitTarget, type SearchHit, type SearchMode, type SearchScope } from "../../../lib/finderSearch.ts";
import { ICON } from "../../../lib/iconSize.ts";
import { SearchIcon } from "../../../lib/glyphIcons.tsx";
import { EDGE, LINE, Segmented } from "../../workspace/Chrome.tsx";
import { MenuCap, MenuItem, Popover } from "./Popover.tsx";
import { PathIcon, StrataIcon } from "./StrataIcon.tsx";
import { searchVisited, visitedEmpty, type Visit } from "../../../lib/finderVisited.ts";

interface Row extends SearchHit { text?: { before: string; match: string; after: string }; line?: number }

/** Names ask the index for up to this many when the scope is a folder, since the index answers for the whole machine and the rest is cut here. A folder with more than this many name matches is the ceiling. */
const SCOPED_NAMES = 200;

/** The two things to search, as the Segmented wants them. */
const MODE_OPTIONS: readonly (readonly [SearchMode, string, string])[] = [["names", "Names", "File and folder names"], ["contents", "Contents", "Inside files"]];

/** `jump`: Ctrl+Shift+K. The same overlay over the folders visited before, which are known at once, so nothing is asked of the server. */
export function FinderSearch({ home, here = "", mode, onMode, onTarget, onClose, jump }: { home: string; /** The folder the Finder is in: the second scope. */ here?: string; /** Names or Contents; the Finder keeps it with its other settings. */ mode: SearchMode; onMode: (m: SearchMode) => void; onTarget: (t: HitTarget) => void; onClose: () => void; jump?: { visited: readonly Visit[]; here: string } }) {
  const [q, setQ] = useState("");
  const contents = mode === "contents";
  const [scope, setScope] = useState<SearchScope>("home");
  const root = scopeRoot(scope, home, here), where = scopeName(scope, here);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState<string | undefined>();
  const [capped, setCapped] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [hot, setHot] = useState(0);
  const [status, setStatus] = useState<"idle" | "building" | "ready">("idle");
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);

  useEffect(() => {
    if (jump) { setRows(searchVisited(jump.visited, q, Date.now(), jump.here).map((v): Row => ({ path: v.path, dir: true }))); setHot(0); return; }
    setFailed(undefined); setCapped(false);
    if (!q.trim() || (contents && q.trim().length < CONTENTS_MIN)) { setRows([]); setPending(false); return; }
    const ctl = new AbortController();
    setPending(true);
    const t = setTimeout(() => {
      const ask: Promise<Row[]> = contents
        ? api.diskGrep(root, q.trim()).then((r) => {
            setStatus("ready"); setCapped(r.ok && r.truncated); setFailed(r.ok ? undefined : r.error || "the search did not answer");
            return r.ok ? r.hits.map((h): Row => ({ path: grepPath(home, h.rel), dir: false, text: splitMatch(h.text, h.at, h.len), line: h.line })) : [];
          })
        : api.diskIndexSearch(q.trim(), ctl.signal, scope === "here" ? SCOPED_NAMES : undefined).then((r) => {
            setStatus(r.building ? "building" : "ready");
            return r.ok ? r.hits.filter((h) => inScope(h.path, root)).map((h): Row => ({ path: h.path, dir: h.dir })) : [];
          });
      void ask.then((r) => { if (!ctl.signal.aborted) { setRows(r); setHot(0); setPending(false); } })
        .catch(() => { if (!ctl.signal.aborted) { setPending(false); setFailed("the server did not answer"); } });
    }, 60);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [q, contents, home, root, scope, jump]);

  useEffect(() => { list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }); }, [hot, rows]);

  const choose = (i: number, alt: boolean) => { const r = rows[i]; if (r) { onTarget(hitTarget(r, alt)); onClose(); } };
  const note = jump ? visitedEmpty(q, rows.length) : contents ? contentsNote({ q, scope: where, pending, found: rows.length, error: failed }) : emptyText(q, status, rows.length);
  /* One way to change the mode, whatever asked: the field keeps focus, so the next key still types. */
  const pick = (m: SearchMode) => { onMode(m); input.current?.focus(); };
  const key = "Tab or Alt+C";

  return (
    <div role="dialog" aria-label={jump ? "Jump to a folder" : "Search"} className="absolute inset-0 flex justify-center items-start p-4" style={{ zIndex: 9, background: "color-mix(in srgb, var(--bg) 55%, transparent)", backdropFilter: "blur(3px)" }} onMouseDown={(e) => { if (closesOnPress(e.target, e.currentTarget)) onClose(); }}>
      <div className="flex flex-col rounded-xl overflow-hidden w-full min-h-0" style={{ maxWidth: 760, maxHeight: "min(70%, 560px)", marginTop: "12%", background: "var(--surface-card)", border: EDGE, boxShadow: "0 24px 60px -20px #000" }} onKeyDown={(e) => { if (!jump && e.key !== "Tab" && modeKey(e)) { e.preventDefault(); pick(flipMode(mode)); } }}>
        <div className="flex items-center gap-2.5 px-3.5 shrink-0" style={{ minHeight: 58, borderBottom: LINE }}>
          <span className="flex" style={{ color: "var(--primary-ink)" }}><SearchIcon size={ICON.sm} /></span>
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} autoComplete="off" aria-label={jump ? "Folders previously visited in the Finder" : contents ? "Search inside files" : "Search files and folders"}
            role="combobox" aria-expanded={rows.length > 0} aria-controls="finder-search-results" aria-activedescendant={rows[hot] ? `finder-search-${hot}` : undefined} aria-autocomplete="list" title={jump ? undefined : `${key} switches between names and contents`}
            placeholder={jump ? "Jump to a folder…" : searchPlaceholder(mode, where)} className="flex-1 min-w-0 bg-transparent outline-none text-[14px]" style={{ color: "var(--text)" }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (!jump && modeKey(e)) { e.preventDefault(); pick(flipMode(mode)); return; }
              if (e.key === "Escape") { e.preventDefault(); onClose(); }
              else if (e.key === "ArrowDown") { e.preventDefault(); setHot((h) => stepHot(h, 1, rows.length)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setHot((h) => stepHot(h, -1, rows.length)); }
              else if (e.key === "Enter") { e.preventDefault(); choose(hot, e.altKey && !jump); }
              else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); onClose(); }
            }} />
          {status === "building" && <span role="status" aria-label="Indexing files…" title="Indexing files…" className="agx-spin shrink-0" />}
          {!jump && <button type="button" className="agx-btn rounded-md grid place-items-center shrink-0" style={{ width: 26, height: 26, color: contents ? "var(--primary-ink)" : "var(--text3)" }} title="Search settings" aria-label="Search settings" aria-haspopup="menu"
            onClick={(e) => setMenu(e.currentTarget.getBoundingClientRect())}><StrataIcon set="act" name="sliders-horizontal" size={ICON.sm} /></button>}
        </div>
        {!jump && (
          /* Mousedown never takes focus from the field: the choice is made and the next key still types. */
          <div className="flex items-center gap-3 px-3.5 shrink-0 flex-wrap" style={{ minHeight: 40, borderBottom: LINE }} onMouseDown={(e) => e.preventDefault()}>
            <span className="text-[10.5px]" style={{ color: "var(--text3)" }}>Search in</span>
            <Segmented compact label="Search in" value={mode} onChange={pick} options={MODE_OPTIONS.map(([id, label, what]) => ({ id, label, title: `${what} (${key})` }))} />
            {hasScopeChoice(home, here) && <>
              <span className="text-[10.5px]" style={{ color: "var(--text3)" }}>where</span>
              <Segmented compact label="Search where" value={scope} onChange={(v) => { setScope(v); input.current?.focus(); }} options={[{ id: "home", label: "Home", title: home }, { id: "here", label: scopeName("here", here), title: `Only inside ${here}` }]} />
            </>}
            <span className="flex-1" />
            <span className="text-[10.5px]" style={{ color: "var(--text4)" }}>{key} to switch</span>
          </div>
        )}
        <div ref={list} role="listbox" id="finder-search-results" aria-label="Results" className="agx-scroll flex-1 min-h-0 overflow-y-auto" style={{ minHeight: 200 }}>
          {note ? <div className="h-full grid place-items-center text-[12px] p-6 text-center" style={{ color: "var(--text3)", minHeight: 200 }}><span className="whitespace-pre-line">{note}</span></div> : rows.map((r, i) => (
            <div key={`${r.path}:${r.line ?? ""}`} id={`finder-search-${i}`} role="option" aria-selected={i === hot} onMouseMove={() => setHot(i)} onClick={() => choose(i, false)}
              className="flex items-center gap-3 px-3.5 cursor-pointer" style={{ minHeight: 56, borderBottom: LINE, background: i === hot ? "color-mix(in srgb, var(--primary) 38%, var(--surface-card))" : undefined }}>
              <PathIcon path={r.path} name={r.path.slice(r.path.lastIndexOf("/") + 1)} isDir={r.dir} size={30} />
              <span className="min-w-0 flex-1 flex flex-col py-1">
                <span className="truncate text-[12.5px]" style={{ fontWeight: 700 }}>{r.path.slice(r.path.lastIndexOf("/") + 1)}{r.line ? <span style={{ color: "var(--text4)", fontWeight: 400 }}> : {r.line}</span> : null}</span>
                <span className="truncate text-[10.5px]" style={{ color: "var(--text3)" }}>{r.text
                  ? <>{r.text.before}{r.text.match && <mark style={{ background: "color-mix(in srgb, var(--primary) 45%, transparent)", color: "var(--text)", borderRadius: 3 }}>{r.text.match}</mark>}{r.text.after}</>
                  : hitPath(r.path)}</span>
                {r.text && <span className="truncate text-[10px]" style={{ color: "var(--text4)" }}>{hitPath(r.path.slice(0, r.path.lastIndexOf("/")) || "/")}</span>}
              </span>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-4 px-3.5 shrink-0 text-[10.5px]" style={{ minHeight: 30, borderTop: LINE, color: "var(--text3)" }}>
          <span>↑ / ↓ navigate</span><span>↵ open</span>{!jump && <span className="flex items-center gap-1.5"><StrataIcon set="act" name="folder-open" size={ICON.xs} />Alt+Enter open containing folder</span>}
          <span className="flex-1" />
          {capped && <span className="flex items-center gap-1.5" style={{ color: "var(--warning-ink)" }}><StrataIcon set="act" name="triangle-alert" size={ICON.xs} />First 200 matches: narrow the words</span>}
          {partialResults(status, rows.length) && <span className="flex items-center gap-1.5" style={{ color: "var(--warning-ink)" }}><StrataIcon set="act" name="triangle-alert" size={ICON.xs} />Partial results</span>}
        </div>
      </div>
      {menu && (
        <Popover anchor={menu} onClose={() => { setMenu(null); input.current?.focus(); }} width={240} label="Search settings">
          <MenuCap>Search in</MenuCap>
          <MenuItem on={!contents} onClick={() => { onMode("names"); setMenu(null); input.current?.focus(); }}>File and folder names</MenuItem>
          <MenuItem on={contents} onClick={() => { onMode("contents"); setMenu(null); input.current?.focus(); }}>Inside files (Contents)</MenuItem>
        </Popover>
      )}
    </div>
  );
}
