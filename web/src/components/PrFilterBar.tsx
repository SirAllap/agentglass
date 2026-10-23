import { useState } from "react";
import { Avatar } from "./Avatar.tsx";
import { LAYER } from "../lib/layers.ts";
import { applyPick, atToken, loadUse, recordPicks, suggestPeople } from "../lib/personUsage.ts";
import { SEARCH_HINT, SEARCH_PLACEHOLDER } from "../lib/prSearch.ts";
import { barControls, type BarView } from "../lib/prBarView.ts";
import { ICON } from "../lib/iconSize.ts";
import { serializeQuery, toggleFacet, type FilterState, type FacetView } from "../lib/prFilter.ts";
import { SearchIcon } from "../lib/glyphIcons.tsx";
import { CloseIcon } from "./CloseButton.tsx";
import { EDGE, INPUT, INPUT_STYLE } from "./workspace/Chrome.tsx";

/**
 * The PR list's filter controls: a query input, the unread chip, the rule
 * builder and saved sets (passed in as `builder`), and a row of removable chips
 * for what is active.
 *
 * It draws a FRAGMENT, not a bar of its own: the panel's header is the one bar,
 * and these are the parts of it that belong to the filter. The chips row takes a
 * line of its own (`basis-full`) and exists only while something is narrowing.
 *
 * Every control edits ONE thing — the query string — through parse/serialize, so
 * the bar and the dropdowns are always the same filter. This component holds no
 * state; it turns clicks into new query strings and hands them up via `onQuery`.
 */
