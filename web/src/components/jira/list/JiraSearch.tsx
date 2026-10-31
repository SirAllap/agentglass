import { useRef, useState } from "react";
import type { ProviderTask } from "../../../../../shared/providers.ts";
import type { BoardSource } from "../../../lib/boardSource.ts";
import { SearchIcon } from "../../../lib/glyphIcons.tsx";
import { ICON } from "../../../lib/iconSize.ts";
import { CloseIcon } from "../../CloseButton.tsx";
import { Ctl } from "./ListControls.tsx";
import type { JiraListFilters, JiraListModel } from "./model.ts";
import { SearchSheet } from "./SearchSheet.tsx";
import { fetchOffered, siteSearchOffered } from "./toolbarModel.ts";
import { LINE } from "../../workspace/Chrome.tsx";

/** The search row: what is typed narrows the board as it goes; Enter (or the button) asks the whole site; a key can be fetched by itself. */
export interface JiraSearchProps {
  filters: JiraListFilters;
  onFilters: (patch: Partial<JiraListFilters>) => void;
  model?: JiraListModel;
  source?: BoardSource;
  /** Open a card the page does not hold (a hit, a fetched key) in the dock. */
  onOpenCard?: (t: ProviderTask) => void;
}

export function JiraSearch({ filters, onFilters, model, source, onOpenCard }: JiraSearchProps) {
  const [sheet, setSheet] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [miss, setMiss] = useState<string | null>(null);
  const box = useRef<HTMLInputElement>(null);
  const q = filters.query;
  const site = !!source && siteSearchOffered(q);
  const key = source ? fetchOffered(q, model?.cards ?? []) : null;

  const fetchKey = async () => {
    if (!source || !key || fetching) return;
    setFetching(true); setMiss(null);
    try {
      const r = await source.find(key);
      if (r.ok && r.task) { onOpenCard?.(r.task); onFilters({ query: "" }); } else setMiss(r.error ?? "Jira has no such card");
    } catch { setMiss("Could not reach the server"); }
    finally { setFetching(false); }
  };

  return (
    <div data-slot="search" className="flex items-center shrink-0" style={{ gap: 8, padding: "0 24px" }}>
      <div className="flex flex-1 items-center overflow-hidden" style={{
        maxWidth: 560, height: 32, gap: 8, padding: "0 8px 0 12px", borderRadius: 8, background: "var(--surface-inset)", color: "var(--text3)",
        boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--text) 14%, transparent)",
      }}>
        <SearchIcon size={ICON.md} />
        <input ref={box} value={q} spellCheck={false} aria-label="Filter this board"
          placeholder={source ? "Filter this board - Enter searches Jira" : "Filter this board"}
          onChange={(e) => { onFilters({ query: e.target.value }); setMiss(null); }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && q) { e.preventDefault(); e.stopPropagation(); onFilters({ query: "" }); return; }
            if (e.key === "Enter" && source && q.trim().length >= 2) { e.preventDefault(); setSheet(q.trim()); }
          }}
          className="flex-1 min-w-0 bg-transparent outline-none text-[12px]" style={{ color: "var(--text)", caretColor: "var(--primary)" }} />
        {q && (
          /* A segment of the field, full height and flush to its edge, so emptying it is one click. */
          <button type="button" aria-label="Clear" data-tip="Clear - Esc" onClick={() => { onFilters({ query: "" }); box.current?.focus(); }}
            className="agx-chip grid place-items-center self-stretch shrink-0"
            style={{ width: 32, marginRight: -8, borderLeft: LINE, background: "color-mix(in srgb, var(--text) 6%, transparent)", color: "var(--text3)" }}>
            <CloseIcon size={ICON.md} />
          </button>
        )}
      </div>
      {site && (
        <Ctl tip={{ name: "Search the whole Jira site", text: "Searches the title, description and comments of the cards in the projects you can see." }} onClick={() => setSheet(q.trim())}>
          search the site <kbd className="font-semibold" style={{ fontSize: 10, padding: "2px 4px", borderRadius: 4, boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--text) 14%, transparent)", color: "var(--text3)" }}>⏎</kbd>
        </Ctl>
      )}
      {key && (
        <Ctl tone="ok" disabled={fetching} onClick={() => void fetchKey()}
          tip={{ name: `Fetch ${key} from Jira`, text: "Not on this board. It opens in the card pane." }}>
          {fetching ? `Looking for ${key}…` : `Fetch card ${key} from Jira`}
        </Ctl>
      )}
      {miss && <span role="status" className="text-[11px] min-w-0 truncate" style={{ color: "var(--error-ink)" }}>{miss}</span>}
      {sheet && source && (
        <SearchSheet source={source} asked={sheet} onClose={() => { setSheet(null); box.current?.focus(); }}
          onPick={(t) => { onOpenCard?.(t); setSheet(null); }} />
      )}
    </div>
  );
}
