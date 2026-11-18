import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DoneIcon, SearchIcon, WarningIcon } from "../lib/glyphIcons.tsx";
import { ICON, HIT } from "../lib/iconSize.ts";
import { LAYER } from "../lib/layers.ts";
import { pickerBody } from "../lib/gitDialog.ts";
import {
  ROW_CAP, countLabel, optionText, ownsEnter, foldGroups, keyAction, orderRows, shelfOf, showSearch, showShelf, stopsOf, type PickRow,
} from "../lib/pickerCard.ts";
import { SHELF_SIZE } from "../lib/projectCard.ts";
import { Button, EDGE, INPUT, INPUT_STYLE, LINE, ListRow } from "./workspace/Chrome.tsx";

/**
 * The one card under a picker's button: project, people and branch pickers all
 * draw it, so the search, shelf, folding groups, states and keys are the same
 * everywhere. What differs is only the rows they hand in. Decisions (order,
 * folding, keys) live in lib/pickerCard.ts; this file only draws them.
 */
export type PickerItem = PickRow & {
  leading?: ReactNode;
  trailing?: ReactNode;
  /** Draw the label in the mono face (branch and path names). */
  mono?: boolean;
  /** Ticked (multi-select): drawn as a tick, read as "selected". */
  on?: boolean;
  disabled?: boolean;
  /** false: the picker draws its own tick, so the card adds none. */
  markOn?: boolean;
  /** Hover text for the row. */
  title?: string;
  /** Said after the label and sub for a screen reader ("pull request author"). */
  note?: string;
};

