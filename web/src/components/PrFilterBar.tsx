import { useLayoutEffect, useRef, useState } from "react";
import { Avatar } from "./Avatar.tsx";
import { LAYER } from "../lib/layers.ts";
import { applyPick, atToken, loadUse, recordPicks, suggestPeople } from "../lib/personUsage.ts";
import { completePerson, joinPersonTokens, partialPerson, splitPersonTokens, type PersonToken } from "../lib/personTokens.ts";
import { SEARCH_HINT, searchPlaceholder } from "../lib/prSearch.ts";
import { barControls, type BarView } from "../lib/prBarView.ts";
import { ICON } from "../lib/iconSize.ts";
import { serializeQuery, toggleFacet, type FilterState, type FacetView } from "../lib/prFilter.ts";
import { SearchIcon, StarIcon } from "../lib/glyphIcons.tsx";
import { focusItems, type SearchFocus } from "../lib/useSearchFocus.ts";
import { SearchFocusPanel } from "./prs/SearchFocusPanel.tsx";
import { CloseIcon } from "./CloseButton.tsx";
import { BAR_CTRL, BAR_ICON, BAR_INPUT, BAR_SQUARE, CHIP_SURFACE, EDGE, INPUT_STYLE, chipTone } from "./workspace/Chrome.tsx";

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
  query, filters, facets, onQuery, onSearch, onPickPerson, pending, searching, shown, total, swept, people, names, view = "board", focus, repo,
}: {
  /** The repository the box searches, named in its placeholder. */
  repo?: string;
  /** Which view the box points at. Everything below the box is the board's and is drawn only there. */
  view?: BarView;
  /** Recent and saved searches and the people followed, offered while the box has focus and is empty. */
  focus?: SearchFocus;
  query: string;
  /** The repository's people, already loaded by the panel. Null while they are
   *  not: typing "@" then says so instead of asking for them. */
  people?: string[] | null;
  /** Display names GitHub gave, by lower-case login: shown beside a chip's login when known. Nothing is asked for them. */
  names?: ReadonlyMap<string, string>;
  filters: FilterState;
  facets: FacetView[];
  onQuery: (q: string) => void;
  /** Ask GitHub. Never called on a keystroke — see PrPanel's serverQuery. */
  onSearch: () => void;
  /** Called when the `@` menu picked somebody into an otherwise empty box: that is a request for their board, not a search. */
  onPickPerson?: (login: string) => void;
  /** The box says something the last search did not ask for. */
  pending: boolean;
  searching?: boolean;
  shown: number;
  /** Null while the count is still being read: a dash, never a 0 that has not been checked. */
  total: number | null;
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
  const [focused, setFocused] = useState(false);
  /* What the last keystroke wrote, until the box loses focus. A query that is anything else (a picked person, a recent search, a box left) was not being typed, so every token in it is whole. */
  const typed = useRef<string | null>(null);
  const { people: chipsOf, rest } = splitPersonTokens(query, query === typed.current);
  const at = atToken(rest);
  const part = partialPerson(rest);
  const suggest = (at || part) && people ? suggestPeople(people, loadUse(), (at ?? part)!.token) : null;
  const flat = suggest ? [...suggest.frequent, ...suggest.rest] : [];
  const menuOpen = !!(at || part) && dismissed !== query;
  const setQuery = (q: string, wasTyped: boolean) => { typed.current = wasTyped ? q : null; onQuery(q); };
  const dropChip = (i: number) => setQuery(joinPersonTokens(chipsOf.filter((_, j) => j !== i), rest), false);
  /* The chips sit over the left of the field; the field's text starts after them. */
  const chipRow = useRef<HTMLDivElement>(null);
  const [chipPad, setChipPad] = useState(0);
  useLayoutEffect(() => { setChipPad(chipsOf.length ? (chipRow.current?.offsetWidth ?? 0) + 12 : 0); }, [chipsOf.map((c) => c.role + c.login).join(" "), names]);
  const pick = (login: string) => {
    recordPicks([login]);
    const next = joinPersonTokens(chipsOf, at ? applyPick(rest, login) : completePerson(rest, login));
    setQuery(next, false);
    if (next.trim().split(/\s+/).length === 1) onPickPerson?.(login);
    setCursor(0);
  };

  // Chips mirror every active token, each with its own removal. Free text is one
  // chip (removing it strips only the words, keeping the facets).
  const chips: { key: string; label: string; login?: string; onRemove: () => void }[] = [];
  for (const f of facets) {
    for (const v of f.selected) {
      const opt = f.options.find((o) => o.value === v);
      chips.push({
        key: `${f.key}:${v}`,
        label: `${f.label}: ${opt?.label ?? v}`,
        ...(PEOPLE_FACETS.has(f.key) ? { login: v } : null),
        onRemove: () => emit(toggleFacet(filters, f.key, v)),
      });
    }
  }
  if (filters.text.trim()) {
    chips.push({ key: "text", label: `"${filters.text.trim()}"`, onRemove: () => emit({ ...filters, text: "" }) });
  }
  /* The full syntax is a popover under the box while it has focus; the box
     itself says only what Enter does, so it fits the one bar. */
  /* The focus panel: open while the box has focus and nothing is typed. Escape
     closes it until the box is focused again or typed in; Up and Down walk it
     (it is a menu), and nothing outside it. */
  const [panelShut, setPanelShut] = useState(false);
  const [row, setRow] = useState(-1);
  const items = focus ? focusItems(focus) : [];
  const panelOpen = focused && !!focus && !menuOpen && !query.trim() && !panelShut && items.length > 0;
  const activate = (i: number) => {
    const it = items[i];
    if (!it || !focus) return;
    setRow(-1);
    if (it.kind === "person") focus.openPerson(it.value); else focus.run(it.value);
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (panelOpen) {
      if (e.key === "ArrowDown") { e.preventDefault(); setRow((r) => (r + 1) % items.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setRow((r) => (r <= 0 ? items.length - 1 : r - 1)); return; }
      if (e.key === "Enter" && row >= 0) { e.preventDefault(); e.stopPropagation(); activate(row); return; }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setPanelShut(true); setRow(-1); return; }
      /* The pin, remove and Clear recent buttons take no focus (the box keeps it), so the highlighted row has its own keys. */
      const it = row >= 0 ? items[row] : undefined;
      if (it && it.kind !== "person" && e.key === "Enter" && e.shiftKey) { e.preventDefault(); e.stopPropagation(); focus!.pin(it.value); return; }
      if (it && it.kind === "recent" && e.key === "Delete") { e.preventDefault(); e.stopPropagation(); (e.shiftKey ? focus!.clearRecent : () => focus!.remove(it.value))(); setRow(-1); return; }
    }
    if (menuOpen && flat.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => (c + 1) % flat.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => (c - 1 + flat.length) % flat.length); return; }
      /* The follow star takes no focus either: Shift+Enter on the highlighted person is the star. */
      if (e.key === "Enter" && e.shiftKey && focus) { e.preventDefault(); e.stopPropagation(); focus.toggleFollow(flat[Math.min(cursor, flat.length - 1)]!); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); e.stopPropagation(); pick(flat[Math.min(cursor, flat.length - 1)]!); return; }
    }
    if (e.key === "Backspace" && rest === "" && chipsOf.length && e.currentTarget.selectionStart === 0) { e.preventDefault(); dropChip(chipsOf.length - 1); return; }
    if (menuOpen && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setDismissed(query); return; }
    if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); onSearch(); }
  };

  return (
    <>
      {/* Query input — the source of truth every pill also writes to. Grows to
          fill the line and wraps to a line of its own when the others leave it
          under 16rem, so it is never cut and nothing sits over it. */}
      <div className="agx-prbar-search flex items-center gap-1.5 min-w-0" style={{ flex: "1 1 20rem", minWidth: "16rem", maxWidth: 520 }}>
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
          value={rest}
          onChange={(e) => { setCursor(0); setRow(-1); setPanelShut(false); setQuery(joinPersonTokens(chipsOf, e.target.value), true); }}
          onKeyDown={onKey}
          role="combobox" aria-expanded={menuOpen || panelOpen} aria-autocomplete="list" aria-controls={panelOpen ? "pr-search-focus" : "pr-at-people"}
          onFocus={() => { setFocused(true); setPanelShut(false); setRow(-1); }} onBlur={() => { typed.current = null; setFocused(false); }}
          placeholder={chipsOf.length ? "Add words or another person" : searchPlaceholder(repo)}
          aria-label={SEARCH_HINT}
          spellCheck={false}
          className={`w-full ${BAR_INPUT}`}
          style={{ ...INPUT_STYLE, paddingRight: 28, ...(chipPad ? { paddingLeft: chipPad } : null) }} />
        {chipsOf.length > 0 && (
          <div ref={chipRow} data-person-chips className="absolute left-1.5 top-1/2 -translate-y-1/2 flex items-center gap-1 max-w-[70%] overflow-hidden">
            {chipsOf.map((c, i) => <PersonChip key={c.role + c.login} c={c} name={names?.get(c.login.toLowerCase())} onRemove={() => dropChip(i)} />)}
          </div>
        )}
        {/* "/" focuses the box from anywhere on the list (PrPanel's onListKey); said while there is nothing typed to hide it. */}
        {!query && <kbd aria-hidden className="agx-kbd absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none">/</kbd>}
        {/* The clear sits inside the box, as drawn, where the "/" hint was. */}
        {query.trim() && (
          <button onClick={() => onQuery("")} title="Clear all filters" aria-label="Clear all filters"
            className="agx-hover absolute right-1.5 top-1/2 -translate-y-1/2 grid place-items-center rounded" style={{ width: 20, height: 20, color: "var(--text3)" }}>
            <CloseIcon size={ICON.xs} />
          </button>
        )}
        {panelOpen && focus && <SearchFocusPanel focus={focus} cursor={row} />}
        {focused && !menuOpen && !panelOpen && !panelShut && (
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
                      {focus && (
                        <span role="button" tabIndex={-1} aria-pressed={focus.isFollowed(login)}
                          aria-label={focus.isFollowed(login) ? `Unfollow ${login}` : `Follow ${login}`}
                          title={focus.isFollowed(login) ? "Unfollow" : "Follow: one click to their board"}
                          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); focus.toggleFollow(login); }}
                          className="agx-btn ml-auto grid place-items-center rounded-md shrink-0"
                          style={{ width: ICON.md + 8, height: ICON.md + 8, color: focus.isFollowed(login) ? "var(--warning)" : "var(--text4)" }}>
                          <StarIcon size={BAR_ICON} filled={focus.isFollowed(login)} />
                        </span>
                      )}
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
        {(pending || searching) && (
          <button
            onClick={onSearch}
            disabled={searching}
            title={searching ? "Asking GitHub…" : "Search every pull request, not just the ones loaded (⏎)"}
            className={`agx-btn ${BAR_CTRL}`}
            style={{
              color: searching ? "var(--text3)" : "var(--text)",
              background: "color-mix(in srgb, var(--primary) 18%, transparent)",
              border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)",
            }}>
            {searching ? <span className="agx-spin" aria-hidden style={{ width: BAR_ICON - 4, height: BAR_ICON - 4, borderWidth: 1.5 }} /> : <span aria-hidden className="flex"><SearchIcon size={BAR_ICON} /></span>}
            <span>{searching ? "Searching" : "Search all"}</span>
          </button>
        )}
        {/* Always there once the box is a search, as drawn: it can pin what is typed before it has run, so it waits for text and not for a first search. */}
        {focus && (
          <button onClick={() => focus.pin(query)} aria-pressed={focus.isPinned(query)} disabled={!query.trim()}
            title={focus.isPinned(query) ? "Unpin this search" : "Pin this search"}
            aria-label={focus.isPinned(query) ? "Unpin this search" : "Pin this search"}
            className={`agx-btn ${BAR_SQUARE} disabled:opacity-40`}
            style={{ ...CHIP_SURFACE, color: focus.isPinned(query) ? "var(--primary-ink)" : "var(--text3)", cursor: query.trim() ? "pointer" : "not-allowed" }}>
            <StarIcon size={BAR_ICON} filled={focus.isPinned(query)} />
          </button>
        )}
      </div>

      {/* Active-filter chips + count. Only when something is narrowing the list. */}
      {/* A typed query is already in the box, with its own ×, and the results banner has the way back: a row repeating it is drawn only when a facet or rule narrows the list as well. */}
      {controls.boardControls && chips.some((c) => c.key !== "text") && (
        <div className="agx-prbar-chips flex flex-wrap items-center gap-1 basis-full">
          {chips.map((c) => (
            <button key={c.key} onClick={c.onRemove} className={`agx-btn ${BAR_CTRL}`}
              style={{ ...chipTone(true), color: "var(--text2)" }}>
              {c.login && <Avatar login={c.login} size={ICON.md} />}
              <span className="truncate max-w-[140px]">{c.label}</span>
              <span aria-hidden className="flex" style={{ color: "var(--text3)" }}><CloseIcon size={BAR_ICON} /></span>
            </button>
          ))}
          <button onClick={() => onQuery("")} className={`agx-btn ${BAR_CTRL}`} style={{ ...CHIP_SURFACE, color: "var(--text3)" }}>
            Clear all
          </button>
          <span className="ml-auto text-[11px] tabular-nums shrink-0" style={{ color: "var(--text3)" }}>{total == null ? "…" : `${total} match${total === 1 ? "" : "es"}`}</span>
        </div>
      )}
    </>
  );
}

