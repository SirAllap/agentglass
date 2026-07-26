import { FacetMenu } from "./FacetMenu.tsx";
import {
  serializeQuery, toggleFacet, clearFacet, setSort, DEFAULT_SORT, SORT_OPTIONS,
  type FilterState, type FacetView, type SortTok,
} from "../lib/prFilter.ts";

/**
 * The PR list's filter bar (#pulldash-style): a query input, a wrapping row of
 * GitHub-style facet pills, a Sort pill, and a row of removable chips for what
 * is active.
 *
 * Every control edits ONE thing — the query string — through parse/serialize, so
 * the bar and the dropdowns are always the same filter. This component holds no
 * state; it turns clicks into new query strings and hands them up via `onQuery`.
 */
export function PrFilterBar({
  query, filters, facets, onQuery, checksPending, shown, total,
}: {
  query: string;
  filters: FilterState;
  facets: FacetView[];
  onQuery: (q: string) => void;
  /** Second-pass check states still loading — the Checks menu says so. */
  checksPending?: boolean;
  shown: number;
  total: number;
}) {
  const emit = (next: FilterState) => onQuery(serializeQuery(next));

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

  return (
    <div className="px-2 py-1.5 border-b shrink-0 flex flex-col gap-1.5" style={{ borderColor: "color-mix(in srgb, var(--border) 25%, transparent)" }}>
      {/* Query input — the source of truth every pill also writes to. */}
      <div className="flex items-center gap-1.5">
        <input
          data-pr-filter-input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Filter, e.g. author:me label:bug is:draft"
          spellCheck={false}
          className="flex-1 text-[10px] px-2 py-1 rounded bg-transparent min-w-0"
          style={{ color: "var(--text2)", border, outline: "none" }} />
        {query.trim() && (
          <button onClick={() => onQuery("")} title="Clear all filters" aria-label="Clear all filters"
            className="text-[11px] px-1.5 py-0.5 rounded shrink-0 hover:bg-white/5" style={{ color: "var(--text3)", border }}>
            ×
          </button>
        )}
      </div>

      {/* Facet pills — wrap in the narrow sidebar; each menu floats via a Portal. */}
      <div className="flex flex-wrap items-center gap-1">
        {facets.map((f) => (
          <FacetMenu
            key={f.key}
            label={f.label}
            options={f.options}
            selected={f.selected}
            onToggle={(v) => emit(toggleFacet(filters, f.key, v))}
            onClear={() => emit(clearFacet(filters, f.key))}
            note={f.key === "checks" && checksPending ? "Checks are still loading; unfinished rows are kept." : undefined}
          />
        ))}
        <div className="ml-auto">
          <FacetMenu
            label="Sort"
            mode="radio"
            align="right"
            pillActive={filters.sort !== DEFAULT_SORT}
            options={SORT_OPTIONS.map((o) => ({ value: o.value, label: o.label, count: 0 }))}
            selected={[filters.sort]}
            onToggle={(v) => emit(setSort(filters, v as SortTok))}
            onClear={() => emit(setSort(filters, DEFAULT_SORT))}
          />
        </div>
      </div>

      {/* Active-filter chips + count. Only when something is narrowing the list. */}
      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {chips.map((c) => (
            <button key={c.key} onClick={c.onRemove}
              className="text-[9.5px] pl-2 pr-1 py-0.5 rounded-full flex items-center gap-1 hover:opacity-80"
              style={{ color: "var(--text2)", background: "color-mix(in srgb, var(--primary) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 28%, transparent)" }}>
              <span className="truncate max-w-[140px]">{c.label}</span>
              <span aria-hidden style={{ color: "var(--text3)" }}>×</span>
            </button>
          ))}
          <button onClick={() => onQuery("")} className="text-[9.5px] px-1.5 py-0.5 rounded-full hover:bg-white/5" style={{ color: "var(--text3)" }}>
            Clear all
          </button>
          <span className="ml-auto text-[9px] tabular-nums shrink-0" style={{ color: "var(--text3)" }}>{total} match{total === 1 ? "" : "es"}</span>
        </div>
      )}
    </div>
  );
}