export function PickerCard({
  items, current, recent = [], groupLabels, loading, error, onRetry, onPick, onClose,
  placeholder, noun, emptyText, footer, footerNote, room = 340, width = 360, picked = 0, multi = false,
  style, keep, remote, onQuery, search, foldable = true, defaultOpen, label, onPickAlt, shelfNote, shelfTile,
}: {
  items: PickerItem[];
  /** Ids of the current choice; they sort first and carry aria-selected. */
  current?: ReadonlySet<string>;
  /** Ids for the shelf, most recent first. */
  recent?: readonly string[];
  groupLabels?: (key: string) => ReactNode;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onPick: (id: string) => void;
  onClose: () => void;
  placeholder: string;
  /** "branch", "project": names what a failed search found nothing of. */
  noun: string;
  emptyText: ReactNode;
  footer?: ReactNode;
  footerNote?: ReactNode;
  /** Room below the trigger in px: below ~180 the shelf drops first. */
  room?: number;
  width?: number;
  /** Count of ticks in a multi-select card. */
  picked?: number;
  /** Ticks are on offer (even before the first one): the list is multiselectable. */
  multi?: boolean;
  style?: React.CSSProperties;
  /** Keep the order given (no current-first); ticking never moves a row. */
  keep?: boolean;
  /** The source filters by what is typed: rows drawn as given, query sent on. */
  remote?: boolean;
  onQuery?: (q: string) => void;
  /** Force the search box on or off; default is by row count. */
  search?: boolean;
  /** false: groups are plain headings, always open and off the cursor's path. */
  foldable?: boolean;
  /** Group keys that start open. */
  defaultOpen?: readonly string[];
  /** Accessible name; default "Pick a <noun>". */
  label?: string;
  /** Shift+Enter on a row: the picker's second way to open it. */
  onPickAlt?: (id: string) => void;
  /** Right of the "Recent" heading ("last 7 days"). */
  shelfNote?: ReactNode;
  /** Draws a shelf tile's content; default is label over sub. */
  shelfTile?: (item: PickerItem, current: boolean) => ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set(defaultOpen));
  const [cursor, setCursor] = useState(0);
  const typed = useRef({ text: "", at: 0 });
  const listRef = useRef<HTMLDivElement>(null);

  const ordered = useMemo(() => orderRows(items, { current, query, keep, remote }), [items, current, query, keep, remote]);
  const { loose, groups } = useMemo(() => foldGroups(ordered, opened, query, foldable), [ordered, opened, query, foldable]);
  const shelf = !query.trim() && showShelf(room, recent.length) ? shelfOf(ordered, recent) : [];
  const stops = useMemo(() => stopsOf(loose, groups).filter((s) => foldable || s.kind === "row"), [loose, groups, foldable]);
  const withSearch = search ?? showSearch(items.length);
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const body = pickerBody({ loading: !!loading, error, total: items.length, shown: ordered.length, query: remote && !items.length ? "" : query });

  useEffect(() => { setCursor((c) => Math.min(c, Math.max(0, stops.length - 1))); }, [stops.length]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-cursor="true"]')?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  // Capture phase: the panel behind binds Escape and single letters, and a key
  // meant for the card must not also reach it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // No search box (short lists): typing jumps to the next row that starts with it.
      if (!withSearch && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== " ") {
        const t = typed.current; const now = Date.now();
        t.text = (now - t.at > 800 ? "" : t.text) + e.key.toLowerCase(); t.at = now;
        const hit = stops.findIndex((s, i) => s.kind === "row" && i >= (t.text.length > 1 ? cursor : cursor + 1) && byId.get(s.id)?.label.toLowerCase().startsWith(t.text));
        const wrap = hit >= 0 ? hit : stops.findIndex((s) => s.kind === "row" && byId.get(s.id)?.label.toLowerCase().startsWith(t.text));
        if (wrap >= 0) { e.preventDefault(); e.stopPropagation(); setCursor(wrap); }
        return;
      }
      if (e.target instanceof HTMLElement && listRef.current?.parentElement?.contains(e.target) && ownsEnter(e.key, e.target.tagName, e.target.getAttribute("role"))) return;
      const a = keyAction(e.key, stops, cursor, query !== "" && e.target instanceof HTMLInputElement);
      // Enter on a disabled row does nothing, as a click does nothing.
      if (a.do === "pick" && byId.get(a.id)?.disabled) { e.preventDefault(); return; }
      if (a.do === "none") return;
      e.preventDefault(); e.stopPropagation();
      if (e.shiftKey && a.do === "pick" && onPickAlt) { onPickAlt(a.id); return; }
      if (a.do === "move") setCursor(a.to);
      else if (a.do === "pick") onPick(a.id);
      else if (a.do === "close") onClose();
      else setOpened((s) => { const n = new Set(s); if (a.do === "open") n.add(a.key); else n.delete(a.key); return n; });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [stops, cursor, query, onPick, onPickAlt, onClose, byId, withSearch]);

  const hotId = stops[cursor]?.kind === "row" ? (stops[cursor] as { id: string }).id : null;
  const hotGroup = stops[cursor]?.kind === "group" ? (stops[cursor] as { key: string }).key : null;
  let drawn = 0;
  const row = (it: PickerItem) => (
    <div key={it.id} data-cursor={it.id === hotId} className="group" onMouseEnter={() => { const i = stops.findIndex((s) => s.kind === "row" && s.id === it.id); if (i >= 0) setCursor(i); }}>
      <ListRow onClick={() => onPick(it.id)} current={current?.has(it.id) || it.on} hot={it.id === hotId} title={it.title ?? it.label}
        role="option" aria-selected={!!(current?.has(it.id) || it.on)} disabled={it.disabled}
        aria-label={optionText(it.label, it.sub, !!(current?.has(it.id) || it.on), it.note)}
        leading={it.leading} sub={it.sub}
        trailing={<>{it.trailing}{it.on && it.markOn !== false && <span className="flex" style={{ color: "var(--success-ink)" }} aria-hidden><DoneIcon size={ICON.xs} /></span>}</>}>
        <span className={it.mono ? "font-mono" : undefined}>{it.label}</span>
      </ListRow>
    </div>
  );

  return (
    <div role="group" aria-label={label ?? `Pick a ${noun}`} className="fixed rounded-xl text-[11px] flex flex-col agx-pick-in"
      style={{
        width, maxWidth: "calc(100vw - 16px)", overflow: "hidden", zIndex: LAYER.menu,
        background: "var(--surface-card)", border: EDGE, boxShadow: "0 24px 60px -18px rgba(0,0,0,0.7)", ...style,
      }}>
      {withSearch && (
        <div className="px-2.5 pt-2.5 pb-2 shrink-0 relative">
          <span className="absolute left-5 top-1/2 -translate-y-1/2" style={{ color: "var(--text3)" }}><SearchIcon size={ICON.sm} /></span>
          <input autoFocus role="combobox" aria-expanded aria-haspopup="listbox" aria-label={placeholder} value={query}
            onChange={(e) => { setQuery(e.target.value); setCursor(0); onQuery?.(e.target.value); }} placeholder={placeholder}
            className={`w-full pl-8 pr-16 ${INPUT}`} style={INPUT_STYLE} />
          <span className="absolute right-5 top-1/2 -translate-y-1/2 tabular-nums text-[10.5px]" style={{ color: "var(--text3)", fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>
            {body === "loading" ? "…" : countLabel(ordered.length, items.length, query, picked)}
          </span>
        </div>
      )}
      <div ref={listRef} role="listbox" aria-multiselectable={multi || picked > 0 || undefined} className="agx-scroll overflow-y-auto overflow-x-hidden px-1 pb-1.5 min-h-0" style={{ maxHeight: room }}>
        {body === "loading" && (
          <div role="status" aria-label={`Reading ${noun}s`} className="px-2.5 flex flex-col gap-1.5">
            {[0, 1, 2].map((i) => <div key={i} className="rounded-lg motion-safe:animate-pulse" style={{ height: 34, background: "var(--surface-inset)", opacity: 1 - i * 0.2 }} />)}
          </div>
        )}
        {body === "error" && (
          <div role="alert" className="mx-2.5 flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-[12px]" style={{ color: "var(--error-ink)", background: "color-mix(in srgb, var(--error) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--error) 28%, transparent)" }}>
            <WarningIcon size={ICON.md} /><span className="min-w-0 flex-1">{error}</span>
            {onRetry && <Button size="compact" onClick={onRetry} className="shrink-0">Try again</Button>}
          </div>
        )}
        {body === "empty" && <div className="px-3 py-4 text-[12px] text-center" style={{ color: "var(--text3)" }}>{emptyText}</div>}
        {body === "no-match" && (
          <div className="px-3 py-4 text-center text-[12px]" style={{ color: "var(--text3)" }}>
            <div className="font-medium break-all" style={{ color: "var(--text2)" }}>No {noun} called “{query.trim()}”</div>
            <div className="mt-0.5">Check the spelling, or clear the search.</div>
          </div>
        )}
        {body === "rows" && (
          <>
            {shelf.length > 0 && (
              <div className="px-1.5 pt-1 pb-1.5">
                <div className="flex items-baseline justify-between text-[10px] uppercase tracking-wider pb-1" style={{ color: "var(--text3)" }}><span>Recent</span>{shelfNote && <span>{shelfNote}</span>}</div>
                <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${SHELF_SIZE}, minmax(0, 1fr))` }}>
                  {(shelf as PickerItem[]).map((s) => {
                    const it = byId.get(s.id)!;
                    return (
                      <button key={it.id} onClick={() => onPick(it.id)} data-tip={it.label}
                        className="relative min-w-0 text-left rounded-lg px-2 py-1.5 truncate" style={{ minHeight: HIT, border: EDGE, background: current?.has(it.id) ? "var(--surface-lift)" : "var(--surface-inset)", color: "var(--text)" }}>
                        {shelfTile ? shelfTile(it, !!current?.has(it.id)) : <>
                          <span className="block truncate text-[11.5px]">{it.label}</span>
                          {it.sub && <span className="block truncate text-[10px]" style={{ color: "var(--text3)" }}>{it.sub}</span>}</>}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {loose.slice(0, ROW_CAP).map((it) => { drawn++; return row(byId.get(it.id)!); })}
            {groups.map((g) => (
              <div key={g.key} role="group" aria-label={typeof groupLabels?.(g.key) === "string" ? (groupLabels(g.key) as string) : g.key}>
                {!foldable ? (
                  <div className="px-2.5 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wider" style={{ color: "var(--text3)", borderTop: g === groups[0] && !loose.length ? undefined : LINE }}>
                    <span className="flex items-center gap-2"><span className="min-w-0 flex-1 break-words">{groupLabels ? groupLabels(g.key) : g.key}</span>
                      <span className="tabular-nums normal-case">{g.rows.length}</span></span>
                  </div>
                ) : (
                <button onClick={() => setOpened((s) => { const n = new Set(s); if (n.has(g.key)) n.delete(g.key); else n.add(g.key); return n; })}
                  aria-expanded={g.open} data-cursor={hotGroup === g.key}
                  className="w-full flex items-center gap-2 px-2 text-left text-[11.5px] rounded-lg"
                  style={{ minHeight: 30, color: "var(--text2)", background: hotGroup === g.key ? "var(--surface-lift)" : undefined }}>
                  <span aria-hidden style={{ width: ICON.xs, display: "inline-block", transform: g.open ? "rotate(90deg)" : undefined }}>›</span>
                  <span className="min-w-0 flex-1 truncate">{groupLabels ? groupLabels(g.key) : g.key}</span>
                  <span className="tabular-nums text-[10.5px]" style={{ color: "var(--text3)" }}>{g.rows.length}</span>
                </button>
                )}
                {g.open && g.rows.slice(0, Math.max(0, ROW_CAP - drawn)).map((it) => { drawn++; return row(byId.get(it.id)!); })}
              </div>
            ))}
            {ordered.length > ROW_CAP && (
              <div className="px-3 py-1.5 text-[10.5px]" style={{ color: "var(--text3)" }}>showing {ROW_CAP} of {ordered.length} — type to find the rest</div>
            )}
          </>
        )}
      </div>
      {footer && (
        <div className="shrink-0 flex items-center gap-2 px-2.5" style={{ minHeight: 40, borderTop: LINE, background: "var(--surface-nav)" }}>
          {footer}
          {footerNote && <span className="min-w-0 flex-1 truncate text-right text-[10.5px]" style={{ color: "var(--text3)" }}>{footerNote}</span>}
        </div>
      )}
    </div>
  );
}
