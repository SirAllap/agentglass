/*
 * The view builder: one sheet to write a Jira search and keep it as a view. Start from a recipe, add a clause with
 * one click, pick a sort, and the box under the caret offers the site's own fields, operators and values (the same
 * help the search box gives). Jira counts the search as it changes, so a wrong one says why before it is saved, and a
 * right one says how many cards it holds. "Try on board" shows it without keeping it; "Save view" keeps it as a tab.
 *
 * Before this the only way to a view was to type JQL into the search box blind — a click on that box opens the jump
 * palette — and press a "+" that stayed off until the text already looked like JQL.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { INPUT, INPUT_STYLE, LINE } from "../../workspace/Chrome.tsx";
import { StateChip } from "../DockParts.tsx";
import { DoneIcon, WarningIcon } from "../../../lib/glyphIcons.tsx";
import { HIT, ICON } from "../../../lib/iconSize.ts";
import { jqlCursorContext } from "../../../lib/jiraJqlContext.ts";
import { applyJqlCandidate, buildCandidates, loadJqlVocab, suggestJqlValues, type JqlCandidate, type JqlVocab } from "../../../lib/jiraJqlHelp.ts";
import { addClause, JQL_ORDERS, JQL_PARTS, JQL_RECIPES, orderOf, withOrder } from "../../../lib/jqlRecipes.ts";
import { LAYER } from "../../../lib/layers.ts";
import { tipAttr } from "../../../lib/tip.ts";
import { useJqlCheck } from "../../../lib/useJqlCheck.ts";
import { CloseIcon } from "../../CloseButton.tsx";
import { Portal } from "../../Portal.tsx";
import { JqlHelpPopover } from "./JqlHelpPopover.tsx";
import { Ctl, ListIconBtn } from "./ListControls.tsx";

const NO_VOCAB: JqlVocab = { fields: [], functions: [] };

const SECTION: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: "var(--text2)", margin: "0 0 6px" };
const CHIP: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 6, height: HIT, padding: "0 10px", borderRadius: 7, fontSize: 12,
  background: "var(--surface-card)", color: "var(--text)", boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--text) 12%, transparent)",
};

export function JqlBuilder({ initial, initialName = "", editing = false, suggestName, onTry, onSave, onClose }: {
  initial: string;
  initialName?: string;
  /** An existing view: Save writes its search and name back rather than adding a tab. */
  editing?: boolean;
  /** A name from the search, until the person types their own. */
  suggestName: (jql: string) => string;
  onTry: (jql: string) => void;
  onSave: (jql: string, name: string) => Promise<{ ok: boolean; error?: string }>;
  onClose: () => void;
}) {
  const [jql, setJql] = useState(initial);
  const [name, setName] = useState(initialName);
  const [cursor, setCursor] = useState(initial.length);
  const [vocab, setVocab] = useState<JqlVocab>(NO_VOCAB);
  const [siteValues, setSiteValues] = useState<readonly JqlCandidate[]>([]);
  const [hot, setHot] = useState(0);
  const [helpOff, setHelpOff] = useState(false);
  const [focused, setFocused] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  const caretNext = useRef<number | null>(null);

  useEffect(() => { let live = true; void loadJqlVocab().then((v) => { if (live) setVocab(v); }); return () => { live = false; }; }, []);
  useEffect(() => { box.current?.focus(); box.current?.setSelectionRange(initial.length, initial.length); }, [initial]);
  useEffect(() => {
    if (caretNext.current == null) return;
    const at = caretNext.current; caretNext.current = null;
    box.current?.focus(); box.current?.setSelectionRange(at, at); setCursor(at); setHelpOff(false);
  }, [jql]);

  const ctx = useMemo(() => jqlCursorContext(jql, cursor), [jql, cursor]);
  useEffect(() => {
    if (ctx.kind !== "value" || !ctx.field) { setSiteValues([]); return; }
    const ac = new AbortController();
    void suggestJqlValues(ctx.field, ctx.partial, ac.signal).then((r) => { if (!ac.signal.aborted) setSiteValues(r); });
    return () => ac.abort();
  }, [ctx.kind, ctx.kind === "value" ? ctx.field : "", ctx.kind === "value" ? ctx.partial : ""]); // eslint-disable-line react-hooks/exhaustive-deps
  /* At the start of a clause, before a letter: the fields views are made of, each saying what it is, not the site's
     whole alphabetical list with its custom fields first. */
  const rows = useMemo<JqlCandidate[]>(() => {
    if (ctx.kind === "field" && !ctx.partial) return JQL_PARTS.map((p) => ({ value: p.field, display: p.label, hint: p.hint }));
    return buildCandidates(ctx, vocab, siteValues);
  }, [ctx, vocab, siteValues]);
  const showHelp = focused && !helpOff && rows.length > 0;
  const hotRow = Math.min(hot, rows.length - 1);

  const { check, preview } = useJqlCheck(jql);

  const set = (text: string, at: number) => { caretNext.current = at; setJql(text); setHot(0); setSaveErr(""); };
  const pick = (c: JqlCandidate) => { const n = applyJqlCandidate(jql, ctx, c); set(n.text, n.cursor); };
  const order = orderOf(jql);
  const finalName = name.trim() || (jql.trim() ? suggestName(jql.trim()) : "");
  const canSave = !!jql.trim() && check.s !== "bad" && !saving;
  const save = async () => {
    if (!canSave) return;
    setSaving(true); setSaveErr("");
    const r = await onSave(jql.trim(), finalName).catch(() => ({ ok: false, error: "Could not reach the server" }));
    setSaving(false);
    if (r.ok) onClose(); else setSaveErr(r.error || "Could not save the view");
  };

  return (
    <Portal find z={LAYER.viewer}>
      <div className="fixed inset-0 flex justify-center" style={{ background: "color-mix(in srgb, var(--shadow) 35%, transparent)", padding: "8vh 16px" }}
        onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
        onKeyDown={(e) => { if (e.key === "Escape" && !showHelp) { e.stopPropagation(); onClose(); } }}>
        <div role="dialog" aria-modal="true" aria-label={editing ? "Edit the view" : "Build a view"} data-testid="jql-builder" className="agx-jmock flex flex-col self-start min-h-0"
          style={{ width: "min(760px, 100%)", maxHeight: "84vh", borderRadius: 14, background: "var(--bg)", boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--text) 12%, transparent), 0 30px 60px -24px var(--shadow)" }}>
          <div className="flex items-center shrink-0" style={{ gap: 10, padding: "16px 16px 10px" }}>
            <div className="flex-1 min-w-0">
              <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{editing ? `Edit “${initialName}”` : "Build a view"}</div>
              <div style={{ fontSize: 11.5, color: "var(--text3)" }}>Start from a recipe or add parts. Jira checks it as you type.</div>
            </div>
            <ListIconBtn label="Close (Esc)" onClick={onClose}><CloseIcon size={ICON.md} /></ListIconBtn>
          </div>

          <div className="agx-scroll min-h-0 overflow-y-auto flex flex-col" style={{ padding: "4px 16px 12px", gap: 16 }}>
            <div>
              <div style={SECTION}>Start from</div>
              <div className="flex flex-wrap" style={{ gap: 6 }}>
                {JQL_RECIPES.map((r) => (
                  <button key={r.name} type="button" className="agx-chip" style={{ ...CHIP, background: jql.trim() === r.jql ? "color-mix(in srgb, var(--primary) 14%, transparent)" : CHIP.background }}
                    data-tip={tipAttr({ name: r.name, text: r.hint, detail: r.jql })} onClick={() => set(r.jql, r.jql.length)}>{r.name}</button>
                ))}
              </div>
            </div>

            <div>
              <div className="flex items-center" style={{ ...SECTION, gap: 8 }}>
                <span className="flex-1">Search (JQL)</span>
                <span style={{ fontWeight: 400, color: "var(--text3)" }}><kbd>Tab</kbd> accepts a suggestion · <kbd>Ctrl</kbd>+<kbd>Enter</kbd> saves</span>
              </div>
              <textarea ref={box} value={jql} spellCheck={false} rows={3} aria-label="Jira search"
                placeholder='status = "In Progress" AND assignee = currentUser()'
                role={showHelp ? "combobox" : undefined} aria-expanded={showHelp || undefined} aria-controls={showHelp ? "jql-help" : undefined}
                aria-activedescendant={showHelp ? `jql-help-${hotRow}` : undefined}
                onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
                onChange={(e) => { setJql(e.target.value); setCursor(e.target.selectionStart ?? e.target.value.length); setHelpOff(false); setHot(0); setSaveErr(""); }}
                onClick={(e) => { setHelpOff(false); setCursor(e.currentTarget.selectionStart ?? jql.length); }}
                onKeyUp={(e) => { if (!["ArrowDown", "ArrowUp"].includes(e.key) || !showHelp) setCursor(e.currentTarget.selectionStart ?? jql.length); }}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); void save(); return; }
                  if (!showHelp) return;
                  if (e.key === "ArrowDown") { e.preventDefault(); setHot((h) => Math.min(h + 1, rows.length - 1)); }
                  else if (e.key === "ArrowUp") { e.preventDefault(); setHot((h) => Math.max(h - 1, 0)); }
                  else if (e.key === "Tab" || e.key === "Enter") { e.preventDefault(); pick(rows[hotRow]!); }
                  else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setHelpOff(true); }
                }}
                className="w-full outline-none resize-y"
                style={{ minHeight: 76, padding: "10px 12px", borderRadius: 8, fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: 12.5, lineHeight: 1.55,
                  color: "var(--text)", caretColor: "var(--primary)", background: "var(--surface-inset)",
                  boxShadow: `inset 0 0 0 1px ${check.s === "bad" ? "color-mix(in srgb, var(--error) 55%, transparent)" : "color-mix(in srgb, var(--text) 14%, transparent)"}` }} />
              {showHelp && <JqlHelpPopover anchor={box} rows={rows} hot={hotRow} onPick={pick} />}
              <div role="status" aria-live="polite" className="flex items-center" style={{ gap: 6, minHeight: 20, marginTop: 6, fontSize: 11.5,
                color: check.s === "bad" ? "var(--error-ink)" : check.s === "ok" ? "var(--success-ink)" : "var(--text3)" }}>
                {check.s === "ok" && <><DoneIcon size={ICON.xs} /><span className="tabular-nums">{check.n} {check.n === 1 ? "card matches" : "cards match"}</span></>}
                {check.s === "bad" && <><WarningIcon size={ICON.xs} /><span className="min-w-0">{check.text}</span></>}
                {check.s === "checking" && <span>Checking with Jira…</span>}
                {check.s === "idle" && <span>Pick a recipe above, a part below, or type. Suggestions follow the caret.</span>}
              </div>
              {check.s === "ok" && preview && preview.length > 0 && (
                <div role="list" aria-label="First matching cards" className="flex flex-col" style={{ marginTop: 6, padding: 4, gap: 2, borderRadius: 8, background: "var(--surface-card)", boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--text) 10%, transparent)" }}>
                  {preview.map((t) => (
                    <div key={t.id} role="listitem" className="flex items-center min-w-0" style={{ gap: 8, height: 28, padding: "0 6px", fontSize: 12.5 }}>
                      <span className="shrink-0" style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: 11, color: "var(--jira-accent)" }}>{t.customId ?? t.id}</span>
                      <span className="flex-1 min-w-0 truncate" style={{ color: "var(--text)" }}>{t.title}</span>
                      <StateChip status={t.status} color={t.statusColor || undefined} done={t.statusKind === "done"} h={18} />
                    </div>
                  ))}
                  {check.n > preview.length && <div style={{ padding: "2px 6px 2px", fontSize: 11, color: "var(--text3)" }}>and {check.n - preview.length} more</div>}
                </div>
              )}
            </div>

            <div>
              <div style={SECTION}>Add a part</div>
              <div className="flex flex-wrap" style={{ gap: 6 }}>
                {JQL_PARTS.map((p) => (
                  <button key={p.field} type="button" className="agx-chip" style={CHIP} data-tip={tipAttr({ name: p.label, text: p.hint, detail: p.clause.trim() })}
                    onClick={() => { const n = addClause(jql, p.clause); set(n.text, n.cursor); }}>
                    <span aria-hidden style={{ color: "var(--text3)" }}>+</span>{p.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div style={SECTION}>Sort by</div>
              <div className="flex flex-wrap" role="radiogroup" aria-label="Sort by" style={{ gap: 6 }}>
                {JQL_ORDERS.map((o) => {
                  const on = order === o.order;
                  return (
                    <button key={o.order} type="button" role="radio" aria-checked={on} className="agx-chip"
                      style={{ ...CHIP, background: on ? "color-mix(in srgb, var(--primary) 14%, transparent)" : CHIP.background, boxShadow: on ? "inset 0 0 0 1px color-mix(in srgb, var(--primary) 55%, transparent)" : CHIP.boxShadow }}
                      onClick={() => { const t = withOrder(jql, o.order); set(t, t.length); }}>{o.label}</button>
                  );
                })}
              </div>
            </div>

            <div>
              <div style={SECTION}>Name</div>
              <input className={`w-full ${INPUT}`} style={INPUT_STYLE} value={name} onChange={(e) => { setName(e.target.value); setSaveErr(""); }} placeholder={finalName || "Name the view"} aria-label="View name" maxLength={60}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void save(); } }}
                />
            </div>
          </div>

          <div className="flex items-center shrink-0" style={{ gap: 8, padding: "10px 16px", borderTop: LINE }}>
            <span className="flex-1 min-w-0 truncate" role="status" style={{ fontSize: 11.5, color: saveErr ? "var(--error-ink)" : "var(--text3)" }}>
              {saveErr || (finalName ? editing ? `Saves over “${initialName}”` : `Saves as a tab named “${finalName}”` : "A view is a tab you can come back to")}
            </span>
            <Ctl onClick={onClose}>Cancel</Ctl>
            <Ctl disabled={!jql.trim() || check.s === "bad"} onClick={() => { onTry(jql.trim()); onClose(); }} tip="Show it on the board now without keeping it">Try on board</Ctl>
            <Ctl tone="primary" disabled={!canSave} onClick={() => void save()} tip={{ name: "Save view", hint: { key: "Ctrl+Enter", text: "save" } }}>{saving ? "Saving…" : editing ? "Save changes" : "Save view"}</Ctl>
          </div>
        </div>
      </div>
    </Portal>
  );
}
