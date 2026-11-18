import { useEffect, useState } from "react";
import { INPUT, INPUT_STYLE } from "../../workspace/Chrome.tsx";
import { addItem, entries, joinList, parseList, removeItem, type ListValidate } from "./listEdit.ts";
import { listSave } from "./useInstantSave.ts";
import { ICON, HIT } from "../../../lib/iconSize.ts";
import { LoosenConfirm } from "./LoosenGate.tsx";

/** One item per line, an Add field, x to remove. Each change saves at once with Undo. */
export function ListEditor({ value, onSave, validate, label, placeholder, loosens, resetKey }: {
  /** The stored string, one rule per line. Saved back in the same format. */
  value: string;
  /** `before` is the value being replaced, so a save and its Undo each diff against the right side. */
  onSave: (next: string, before: string) => void;
  validate?: ListValidate;
  label: string;
  placeholder?: string;
  /** Says in plain words what a change would loosen (the "x" of "Workers can x"), or null when it only narrows. A loosening change asks first. */
  loosens?: (before: string, next: string) => string | null;
  /** When this changes (a new project or scope), an open question is dropped: its pending value was built for the old one. */
  resetKey?: string;
}) {
  const items = parseList(value);
  const [ask, setAsk] = useState<{ next: string; what: string; undo?: boolean } | null>(null);
  useEffect(() => { setAsk(null); }, [resetKey, value]);
  const save = (next: string[]) => {
    const to = joinList(next);
    const what = loosens?.(value, to) ?? null;
    if (what !== null) { setAsk({ next: to, what }); return; }
    setAsk(null);
    // Undo puts the old list back, and putting back a dropped refusal loosens: it asks the same question.
    listSave(value, to, (v, before) => {
      const back = v === to ? null : (loosens?.(to, v) ?? null);
      if (back === null) onSave(v, before); else setAsk({ next: v, what: back, undo: true });
    });
  };
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = () => {
    const r = addItem(items, draft, validate);
    if (!r.ok) { setError(r.error); return; }
    setError(null); setDraft("");
    save(r.list);
  };
  return (
    <div className="flex flex-col gap-1.5" role="group" aria-label={label}>
      {entries(items, validate).map(({ item: it, error: bad }, i) => (
        <div key={`${i}:${it}`} className="flex items-center gap-2">
          <span className="text-[12px] font-mono flex-1 truncate" data-tip={it} style={{ color: "var(--text)" }}>{it}</span>
          {bad && <span className="text-[11px]" style={{ color: "var(--error)" }}>{bad}</span>}
          <button
            type="button"
            aria-label={`Remove ${it}`}
            data-tip="Remove"
            onClick={() => save(removeItem(items, it))}
            className="grid place-items-center rounded-md"
            style={{ width: HIT, height: HIT, color: "var(--text3)" }}
          >
            <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" /></svg>
          </button>
        </div>
      ))}
      <input
        aria-label={`Add to ${label}`}
        aria-invalid={error ? true : undefined}
        value={draft}
        placeholder={placeholder ?? "Add a rule, press Enter"}
        onChange={(e) => { setDraft(e.target.value); setError(null); }}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
        className={`${INPUT} font-mono`}
        style={error ? { ...INPUT_STYLE, boxShadow: "inset 0 0 0 1px var(--error)" } : INPUT_STYLE}
      />
      {error && <span role="alert" className="text-[11px]" style={{ color: "var(--error)" }}>{error}</span>}
      {ask && <LoosenConfirm what={ask.what} onCancel={() => setAsk(null)} onAllow={() => { const { next: n, undo } = ask; setAsk(null); if (undo) onSave(n, value); else listSave(value, n, onSave); }} />}
    </div>
  );
}
