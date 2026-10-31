// The tree editor, for a filter that outgrew chips: each lane a card, each
// group a card inside it with a rail on the left, the connector word on its
// own line, and one rule per row as field · operator · value · count · ×.
import { useEffect, useRef, useState } from "react";
import type { PrSummary } from "../../../shared/types.ts";
import { VIEW_LIMITS, isGroup, type FilterGroup, type FilterNode, type FilterOp, type FilterRule, type LaneFilter } from "../../../shared/prFilter.ts";
import type { FieldSpec, ReadField } from "./tasks/filters.ts";
import type { LaneResult } from "../lib/prFilterEval.ts";
import { lanesToText } from "../lib/prFilterSyntax.ts";
import { addGroup, addRule, canAddGroup, newNodeId, removeNode, setJoin, updateRule } from "../lib/prFilterTree.ts";
import { blankRule, editorFields, opsFor, opWord, takesValue, totalRules, type LaneName } from "../lib/prFilterView.ts";
import { sentence } from "../lib/prFilterSentence.ts";
import { Pop, PfIcon } from "./PrFilterPop.tsx";
import { ValueList, ruleProblem } from "./PrRuleEditor.tsx";
import { Button, EDGE } from "./workspace/Chrome.tsx";

const CELL: React.CSSProperties = { border: EDGE, background: "var(--bg)", color: "var(--text)" };
const LANE_RAIL: Record<LaneName, string> = { show: "var(--success)", hide: "var(--error)" };
const railAt = (lane: LaneName, depth: number) => `color-mix(in srgb, ${LANE_RAIL[lane]} ${Math.max(25, 100 - depth * 30)}%, var(--text4))`;

type Ctx = {
  filter: LaneFilter; onChange: (f: LaneFilter) => void; result: LaneResult<PrSummary>; colours: Map<string, string>;
  fields: FieldSpec[]; rows: PrSummary[]; read: ReadField<PrSummary>;
  /** Rules just typed into the deck: id -> the text they came from. */
  flash?: Map<string, string> | null;
};

function ValueCell({ rule, ctx, ring }: { rule: FilterRule; ctx: Ctx; ring?: React.CSSProperties }) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const spec = editorFields(ctx.fields, rule.field).find((f) => f.key === rule.field)!;
  const set = (values: string[]) => ctx.onChange(updateRule(ctx.filter, rule.id, { values }));
  if (!takesValue(rule.op)) return <span className="h-[30px]" />;
  if (rule.field === "conflict") {
    return (
      <select aria-label="Conflicts" value={rule.op} className="h-[30px] rounded-md px-1.5 text-[12px] font-semibold min-w-0" style={{ ...CELL, ...ring }}
        onChange={(e) => ctx.onChange(updateRule(ctx.filter, rule.id, { op: e.target.value as FilterOp, values: ["yes"] }))}>
        <option value="is">conflicts</option><option value="not">none</option>
      </select>
    );
  }
  const bad = rule.values.length > 0 ? ruleProblem(rule) : null;
  if (spec.options.length) {
    return (
      <>
        <button ref={btn} type="button" onClick={() => setOpen(true)} aria-haspopup="dialog"
          className="h-[30px] flex items-center gap-1.5 px-2 rounded-md text-[12px] font-semibold text-left truncate" style={{ ...CELL, ...ring }}>
          <span className="truncate">{rule.values.length ? rule.values.map((v) => spec.options.find((o) => o.value === v)?.label ?? v).join(", ") : <span style={{ color: "var(--text4)", fontWeight: 400 }}>pick…</span>}</span>
        </button>
        {open && (
          <Pop anchor={btn.current} onClose={() => setOpen(false)} width={240} label={`${spec.label} values`}>
            <div className="p-1.5"><ValueList field={spec} value={rule.values} onChange={set} rows={ctx.rows} read={ctx.read} /></div>
          </Pop>
        )}
      </>
    );
  }
  return (
    <input aria-label="Value" value={rule.values.join(", ")} spellCheck={false}
      placeholder={rule.field === "updated" ? "days" : rule.op === "matches" ? "pattern" : "value"}
      onChange={(e) => set(rule.field === "text" ? [e.target.value] : e.target.value.split(",").map((v) => v.replace(/^\s+/, "")))}
      className="h-[30px] px-2 rounded-md text-[12px] font-mono min-w-0 w-full outline-none"
      style={{ ...CELL, ...ring, borderColor: bad ? "var(--error)" : ring?.borderColor }} title={bad ?? undefined} />
  );
}

