// The rule editor: one sentence, [Show only | Hide] PRs whose [field] [op]
// [value], and under it the PRs that rule alone takes off the board.
import { useMemo, useState } from "react";
import type { PrSummary } from "../../../shared/types.ts";
import { emptyLanes, type FilterOp, type FilterRule, type LaneFilter } from "../../../shared/prFilter.ts";
import type { FieldSpec, ReadField } from "./tasks/filters.ts";
import { evalLanes } from "../lib/prFilterEval.ts";
import { suggestCards } from "../lib/prFilterSyntax.ts";
import { addRule } from "../lib/prFilterTree.ts";
import { editorFields, opsFor, opWord, takesValue, type LaneName } from "../lib/prFilterView.ts";
import { Pop, PfIcon } from "./PrFilterPop.tsx";
import { Button, EDGE, LINE } from "./workspace/Chrome.tsx";

const PREVIEW_ROWS = 5;
const CTRL: React.CSSProperties = { border: EDGE, background: "var(--bg)", color: "var(--text)" };

/** The rule's own validity, as the reason it cannot be added yet (null = fine). */
export function ruleProblem(r: FilterRule): string | null {
  if (!takesValue(r.op)) return null;
  if (!r.values.length || r.values.every((v) => !v.trim())) return "Needs a value";
  if (r.op === "matches") {
    for (const v of r.values) { try { new RegExp(v, "i"); } catch (e) { return `Not a valid pattern: ${(e as Error).message.replace(/^Invalid regular expression: /, "")}`; } }
  }
  if ((r.field === "updated" || r.field === "number") && r.values.some((v) => !/^\d+$/.test(v.trim()))) return "Whole numbers only";
  return null;
}

/** A rule on its own, as the board's lanes: what it alone would take off. */
export function ruleAlone(lane: LaneName, rule: FilterRule): LaneFilter {
  return addRule(emptyLanes(), lane, rule);
}

function Highlight({ text, needle }: { text: string; needle: string }) {
  const i = needle ? text.toLowerCase().indexOf(needle.toLowerCase()) : -1;
  if (i < 0) return <>{text}</>;
  return <>{text.slice(0, i)}<mark style={{ background: "color-mix(in srgb, var(--warning) 28%, transparent)", color: "inherit", borderRadius: 3 }}>{text.slice(i, i + needle.length)}</mark>{text.slice(i + needle.length)}</>;
}

/** A checkbox list of a field's values, each with how many PRs carry it. */
export function ValueList({ field, value, onChange, rows, read, max = 168 }: {
  field: FieldSpec; value: string[]; onChange: (v: string[]) => void; rows: PrSummary[]; read: ReadField<PrSummary>; max?: number;
}) {
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of rows) for (const v of new Set(read(p, field.key))) m.set(v, (m.get(v) ?? 0) + 1);
    return m;
  }, [rows, read, field.key]);
  return (
    <div className="overflow-y-auto agx-scroll" style={{ maxHeight: max }}>
      {field.options.map((o) => {
        const on = value.includes(o.value);
        return (
          <label key={o.value} className="flex items-center gap-2 px-1.5 py-1 rounded cursor-pointer agx-hover text-[12px]" style={{ color: "var(--text2)" }}>
            <input type="checkbox" checked={on} className="accent-[var(--primary)]"
              onChange={() => onChange(on ? value.filter((x) => x !== o.value) : [...value, o.value])} />
            <span className="truncate">{o.label}</span>
            <span className="ml-auto text-[10.5px] tabular-nums" style={{ color: "var(--text4)" }}>{counts.get(o.value) ?? 0}</span>
          </label>
        );
      })}
    </div>
  );
}

