import { useEffect, useMemo, useRef, useState } from "react";
import type { ProviderTask } from "../../../../../shared/providers.ts";
import type { BoardSource } from "../../../lib/boardSource.ts";
import { SearchIcon } from "../../../lib/glyphIcons.tsx";
import { ICON } from "../../../lib/iconSize.ts";
import { CloseIcon } from "../../CloseButton.tsx";
import { Ctl } from "./ListControls.tsx";
import type { JiraListFilters, JiraListModel } from "./model.ts";
import { SearchSheet } from "./SearchSheet.tsx";
import { fetchOffered } from "./toolbarModel.ts";
import { CTRL_H, LINE } from "../../workspace/Chrome.tsx";
import { queryTiming } from "./tabsModel.ts";
import { askFullJql } from "../../../lib/jqlFull.ts";
import { openJiraJump } from "../../../lib/jiraQueryPalette.ts";
import { looksJql } from "./boardModel.ts";
import { jqlCursorContext } from "../../../lib/jiraJqlContext.ts";
import { applyJqlCandidate, buildCandidates, loadJqlVocab, suggestJqlValues, type JqlCandidate, type JqlVocab } from "../../../lib/jiraJqlHelp.ts";
import { JqlHelpPopover } from "./JqlHelpPopover.tsx";

