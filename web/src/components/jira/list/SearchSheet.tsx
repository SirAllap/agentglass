/*
 * The results sheet of "search the site": one text box on top, the cards Jira found under it, arrows and Enter to open
 * one, Escape to close. A typed key is also asked for by itself (`source.find`), so the card the person meant comes first
 * even when a text search would not rank it. A newer ask drops the older one (an abort and a ticket), so the answer that
 * lands is the one for what is in the box.
 */
import { useEffect, useRef, useState } from "react";
import type { ProviderTask } from "../../../../../shared/providers.ts";
import type { BoardSource } from "../../../lib/boardSource.ts";
import { looksLikeCardId } from "../../../lib/boardGroups.ts";
import { SearchIcon } from "../../../lib/glyphIcons.tsx";
import { ICON } from "../../../lib/iconSize.ts";
import { LAYER } from "../../../lib/layers.ts";
import { Portal } from "../../Portal.tsx";
import { CloseIcon } from "../../CloseButton.tsx";
import { ListIconBtn } from "./ListControls.tsx";
import { hitReason } from "./toolbarModel.ts";

const DEBOUNCE_MS = 400;

export function SearchSheet({ source, asked, onPick, onClose }: {
  source: BoardSource;
  asked: string;
  onPick: (t: ProviderTask) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(asked);
  const [query, setQuery] = useState(asked);
  const [rows, setRows] = useState<ProviderTask[]>([]);
  const [state, setState] = useState<{ looking: boolean; error?: string; ms?: number }>({ looking: true });
  const [hot, setHot] = useState(0);
  const ticket = useRef(0);

  /* What is typed becomes the question after a pause, not on every key: each one is a request to the site. */
  useEffect(() => {
    const t = text.trim();
    if (t === query || t.length < 2) return;
    const timer = setTimeout(() => setQuery(t), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, query]);

  useEffect(() => {
    const run = ++ticket.current;
    const ac = new AbortController();
    const t0 = performance.now();
    setState({ looking: true });
    setRows([]);
    setHot(0);
    const live = () => run === ticket.current && !ac.signal.aborted;
    const byKey = looksLikeCardId(query, true, true)
      ? source.find(query, ac.signal).then((w) => { if (live() && w.ok && w.task) setRows((cur) => (cur.some((x) => x.id === w.task!.id) ? cur : [w.task!, ...cur])); }).catch(() => {})
      : Promise.resolve();
    void source.search(query, false, ac.signal).then(async (r) => {
      await byKey;
      if (!live()) return;
      if (r.ok) setRows((cur) => [...cur, ...(r.tasks ?? []).filter((x) => !cur.some((c) => c.id === x.id))]);
      setState({ looking: false, ms: Math.round(performance.now() - t0), ...(r.ok ? {} : { error: r.error ?? "That search could not run" }) });
    }).catch(() => { if (live()) setState({ looking: false, error: "Could not reach the server" }); });
    return () => ac.abort();
  }, [source, query]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); return; }
      if (e.key === "ArrowDown") { e.preventDefault(); setHot((h) => Math.min(h + 1, rows.length - 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setHot((h) => Math.max(h - 1, 0)); return; }
      if (e.key !== "Enter") return;
      e.preventDefault();
      /* Enter searches what was typed until it has been searched; only then does it open the row. */
      const typed = text.trim();
      if (typed.length >= 2 && typed !== query) { setQuery(typed); return; }
      const t = rows[hot];
      if (t) onPick(t);
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [rows, hot, text, query, onPick, onClose]);

  const n = rows.length;
  const line = state.looking ? "Searching Jira…"
    : state.error ? state.error
    : n ? `${n} ${n === 1 ? "result" : "results"} across the site${state.ms != null ? ` · ${state.ms} ms` : ""}`
    : `Nothing on the site mentions “${query}”.`;

  return (
    <Portal find z={LAYER.viewer}>
      <div className="fixed inset-0 flex justify-center" style={{ background: "color-mix(in srgb, var(--shadow) 35%, transparent)", paddingTop: "12vh" }}
        onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div role="dialog" aria-modal="true" aria-label="Search the whole Jira site" className="flex flex-col self-start"
          style={{ width: "min(720px, 92vw)", maxHeight: "70vh", borderRadius: 14, background: "var(--bg)", boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--text) 12%, transparent), 0 30px 60px -24px var(--shadow)" }}>
          <div className="flex items-center shrink-0" style={{ gap: 8, padding: "16px 16px 12px", color: "var(--text3)" }}>
            <SearchIcon size={ICON.md} />
            <div className="flex-1 min-w-0 flex items-center" style={{ height: 32, padding: "0 10px", borderRadius: 8, background: "var(--surface-inset)", boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--text) 14%, transparent)" }}>
              <input autoFocus value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} aria-label="Search the whole Jira site"
                placeholder="Search the whole Jira site" className="flex-1 min-w-0 bg-transparent outline-none text-[12px]" style={{ color: "var(--text)", caretColor: "var(--primary)" }} />
            </div>
            <ListIconBtn label="Close (Esc)" onClick={onClose}><CloseIcon size={ICON.md} /></ListIconBtn>
          </div>
          <div role="status" className="shrink-0" style={{ padding: "0 16px 4px", fontSize: 11, color: state.error ? "var(--error-ink)" : "var(--text3)" }}>{line}</div>
          <div className="agx-scroll min-h-0 overflow-y-auto flex flex-col" style={{ padding: "4px 16px 16px", gap: 2 }} role="listbox" aria-label="Results">
            {rows.map((t, i) => (
              <button key={t.id} type="button" role="option" aria-selected={i === hot}
                onMouseEnter={() => setHot(i)} onClick={() => onPick(t)}
                className="flex items-center text-left min-w-0"
                style={{ gap: 8, height: 36, padding: "0 12px", borderRadius: 8, fontSize: 12, background: i === hot ? "color-mix(in srgb, var(--text) 6%, transparent)" : "transparent" }}>
                <span className="shrink-0 tabular-nums" style={{ fontSize: 10.5, padding: "2px 6px", borderRadius: 5, boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--text) 14%, transparent)" }}>{t.customId ?? t.id}</span>
                <span className="min-w-0 flex-1 truncate" style={{ color: "var(--text)" }}>{t.title}</span>
                <span className="shrink-0 truncate" style={{ fontSize: 11, color: "var(--text3)", maxWidth: 220 }}>{[t.list, hitReason(t, query)].filter(Boolean).join(" · ")}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </Portal>
  );
}