export function RuleEditor({ anchor, initial, isNew, fields, rows, read, onCommit, onRemove, onClose }: {
  anchor: HTMLElement | null;
  initial: { lane: LaneName; rule: FilterRule };
  isNew: boolean;
  fields: FieldSpec[];
  rows: PrSummary[];
  read: ReadField<PrSummary>;
  onCommit: (lane: LaneName, rule: FilterRule) => void;
  onRemove?: () => void;
  onClose: () => void;
}) {
  const [lane, setLane] = useState<LaneName>(initial.lane);
  const [rule, setRule] = useState<FilterRule>(initial.rule);
  const all = useMemo(() => editorFields(fields, initial.rule.field), [fields, initial.rule.field]);
  const spec = all.find((f) => f.key === rule.field) ?? all[0]!;
  const problem = ruleProblem(rule);
  const taken = useMemo(() => {
    if (problem) return [];
    const res = evalLanes(rows, ruleAlone(lane, rule), read);
    return rows.filter((p) => res.culprit.has(p));
  }, [rows, read, lane, rule, problem]);
  const typed = rule.values.join(", ");
  const freeValue = spec.options.length === 0 && takesValue(rule.op) && rule.field !== "conflict";
  const needle = rule.field === "text" && rule.op === "contains" ? (rule.values[0] ?? "") : "";
  const hints = useMemo(() => (rule.field === "card" ? suggestCards(rule.values[rule.values.length - 1] ?? "", rows, 5).filter((c) => !rule.values.includes(c)) : []), [rule, rows]);

  const setField = (key: string) => {
    const ops = opsFor(key);
    setRule({ ...rule, field: key, op: ops.includes(rule.op) ? rule.op : ops[0]!, values: key === "conflict" ? ["yes"] : [] });
  };
  const setOp = (op: FilterOp) => setRule({ ...rule, op, values: takesValue(op) ? rule.values : [] });
  const commit = () => { if (!problem) onCommit(lane, { ...rule, values: rule.values.map((v) => v.trim()).filter(Boolean) }); };

  return (
    <Pop anchor={anchor} onClose={onClose} width={440} label={isNew ? "New rule" : "Edit rule"}>
      <div onKeyDown={(e) => { if (e.key === "Enter" && e.target instanceof HTMLInputElement && e.target.type !== "checkbox") { e.preventDefault(); commit(); } }}>
        <div className="flex flex-wrap items-center gap-1.5 px-3 pt-3 pb-2.5 text-[12.5px]" style={{ color: "var(--text2)" }}>
          <span role="group" aria-label="Lane" className="inline-flex p-0.5 rounded-lg" style={{ background: "var(--surface-inset)" }}>
            {(["show", "hide"] as const).map((l) => (
              <button key={l} type="button" aria-pressed={lane === l} onClick={() => setLane(l)} className="px-2.5 py-1 rounded-md text-[11.5px] font-medium"
                style={{
                  background: lane === l ? "var(--bg)" : "transparent",
                  color: lane === l ? (l === "hide" ? "var(--error-ink)" : "var(--success-ink)") : "var(--text3)",
                  boxShadow: lane === l ? "0 1px 2px rgba(0,0,0,.18)" : "none",
                }}>{l === "show" ? "Show only" : "Hide"}</button>
            ))}
          </span>
          <span>PRs whose</span>
          <select aria-label="Field" value={rule.field} onChange={(e) => setField(e.target.value)} className="h-7 rounded-md px-1.5 text-[12px] font-medium" style={CTRL}>
            {all.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
          {rule.field === "conflict" ? (
            <>
              <span className="text-[12px] font-medium">has</span>
              <select aria-label="Conflicts" value={rule.op} onChange={(e) => setOp(e.target.value as FilterOp)} className="h-7 rounded-md px-1.5 text-[12px] font-medium" style={CTRL}>
                <option value="is">conflicts</option><option value="not">none</option>
              </select>
            </>
          ) : (
            <select aria-label="Operator" value={rule.op} onChange={(e) => setOp(e.target.value as FilterOp)} className="h-7 rounded-md px-1.5 text-[12px] font-medium" style={CTRL}>
              {opsFor(rule.field).map((o) => <option key={o} value={o}>{opWord(o, rule.field)}</option>)}
            </select>
          )}
        </div>

        {takesValue(rule.op) && rule.field !== "conflict" && (
          <div className="mx-3">
            {freeValue ? (
              <>
                <div className="flex items-center h-[34px] rounded-lg px-2.5 text-[13px]" style={{
                  border: `1.5px solid ${problem && typed ? "var(--error)" : "color-mix(in srgb, var(--info) 60%, transparent)"}`,
                  boxShadow: `0 0 0 3px color-mix(in srgb, ${problem && typed ? "var(--error)" : "var(--info)"} 14%, transparent)`,
                }}>
                  <input autoFocus aria-label="Value" value={typed} spellCheck={false}
                    inputMode={rule.field === "updated" || rule.field === "number" ? "numeric" : undefined}
                    placeholder={rule.field === "updated" ? "days" : rule.op === "matches" ? "pattern" : rule.field === "card" ? "ORBIT-1042" : rule.field === "number" ? "322" : "word or phrase"}
                    onChange={(e) => setRule({ ...rule, values: rule.field === "text" ? [e.target.value] : e.target.value.split(",").map((v) => v.replace(/^\s+/, "")) })}
                    className="flex-1 min-w-0 bg-transparent outline-none font-mono text-[13px]" style={{ color: "var(--text)" }} />
                  {rule.field === "updated" && <span className="text-[11px]" style={{ color: "var(--text4)" }}>days ago</span>}
                </div>
                {typed && problem && <div className="text-[11px] mt-1" style={{ color: "var(--error-ink)" }}>{problem}</div>}
                {hints.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {hints.map((c) => (
                      <button key={c} type="button" className="agx-btn px-1.5 py-0.5 rounded text-[11px] font-mono" style={{ border: EDGE, color: "var(--text2)" }}
                        onClick={() => setRule({ ...rule, values: [...rule.values.slice(0, -1), c] })}>{c}</button>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <ValueList field={spec} value={rule.values} onChange={(v) => setRule({ ...rule, values: v })} rows={rows} read={read} />
            )}
          </div>
        )}

        <div className="mt-2.5 px-3 pt-2 pb-2.5" style={{ borderTop: LINE, background: "var(--surface-inset)" }}>
          <div className="flex items-center gap-1.5 mb-1.5 text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--text3)" }}>
            <PfIcon name={lane === "hide" ? "eyeoff" : "eye"} />
            {problem ? "Add a value to see what it takes" : taken.length ? `Takes ${taken.length} of ${rows.length} off the board` : "Takes nothing off the board"}
          </div>
          {taken.slice(0, PREVIEW_ROWS).map((p) => (
            <div key={p.number} className="flex gap-2 items-baseline py-0.5 text-[12px]" style={{ color: "var(--text2)" }}>
              <span className="w-9 shrink-0 font-mono text-[11px]" style={{ color: "var(--text4)" }}>#{p.number}</span>
              <span className="truncate"><Highlight text={p.title} needle={needle} /></span>
            </div>
          ))}
          {taken.length > PREVIEW_ROWS && <div className="text-[11px] pt-0.5" style={{ color: "var(--text4)" }}>and {taken.length - PREVIEW_ROWS} more</div>}
        </div>

        <div className="flex items-center justify-end gap-1.5 px-3 py-2" style={{ borderTop: LINE }}>
          {onRemove && <Button size="compact" tone="danger" onClick={onRemove} className="mr-auto">Remove</Button>}
          <Button size="compact" onClick={onClose}>Cancel</Button>
          <Button size="compact" tone="primary" disabled={!!problem} onClick={commit} title={problem ?? undefined}>{isNew ? "Add" : "Done"}</Button>
        </div>
      </div>
    </Pop>
  );
}