const NO_VOCAB: JqlVocab = { fields: [], functions: [] };

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
  const stat = model?.queryStat && model.queryStat.q === q.trim() ? queryTiming(model.queryStat.n, model.queryStat.ms, model.queryStat) : null;
  const parseError = model?.queryError && model.queryError.q === q.trim() ? model.queryError.text : null;
  const key = source ? fetchOffered(q, model?.cards ?? []) : null;

  /* JQL goes to the site for every page; words open the site search. */
  const submit = () => { const t = q.trim(); if (looksJql(t)) askFullJql(t); else setSheet(t); };

  // --- JQL help: fields, operators, values and functions for whatever is under the caret ---
  const jqlOn = !!source && looksJql(q);
  const [vocab, setVocab] = useState<JqlVocab>(NO_VOCAB);
  const [cursor, setCursor] = useState(q.length);
  const [siteValues, setSiteValues] = useState<readonly JqlCandidate[]>([]);
  const [hot, setHot] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const pendingCaret = useRef<number | null>(null);
  const ctx = useMemo(() => jqlCursorContext(q, cursor), [q, cursor]);

  useEffect(() => {
    if (!jqlOn) return;
    let live = true;
    void loadJqlVocab().then((v) => { if (live) setVocab(v); });
    return () => { live = false; };
  }, [jqlOn]);

  useEffect(() => {
    if (!jqlOn || ctx.kind !== "value" || !ctx.field) { setSiteValues([]); return; }
    const ac = new AbortController();
    void suggestJqlValues(ctx.field, ctx.partial, ac.signal).then((rows) => { if (!ac.signal.aborted) setSiteValues(rows); });
    return () => ac.abort();
  }, [jqlOn, ctx.kind, ctx.kind === "value" ? ctx.field : "", ctx.kind === "value" ? ctx.partial : ""]); // eslint-disable-line react-hooks/exhaustive-deps

  const candidates = useMemo(() => (jqlOn ? buildCandidates(ctx, vocab, siteValues) : []), [jqlOn, ctx, vocab, siteValues]);
  /* Only while the person is writing in the box. Shown on any JQL in it, a
     saved view's tab put its query here and the list opened by itself, with
     the caret nowhere the person chose; and a box left behind (the bench
     closed over it) kept its list floating over the view. A field list before
     a letter is typed is every field the site has, alphabetical — custom
     fields first — so it waits for the first letter. */
  const [writing, setWriting] = useState(false);
  const showHelp = jqlOn && writing && !dismissed && candidates.length > 0 && !(ctx.kind === "field" && !ctx.partial);
  const helpHot = Math.min(hot, candidates.length - 1);

  useEffect(() => { if (pendingCaret.current != null) { box.current?.setSelectionRange(pendingCaret.current, pendingCaret.current); setCursor(pendingCaret.current); pendingCaret.current = null; } }, [q]);

  const pick = (c: JqlCandidate) => {
    const next = applyJqlCandidate(q, ctx, c);
    pendingCaret.current = next.cursor;
    setHot(0);
    onFilters({ query: next.text });
    box.current?.focus();
  };
  const atCursor = (e: { currentTarget: HTMLInputElement }) => setCursor(e.currentTarget.selectionStart ?? q.length);

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
    <div data-slot="search" className="flex flex-col flex-1 min-w-0" style={{ gap: 4 }}>
    <div className="flex items-center min-w-0" style={{ gap: 8 }}>
      <div className="agx-jf-search flex flex-1 min-w-0 items-center overflow-hidden" style={{
        height: CTRL_H.regular, gap: 8, padding: "0 8px 0 10px", borderRadius: 8, background: "var(--surface-inset)", color: "var(--text3)",
      }}>
        <SearchIcon size={ICON.md} />
        <input ref={box} value={q} spellCheck={false} aria-label="Filter this board"
          // The mockup's search box is a trigger, not a typing field: a mouse click opens the jump palette
          // directly (same as / or Ctrl K), skipping the site-search sheet. Typing still works once focused
          // another way (Tab), so the box's own filter/JQL-help logic below is untouched.
          onMouseDown={(e) => { e.preventDefault(); openJiraJump(); }}
          role={showHelp ? "combobox" : undefined} aria-expanded={showHelp || undefined} aria-controls={showHelp ? "jql-help" : undefined}
          // A screen reader announces the highlighted suggestion only through this; the highlight alone moves nothing for it.
          aria-activedescendant={showHelp ? `jql-help-${hot}` : undefined}
          placeholder="Search this board · Enter searches all of Jira"
          onChange={(e) => { setWriting(true); onFilters({ query: e.target.value }); setMiss(null); setDismissed(false); setCursor(e.target.selectionStart ?? e.target.value.length); }}
          // A click puts the caret in a new clause: a list dismissed with Escape for the old one comes back for it.
          onClick={(e) => { setDismissed(false); atCursor(e); }} onKeyUp={atCursor}
          onBlur={() => setWriting(false)}
          onKeyDown={(e) => {
            if (showHelp) {
              if (e.key === "ArrowDown") { e.preventDefault(); setHot((h) => Math.min(h + 1, candidates.length - 1)); return; }
              if (e.key === "ArrowUp") { e.preventDefault(); setHot((h) => Math.max(h - 1, 0)); return; }
              if (e.key === "Tab" || e.key === "Enter") { e.preventDefault(); e.stopPropagation(); pick(candidates[helpHot]!); return; }
              if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setDismissed(true); return; }
            }
            if (e.key === "Enter" && source && q.trim().length >= 2) { e.preventDefault(); submit(); return; }
            if (e.key === "Escape" && q) { e.preventDefault(); e.stopPropagation(); onFilters({ query: "" }); }
          }}
          className="flex-1 min-w-0 bg-transparent outline-none text-[12px]" style={{ color: "var(--text)", caretColor: "var(--primary)" }} />
        {showHelp && <JqlHelpPopover anchor={box} rows={candidates} hot={helpHot} onPick={pick} />}
        {!q && <span className="agx-jm-keys" aria-hidden><kbd>/</kbd></span>}
        {q && (
          /* A segment of the field, full height and flush to its edge, so emptying it is one click. */
          <button type="button" aria-label="Clear" data-tip="Clear - Esc" onClick={() => { onFilters({ query: "" }); box.current?.focus(); }}
            className="agx-chip grid place-items-center self-stretch shrink-0"
            style={{ width: 32, marginRight: -8, borderLeft: LINE, background: "color-mix(in srgb, var(--text) 6%, transparent)", color: "var(--text3)" }}>
            <CloseIcon size={ICON.md} />
          </button>
        )}
      </div>
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
    {parseError
      ? <span role="status" data-testid="jira-query-error" className="text-[10.5px]" style={{ color: "var(--error-ink)" }}>{parseError}</span>
      : stat && <span role="status" data-testid="jira-query-stat" className="tabular-nums text-[10.5px]" style={{ color: "var(--text3)" }}>{stat}</span>}
    </div>
  );
}