export function PrFilterBar({
  query, filters, facets, onQuery, onSearch, onPickPerson, pending, searching, shown, total, swept, builder, people, view = "board", scoped, inbox,
}: {
  /** Which view the box points at. Everything below the box is the board's and is drawn only there. */
  view?: BarView;
  /** The box for a view that is not the board: its own text, its own hint. It asks nobody on a keystroke. */
  scoped?: { value: string; onChange: (v: string) => void; placeholder: string };
  /** The inbox's two controls: which list is showing and how many are unread. */
  inbox?: { unreadOnly: boolean; onUnreadOnly: (v: boolean) => void; unread: number };
  query: string;
  /** The repository's people, already loaded by the panel. Null while they are
   *  not: typing "@" then says so instead of asking for them. */
  people?: string[] | null;
  filters: FilterState;
  facets: FacetView[];
  /** The rule builder, drawn after the pills. Passed in rather than built here
   *  so this file stays what it is — a row of controls — and the rules keep
   *  living where the rows they filter do. */
  builder?: React.ReactNode;
  onQuery: (q: string) => void;
  /** Ask GitHub. Never called on a keystroke — see PrPanel's serverQuery. */
  onSearch: () => void;
  /** Called when the `@` menu picked somebody into an otherwise empty box: that is a request for their board, not a search. */
  onPickPerson?: (login: string) => void;
  /** The box says something the last search did not ask for. */
  pending: boolean;
  searching?: boolean;
  shown: number;
  total: number;
  /** How far the background sweep has read, while free text is filtering. A
   *  count over a partial pool has to say so. */
  swept?: { rows: number; done: boolean };
}) {
  const controls = barControls(view);
  const emit = (next: FilterState) => onQuery(serializeQuery(next));

  /* "@" in the box: the repository's people, from the list the panel already
     holds. Nothing is requested here, on a keystroke or otherwise. */
  const [dismissed, setDismissed] = useState("");
  const [cursor, setCursor] = useState(0);
  const at = atToken(query);
  const suggest = at && people ? suggestPeople(people, loadUse(), at.token) : null;
  const flat = suggest ? [...suggest.frequent, ...suggest.rest] : [];
  const menuOpen = !scoped && !!at && dismissed !== query;
  const pick = (login: string) => {
    recordPicks([login]);
    const next = applyPick(query, login);
    onQuery(next);
    if (next.trim().split(/\s+/).length === 1) onPickPerson?.(login);
    setCursor(0);
  };

  // Chips mirror every active token, each with its own removal. Free text is one
  // chip (removing it strips only the words, keeping the facets).
  const chips: { key: string; label: string; onRemove: () => void }[] = [];
  for (const f of facets) {
    for (const v of f.selected) {
      const opt = f.options.find((o) => o.value === v);
      chips.push({
        key: `${f.key}:${v}`,
        label: `${f.label}: ${opt?.label ?? v}`,
        onRemove: () => emit(toggleFacet(filters, f.key, v)),
      });
    }
  }
  if (filters.text.trim()) {
    chips.push({ key: "text", label: `"${filters.text.trim()}"`, onRemove: () => emit({ ...filters, text: "" }) });
  }
  const border = "1px solid color-mix(in srgb, var(--border) 45%, transparent)";
  /* The full syntax is a popover under the box while it has focus; the box
     itself says only what Enter does, so it fits the one bar. */
  const [focused, setFocused] = useState(false);

  return (
    <>
      {/* Query input — the source of truth every pill also writes to. Grows to
          fill the line and wraps to a line of its own when the others leave it
          under 16rem, so it is never cut and nothing sits over it. */}
      <div className="agx-prbar-search flex items-center gap-1.5 min-w-0" style={{ flex: "1 1 20rem", minWidth: "16rem", maxWidth: "36rem" }}>
        {/* Said next to the box doing the filtering, because it is a caveat on
            the number of rows below it: "3 of 25 read" and "3 of 93 read" are
            different answers to the same search, and only one of them means
            there are three. */}
        {swept && (
          <span className="text-[10px] tabular-nums shrink-0 order-last"
            title={swept.done
              ? `Filtering across all ${swept.rows} pull requests in this view`
              : `Read ${swept.rows} so far — still fetching the rest of this view`}
            style={{ color: swept.done ? "var(--text4)" : "var(--warning)" }}>
            {swept.done ? `${shown} of ${swept.rows}` : `${shown} of ${swept.rows}…`}
          </span>
        )}
        <div className="relative flex-1 min-w-0">
        <input
          data-pr-filter-input
          value={scoped ? scoped.value : query}
          onChange={(e) => { setCursor(0); (scoped ? scoped.onChange : onQuery)(e.target.value); }}
          onKeyDown={(e) => {
            if (scoped) return;
            if (menuOpen && flat.length) {
              if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => (c + 1) % flat.length); return; }
              if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => (c - 1 + flat.length) % flat.length); return; }
              if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); e.stopPropagation(); pick(flat[Math.min(cursor, flat.length - 1)]!); return; }
            }
            if (menuOpen && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setDismissed(query); return; }
            if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); onSearch(); }
          }}
          role="combobox" aria-expanded={menuOpen} aria-autocomplete="list" aria-controls="pr-at-people"
          onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
          placeholder={scoped ? scoped.placeholder : SEARCH_PLACEHOLDER}
          aria-label={scoped ? scoped.placeholder : SEARCH_HINT}
          spellCheck={false}
          className={`w-full ${INPUT}`}
          style={INPUT_STYLE} />
        {focused && !menuOpen && !scoped && (
          <div role="note" className="absolute left-0 right-0 top-full mt-1 rounded-lg px-3 py-2 text-[11px] pointer-events-none"
            style={{ zIndex: LAYER.menu, border: EDGE, color: "var(--text2)", background: "color-mix(in srgb, var(--bg2) 98%, black)", boxShadow: "0 18px 44px -18px rgba(0,0,0,.8)" }}>
            {SEARCH_HINT}
          </div>
        )}
        {menuOpen && (
          <div id="pr-at-people" role="listbox" className="absolute left-0 right-0 top-full mt-1 rounded-lg overflow-y-auto agx-scroll"
            style={{ zIndex: LAYER.menu, maxHeight: 260, border: EDGE, background: "color-mix(in srgb, var(--bg2) 98%, black)", boxShadow: "0 18px 44px -18px rgba(0,0,0,.8)" }}>
            {!people ? (
              <div className="px-3 py-2 text-[11px]" style={{ color: "var(--text3)" }}>People are still loading…</div>
            ) : flat.length === 0 ? (
              <div className="px-3 py-2 text-[11px]" style={{ color: "var(--text3)" }}>Nobody matches @{at!.token}.</div>
            ) : (
              <>
                {suggest!.frequent.length > 0 && <div className="px-2.5 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wide" style={{ color: "var(--text4)" }}>Frequent</div>}
                {flat.map((login, i) => (
                  <div key={login}>
                    {i === suggest!.frequent.length && suggest!.frequent.length > 0 && <div className="px-2.5 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wide" style={{ color: "var(--text4)" }}>Everyone</div>}
                    <button role="option" aria-selected={i === cursor}
                      onMouseDown={(e) => { e.preventDefault(); pick(login); }}
                      onMouseEnter={() => setCursor(i)}
                      className="agx-mi w-full text-left flex items-center gap-2 px-2.5 py-1.5 text-[11px]"
                      style={{ color: "var(--text2)", background: i === cursor ? "color-mix(in srgb, var(--primary) 14%, transparent)" : undefined }}>
                      <Avatar login={login} size={ICON.md} />
                      <span className="truncate">{login}</span>
                    </button>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
        </div>
        {/*
          * Appears only when there is something to ask for.
          *
          * A permanently-lit Search button beside a box that already filters
          * live is a button that does nothing most of the time. This one shows
          * up the moment the box says something GitHub has not been asked, and
          * goes away again once it has — so its presence IS the message: there
          * is more behind this than the rows you can see.
          */}
        {!scoped && (pending || searching) && (
          <button
            onClick={onSearch}
            disabled={searching}
            title={searching ? "Asking GitHub…" : "Search every pull request, not just the ones loaded (⏎)"}
            className="shrink-0 text-[10px] px-2 py-1 rounded flex items-center gap-1 whitespace-nowrap"
            style={{
              color: searching ? "var(--text3)" : "var(--text)",
              background: "color-mix(in srgb, var(--primary) 18%, transparent)",
              border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)",
            }}>
            {searching ? <span className="agx-spin" aria-hidden style={{ width: 8, height: 8, borderWidth: 1.5 }} /> : <span aria-hidden className="flex"><SearchIcon size={ICON.xs} /></span>}
            <span>{searching ? "Searching" : "Search all"}</span>
          </button>
        )}
        {(scoped ? scoped.value : query).trim() && (
          <button onClick={() => (scoped ? scoped.onChange("") : onQuery(""))} title={scoped ? "Clear the filter" : "Clear all filters"} aria-label={scoped ? "Clear the filter" : "Clear all filters"}
            className="grid place-items-center w-[22px] h-[22px] rounded shrink-0 hover:bg-white/5" style={{ color: "var(--text3)", border }}>
            <CloseIcon size={ICON.xs} />
          </button>
        )}
      </div>

      {controls.inboxControls && inbox && (
        <>
          <span className="inline-flex shrink-0 rounded-md overflow-hidden" role="group" aria-label="Show" style={{ border: EDGE }}>
            {([["all", "All"], ["unread", "Unread"]] as const).map(([id, label]) => {
              const on = (id === "unread") === inbox.unreadOnly;
              return (
                <button key={id} onClick={() => inbox.onUnreadOnly(id === "unread")} aria-pressed={on}
                  className="agx-btn px-2 text-[10.5px]"
                  style={{ minHeight: 24, color: on ? "var(--text)" : "var(--text3)", fontWeight: on ? 600 : 400,
                    background: on ? "color-mix(in srgb, var(--primary) 18%, transparent)" : "transparent" }}>
                  {label}
                </button>
              );
            })}
          </span>
          {inbox.unread > 0 && (
            <span className="text-[10px] tabular-nums shrink-0" style={{ color: "var(--warning-ink)" }}>{inbox.unread} unread</span>
          )}
        </>
      )}
        {/* No row of pills: the builder is the filter, and it says everything
            they said plus `is not`, `is set`, `is not set`, and several joined.
            It reads the same field table (`builderFields` reads `buildFacets`),
            so every menu they had is a field in it, and a query string still
            fills it through `queryToRules`. */}
        {controls.boardControls && builder}

      {/* Active-filter chips + count. Only when something is narrowing the list. */}
      {controls.boardControls && chips.length > 0 && (
        <div className="agx-prbar-chips flex flex-wrap items-center gap-1 basis-full">
          {chips.map((c) => (
            <button key={c.key} onClick={c.onRemove}
              className="text-[9.5px] pl-2 pr-1 py-0.5 rounded-full flex items-center gap-1 hover:opacity-80"
              style={{ color: "var(--text2)", background: "color-mix(in srgb, var(--primary) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 28%, transparent)" }}>
              <span className="truncate max-w-[140px]">{c.label}</span>
              <span aria-hidden className="flex" style={{ color: "var(--text3)" }}><CloseIcon size={ICON.xs} /></span>
            </button>
          ))}
          <button onClick={() => onQuery("")} className="text-[9.5px] px-1.5 py-0.5 rounded-full hover:bg-white/5" style={{ color: "var(--text3)" }}>
            Clear all
          </button>
          <span className="ml-auto text-[10px] tabular-nums shrink-0" style={{ color: "var(--text3)" }}>{total} match{total === 1 ? "" : "es"}</span>
        </div>
      )}
    </>
  );
}