function RuleRow({ rule, ctx, top }: { rule: FilterRule; ctx: Ctx; top: boolean }) {
  const all = editorFields(ctx.fields, rule.field);
  const up = (p: Partial<Omit<FilterRule, "id">>) => ctx.onChange(updateRule(ctx.filter, rule.id, p));
  const n = top ? ctx.result.hiddenBy.get(rule.id) ?? 0 : 0;
  const typed = ctx.flash?.get(rule.id);
  const ring = typed === undefined ? undefined : { borderColor: "color-mix(in srgb, var(--info) 60%, transparent)", boxShadow: "0 0 0 3px color-mix(in srgb, var(--info) 14%, transparent)" };
  const el = useRef<HTMLDivElement>(null);
  /* The tree scrolls; a row typed in below the fold has to be brought into view to be seen. */
  useEffect(() => { if (typed !== undefined) el.current?.scrollIntoView?.({ block: "nearest" }); }, [typed]);
  return (
    <div ref={el}>
    <div className="grid items-center gap-2 min-h-9" data-flash={typed !== undefined || undefined} style={{ gridTemplateColumns: "minmax(110px,150px) minmax(100px,140px) minmax(0,1fr) 40px 22px" }}>
      <select aria-label="Field" value={rule.field} className="h-[30px] rounded-md px-1.5 text-[12px] min-w-0" style={{ ...CELL, ...ring }}
        onChange={(e) => { const b = blankRule(e.target.value, rule.id); up({ field: b.field, op: b.op, values: b.values }); }}>
        {all.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
      </select>
      {rule.field === "conflict" ? (
        <span className="h-[30px] flex items-center px-2 text-[12px] italic rounded-md" style={{ ...CELL, color: "var(--text3)" }}>has</span>
      ) : (
        <select aria-label="Operator" value={rule.op} className="h-[30px] rounded-md px-1.5 text-[12px] italic min-w-0" style={{ ...CELL, ...ring, color: "var(--text3)" }}
          onChange={(e) => { const op = e.target.value as FilterOp; up({ op, values: takesValue(op) ? rule.values : [] }); }}>
          {opsFor(rule.field).map((o) => <option key={o} value={o}>{opWord(o, rule.field)}</option>)}
        </select>
      )}
      <ValueCell rule={rule} ctx={ctx} ring={ring} />
      <span className="text-[10.5px] font-semibold text-center tabular-nums" style={{ color: n ? ctx.colours.get(rule.id) : "var(--text4)" }}>{top && n ? `−${n}` : ""}</span>
      <button type="button" onClick={() => ctx.onChange(removeNode(ctx.filter, rule.id))} aria-label="Remove rule"
        className="agx-hover rounded grid place-items-center" style={{ width: 22, height: 22, color: "var(--text4)" }}><PfIcon name="x" /></button>
    </div>
    {typed !== undefined && <div className="pl-1 pb-1 text-[11px] font-mono" style={{ color: "var(--info)" }}>added from typing <code>{typed}</code></div>}
    </div>
  );
}

function GroupCard({ g, lane, depth, lead, ctx, top }: { g: FilterGroup; lane: LaneName; depth: number; lead?: string; ctx: Ctx; top: boolean }) {
  const rail = railAt(lane, depth);
  const n = top ? ctx.result.hiddenBy.get(g.id) ?? 0 : 0;
  const connector = g.join === "or" ? "or" : "and";
  const add = (node: FilterNode) => ctx.onChange(isGroup(node) ? addGroup(ctx.filter, g.id, node) : addRule(ctx.filter, g.id, node));
  const room = canAddGroup(ctx.filter, g.id);
  return (
    <div className="relative rounded-xl my-1.5 pl-4 pr-3 pt-2.5 pb-2"
      style={{ background: `color-mix(in srgb, ${rail} 5%, var(--bg))` }} data-depth={depth}>
      <span aria-hidden className="absolute left-0 top-2 bottom-2 w-[3px] rounded-sm" style={{ background: rail }} />
      <div className="flex items-center gap-2 mb-1.5 text-[12.5px]" style={{ color: "var(--text2)" }}>
        {lead && <span className="font-semibold" style={{ color: "var(--text)" }}>{lead}</span>}
        <span role="group" aria-label="Match" className="inline-flex p-0.5 rounded-md text-[10.5px] font-semibold" style={{ background: "var(--surface-inset)" }}>
          {(["and", "or"] as const).map((j) => (
            <button key={j} type="button" aria-pressed={g.join === j} onClick={() => ctx.onChange(setJoin(ctx.filter, g.id, j))}
              className="px-1.5 py-1 rounded" style={{ background: g.join === j ? "var(--bg)" : "transparent", color: g.join === j ? "var(--text)" : "var(--text4)", boxShadow: g.join === j ? "0 1px 2px rgba(0,0,0,.18)" : "none" }}>
              {j === "and" ? "ALL" : "ANY"}
            </button>
          ))}
        </span>
        <span>of these</span>
        {n > 0 && <span className="ml-auto text-[10.5px] font-semibold rounded px-1.5 py-0.5" style={{ background: rail, color: "var(--on-primary, #fff)" }}>−{n}</span>}
        {!lead && <button type="button" onClick={() => ctx.onChange(removeNode(ctx.filter, g.id))} aria-label="Remove group" title="Remove group"
          className={`agx-hover rounded grid place-items-center ${n > 0 ? "" : "ml-auto"}`} style={{ width: 22, height: 22, color: "var(--text4)" }}><PfIcon name="x" /></button>}
      </div>
      <div className="ml-1.5">
        {g.children.map((c, i) => (
          <div key={c.id}>
            {i > 0 && <div className="pl-2 py-0.5 text-[10.5px] font-semibold uppercase" style={{ color: "var(--text4)" }}>{connector}</div>}
            {isGroup(c) ? <GroupCard g={c} lane={lane} depth={depth + 1} ctx={ctx} top={top && depth === 0} /> : <RuleRow rule={c} ctx={ctx} top={top && depth === 0} />}
          </div>
        ))}
        {!g.children.length && <div className="text-[12px] py-1" style={{ color: "var(--text4)" }}>Nothing here yet.</div>}
      </div>
      <div className="flex gap-1.5 pt-1.5 pl-1.5">
        <button type="button" onClick={() => add(blankRule("text", newNodeId()))} className="agx-btn text-[12px] px-2 py-1 rounded-md" style={{ border: "1px dashed var(--border2)", color: "var(--text3)" }}>+ Rule</button>
        <button type="button" disabled={!room} onClick={() => add({ id: newNodeId(), kind: "group", join: "or", children: [] })}
          title={room ? "A group inside this one" : `${VIEW_LIMITS.depth} levels at most: make this a separate view`}
          className="agx-btn text-[12px] px-2 py-1 rounded-md disabled:opacity-40" style={{ border: "1px dashed var(--border2)", color: "var(--text3)" }}>+ Group</button>
      </div>
    </div>
  );
}

export function PrFilterTree({ filter, onChange, result, colours, fields, rows, read, flash, onClose }: Ctx & { onClose: () => void }) {
  const ctx: Ctx = { filter, onChange, result, colours, fields, rows, read, flash };
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(lanesToText(filter)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => {});
  };
  return (
    <section aria-label="Filter rules, as a tree" className="mt-2 rounded-xl p-4 max-h-[60vh] overflow-y-auto agx-scroll"
      style={{ background: "var(--bg)", border: EDGE, boxShadow: "0 18px 40px -16px rgba(0,0,0,.3)" }}>
      <div className="flex items-start gap-3 mb-3">
        <p className="flex-1 m-0 text-[13.5px] leading-relaxed" style={{ color: "var(--text2)" }}>
          {sentence(filter).map((s, i) => <span key={i} style={s.k === "show" ? { color: "var(--success-ink)", fontWeight: 600 } : s.k === "hide" ? { color: "var(--error-ink)", fontWeight: 600 } : s.k === "b" ? { color: "var(--text)", fontWeight: 600 } : undefined}>{s.t}</span>)}
          {totalRules(filter) === 0 && "No rules yet."}
        </p>
        <Button size="compact" onClick={copy}>{copied ? "Copied" : "Copy as text"}</Button>
        <Button size="compact" tone="primary" onClick={onClose}>Done</Button>
      </div>
      <GroupCard g={filter.show} lane="show" depth={0} lead="Show only PRs matching" ctx={ctx} top />
      <GroupCard g={filter.hide} lane="hide" depth={0} lead="Then hide PRs matching" ctx={ctx} top />
    </section>
  );
}