/** The facets whose values are GitHub logins: their chip below the box carries the face too. */
const PEOPLE_FACETS = new Set(["authors", "assignees", "reviewers"]);

/** One person in the box: the face, the login, the display name when GitHub gave one, and the way out. */
function PersonChip({ c, name, onRemove }: { c: PersonToken; name?: string; onRemove: () => void }) {
  return (
    <span data-person-chip={c.login} title={`${c.role}: ${c.login}${name ? ` (${name})` : ""}`}
      className="inline-flex items-center gap-1 rounded-md pl-1 pr-0.5 h-[22px] text-[11px] min-w-0 shrink-0"
      style={{ ...chipTone(true), color: "var(--text2)" }}>
      <Avatar login={c.login} size={ICON.sm} />
      <span className="truncate max-w-[110px]">{c.login}</span>
      {name && <span className="truncate max-w-[90px]" style={{ color: "var(--text3)" }}>{name}</span>}
      <button type="button" tabIndex={-1} onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onRemove(); }}
        aria-label={`Remove ${c.role}:${c.login}`} title="Remove"
        className="agx-hover grid place-items-center rounded shrink-0" style={{ width: 18, height: 18, color: "var(--text3)" }}>
        <CloseIcon size={ICON.xs} />
      </button>
    </span>
  );
}
