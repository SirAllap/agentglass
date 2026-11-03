// The filter deck above the PR board: Show only / Hide lanes of rule chips,
// the line you type rules into, and a tile strip with one tile per PR coloured
// by the rule that hid it. The decisions (when it folds, which colour, what a
// rule says) are in lib/prFilterView.ts; this is the place and the keys.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { PrSummary } from "../../../shared/types.ts";
import { emptyLanes, isGroup, type FilterNode, type FilterRule, type LaneFilter } from "../../../shared/prFilter.ts";
import type { FieldSpec, ReadField } from "./tasks/filters.ts";
import { evalLanes, type LaneResult } from "../lib/prFilterEval.ts";
import { parseRuleText, suggestCards } from "../lib/prFilterSyntax.ts";
import { addParsed, newNodeId, removeNode, replaceRule } from "../lib/prFilterTree.ts";
import {
  blankRule, readDeckOpen, writeDeckOpen, deckNarrow, typedFlash, FLASH_MS, culpritColours, culpritName, deckMode, describeAdd, editorFields, findNode, laneOfId, nodeName, ruleChipView, ruleWithLane, totalRules, wallCopy, wallRule,
  type LaneName,
} from "../lib/prFilterView.ts";
import { sentence } from "../lib/prFilterSentence.ts";
import { Pop, PopHead, PfIcon, fieldIcon } from "./PrFilterPop.tsx";
import { RuleEditor } from "./PrRuleEditor.tsx";
import { PrFilterTree } from "./PrFilterTree.tsx";
import { PrFilterSheet } from "./PrFilterSheet.tsx";
import { Button, LINE } from "./workspace/Chrome.tsx";
import { ICON } from "../lib/iconSize.ts";


/** Tiles beyond this many are folded into a count: a strip is for a glance, not a ledger. */
const MAX_TILES = 120;

type Adding = { lane: LaneName; rule: FilterRule } | null;

function useWidth(ref: { current: HTMLElement | null }): number {
  const [w, setW] = useState(1000);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

/** The strip: one tile per PR, hatched in the culprit's colour when hidden. */
export function Strip({ rows, result, colours, small, label }: {
  rows: PrSummary[]; result: LaneResult<PrSummary>; colours: Map<string, string>; small?: boolean; label?: (p: PrSummary, by: string | undefined) => string;
}) {
  const shown = rows.slice(0, MAX_TILES);
  const w = small ? 9 : 14, h = small ? 9 : 14;
  return (
    <span className="inline-flex flex-wrap gap-0.5 min-w-0" role="img" aria-label={`${result.kept.length} of ${rows.length} shown`}>
      {shown.map((p) => {
        const by = result.culprit.get(p);
        const c = by ? colours.get(by) ?? "var(--text3)" : null;
        return (
          <span key={p.number} title={label ? label(p, by) : `#${p.number} ${p.title}`}
            style={{
              width: w, height: h, borderRadius: small ? 3 : 4, display: "block",
              background: c
                ? `repeating-linear-gradient(135deg, ${c} 0 2px, color-mix(in srgb, ${c} 30%, transparent) 2px 4px)`
                : "var(--text3)",
            }} />
        );
      })}
      {rows.length > MAX_TILES && <span className="text-[10px] self-center" style={{ color: "var(--text4)" }}>+{rows.length - MAX_TILES}</span>}
    </span>
  );
}

const SYNTAX: [string, string][] = [
  ["BETA", "Show only: title or branch has BETA"], ["-BETA", "Hide: title or branch has BETA"],
  ['"BETA: SSO"', "the exact phrase"], ["/^BETA:/", "a pattern"],
  ["#322   -#322", "this PR only, or hide it"], ["ORBIT-1042   -ORBIT-1042", "this card, or hide it"],
  ["is:conflict   -is:conflict", "with conflicts, or without"], ["ci:failing", "checks failing, passing or running"],
  ["updated:>14d", "untouched for 14 days"], ["author:mara   label:docs", "any pill field, then its value"],
  ["(a | b)", "any of these, in Show only"], ["!author:mara", "Show only: not this one"],
];

export function PrFilterDeck({ filter, onChange, rows, result, fields, read, editing, setEditing, onUndo, canUndo, inline, viewsRow }: {
  filter: LaneFilter;
  onChange: (f: LaneFilter) => void;
  /** The PRs being filtered, in board order: one tile each. */
  rows: PrSummary[];
  result: LaneResult<PrSummary>;
  fields: FieldSpec[];
  read: ReadField<PrSummary>;
  /** The rule whose editor is open, or null. Slips on the board set it too. */
  editing: string | null;
  setEditing: (id: string | null) => void;
  onUndo?: () => void;
  canUndo?: boolean;
  /** What to draw in the deck's own place when the board is empty. */
  inline?: ReactNode;
  /** The saved views: the first thing in the one row that holds them and the rules, so the header is two rows, not three. */
  viewsRow?: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const width = useWidth(root);
  const narrow = deckNarrow(width);
  const [sheet, setSheet] = useState(false);
  const [treeOpen, setTreeOpen] = useState(false);
  // Folded by default; only the person's click on the chevron opens it.
  const [open, setOpen] = useState(readDeckOpen);
  const toggleOpen = () => setOpen((v) => { writeDeckOpen(!v); return !v; });
  const [text, setText] = useState("");
  const [sel, setSel] = useState(-1);
  const [help, setHelp] = useState(false);
  const [fieldMenu, setFieldMenu] = useState(false);
  const [adding, setAdding] = useState<Adding>(null);
  /* Rules just typed in, for the tree editor to point at. */
  const [flash, setFlash] = useState<Map<string, string> | null>(null);
  useEffect(() => {
    if (!flash) return;
    const id = setTimeout(() => setFlash(null), FLASH_MS);
    return () => clearTimeout(id);
  }, [flash]);
  const inputRef = useRef<HTMLInputElement>(null);
  const plusRef = useRef<HTMLButtonElement>(null);
  const helpRef = useRef<HTMLButtonElement>(null);
  const hidesRef = useRef<HTMLButtonElement>(null);
  const [hides, setHides] = useState(false);
  const chipEls = useRef(new Map<string, HTMLElement>());
  const colours = useMemo(() => culpritColours(filter), [filter]);
  const mode = deckMode(filter);
  const total = totalRules(filter);
  const hidden = rows.length - result.kept.length;
  const wallId = wallRule(result, rows.length, result.kept.length)?.id ?? null;

  /* A slip on the board names a rule; a group has no editor but the tree. */
  const editNode = editing ? filter.show.children.concat(filter.hide.children).find((c) => c.id === editing) ?? null : null;
  useEffect(() => { if (editing && !editNode && editing !== filter.show.id && editing !== filter.hide.id) setEditing(null); }, [editing, editNode, filter, setEditing]);
  const wholeLane = editing === filter.show.id || editing === filter.hide.id;
  useEffect(() => { if ((editNode && isGroup(editNode)) || wholeLane) { setTreeOpen(true); setEditing(null); } }, [editNode, wholeLane, setEditing]);

  const parsed = useMemo(() => (text.trim() ? parseRuleText(text, { newId: newNodeId }) : null), [text]);
  const core = text.trim().replace(/^[-!]+/, "");
  const lead = text.trim().startsWith("-") ? "-" : "";
  const cardHints = useMemo(() => (/^[A-Za-z]/.test(core) && !/\s/.test(core) && !core.includes(":") ? suggestCards(core, rows, 4) : []), [core, rows]);
  const hits = (a: { lane: LaneName; node: FilterNode }) => evalLanes(rows, addParsed(emptyLanes(), [a]), read).culprit.size;
  const items = useMemo(() => {
    if (!parsed || "error" in parsed) return [];
    return parsed.add.map((a) => ({ lane: a.lane, label: describeAdd(a.lane, a.node), n: hits(a), add: a }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed, rows, read]);
  const hints = cardHints.map((id) => {
    const r = parseRuleText(lead + id, { newId: newNodeId });
    return "add" in r ? { label: describeAdd(r.add[0]!.lane, r.add[0]!.node), lane: r.add[0]!.lane, add: r.add[0]!, n: hits(r.add[0]!) } : null;
  }).filter((x): x is NonNullable<typeof x> => !!x);
  useEffect(() => setSel(-1), [text]);

  const commitText = () => {
    if (!parsed || "error" in parsed) return;
    const picked = sel >= 0 ? [hints[sel]!.add] : parsed.add;
    onChange(addParsed(filter, picked));
    setFlash(typedFlash(picked));
    
    setText("");
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") { e.preventDefault(); commitText(); }
    else if (e.key === "ArrowDown" && hints.length) { e.preventDefault(); setSel((s) => Math.min(hints.length - 1, s + 1)); }
    else if (e.key === "ArrowUp" && hints.length) { e.preventDefault(); setSel((s) => Math.max(-1, s - 1)); }
    else if (e.key === "Tab" && text.trim() && !e.shiftKey) { e.preventDefault(); setText(text.trim().startsWith("-") ? text.trim().slice(1) : `-${text.trim()}`); }
    else if (e.key === "Backspace" && !text) {
      const last = [...filter.show.children, ...filter.hide.children].pop();
      if (last && !isGroup(last)) { e.preventDefault(); setEditing(last.id); }
    } else if (e.key === "?" && !text) { e.preventDefault(); setHelp(true); }
    else if (e.key === "Escape") { setText(""); inputRef.current?.blur(); }
  };

  const startAdd = (field: string) => { setFieldMenu(false); setAdding({ lane: "show", rule: blankRule(field, newNodeId()) }); };

  const labelOf = (f: string, v: string) => fields.find((x) => x.key === f)?.options.find((o) => o.value === v)?.label ?? v;

  const chip = (n: FilterNode, lane: LaneName, count: number, wall: boolean) => {
    if (isGroup(n)) return null;
    const v = ruleChipView(n, lane, labelOf);
    return (
      <span key={n.id} className="agx-rchip" data-lane={lane} data-wall={wall ? "" : undefined}>
        <button type="button" ref={(el) => { if (el) chipEls.current.set(n.id, el); else chipEls.current.delete(n.id); }}
          onClick={() => setEditing(n.id)} aria-label={`Edit rule: ${lane === "hide" ? "hide" : "show only"} ${nodeName(n)}`}
          title={count > 0 ? `Edit this rule. It hides ${count} that no earlier rule hid` : "Edit this rule. It hides nothing, so it can go"}
          className="agx-rchip-main">
          <b className="agx-rchip-l">{v.label}</b>
          {!v.quoted && <span style={{ color: "var(--text4)" }}><PfIcon name={fieldIcon(n.field)} size={ICON.xs} /></span>}
          {v.lead && <span style={{ color: "var(--text3)" }}>{v.lead}</span>}
          <span>{v.quoted ? `“${v.value}”` : v.value}</span>
        </button>
        <button type="button" onClick={() => onChange(removeNode(filter, n.id))} aria-label={`Remove rule ${nodeName(n)}`} title="Remove rule" className="agx-rchip-x">
          <PfIcon name="x" size={ICON.xs} />
        </button>
      </span>
    );
  };

  const laneChips = (lane: LaneName): ReactNode => {
    const g = lane === "show" ? filter.show : filter.hide;
    if (!g.children.length) return null;
    const one = (c: FilterNode) => chip(c, lane, result.hiddenBy.get(c.id) ?? 0, wallId === c.id);
    const unit = (lane === "show" ? g.join === "or" : g.join === "and") && g.children.length > 1;
    if (!unit) return g.children.map(one);
    const word = lane === "show" ? "OR" : "AND";
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5 p-0.5 rounded-xl" style={{
        border: `1px dashed color-mix(in srgb, ${lane === "show" ? "var(--info)" : "var(--error)"} 45%, transparent)`,
        background: `color-mix(in srgb, ${lane === "show" ? "var(--info)" : "var(--error)"} 7%, transparent)`,
        ...(wallId === g.id ? { boxShadow: "0 0 0 3px color-mix(in srgb, var(--error) 18%, transparent)", borderColor: "var(--error)" } : {}),
      }}>
        <span className="text-[9.5px] font-semibold tracking-wider pl-1.5" style={{ color: lane === "show" ? "var(--info-ink)" : "var(--error-ink)" }}>{lane === "show" ? "ANY OF" : "ALL OF"}</span>
        {g.children.map((c, i) => <span key={c.id} className="inline-flex items-center gap-1.5">{i > 0 && <span className="text-[9.5px] font-semibold" style={{ color: "var(--text4)" }}>{word}</span>}{one(c)}</span>)}
      </span>
    );
  };

  const toggle = (
    <Button size="hit" square tone="quiet" onClick={toggleOpen} aria-expanded={open} label={open ? "Fold rules" : "Show rules"}>
      <span style={{ display: "grid", transform: open ? undefined : "rotate(-90deg)" }}><PfIcon name="chev" size={14} /></span>
    </Button>
  );

  // The dashed box: any pixel of it types (the caret and the input take their own presses).
  const addBox = (
    <div className="agx-addrule" data-err={parsed && "error" in parsed ? "" : undefined}
      onMouseDown={(e) => { if (!(e.target as HTMLElement).closest("button, input")) { e.preventDefault(); inputRef.current?.focus(); } }}>
      <PfIcon name="plus" size={12} />
      <input ref={inputRef} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} spellCheck={false}
        aria-label="Add a rule by typing" aria-invalid={!!(parsed && "error" in parsed)}
        placeholder="Add a rule · try -BETA, ORBIT-1042, is:conflict"
        className="bg-transparent outline-none placeholder:font-sans placeholder:text-[var(--text4)]" />
      <button type="button" ref={plusRef} onClick={() => { setFieldMenu((v) => !v); inputRef.current?.focus(); }} aria-label="Pick a field" aria-haspopup="menu" aria-expanded={fieldMenu}
        className="agx-hover rounded grid place-items-center" style={{ width: 20, height: 20, color: "var(--text3)" }}><PfIcon name="chev" size={ICON.xs} /></button>
    </div>
  );
  const helpButton = (
    <Button size="hit" square tone="quiet" buttonRef={helpRef} onClick={() => setHelp((v) => !v)} label="Syntax help" title="Syntax help (?)"><PfIcon name="help" size={14} /></Button>
  );

  // The rules, or in sentence mode the sentence they read as and the way into the tree.
  const controls = (
    <>
      {mode === "sentence" ? (
        <>
          <span className="text-[12px] leading-snug min-w-0" style={{ color: "var(--text2)" }}>
            {sentence(filter).map((s, i) => (
              <span key={i} style={s.k === "show" ? { color: "var(--info-ink)", fontWeight: 600 } : s.k === "hide" ? { color: "var(--error-ink)", fontWeight: 600 } : s.k === "b" ? { color: "var(--text)", fontWeight: 600 } : undefined}>{s.t}</span>
            ))}
          </span>
          <Button size="hit" onClick={() => setTreeOpen((v) => !v)} aria-expanded={treeOpen}>{treeOpen ? "Close" : "Edit"}</Button>
        </>
      ) : <>{laneChips("show")}{laneChips("hide")}</>}
      {addBox}
      {helpButton}
    </>
  );

  // What the rules hide, as the mockup's one badge; the tiles and the colour key stay one press away in its popover.
  const hidesBadge = hidden > 0 && (
    <button type="button" ref={hidesRef} onClick={() => setHides((v) => !v)} aria-haspopup="dialog" aria-expanded={hides}
      title="Cards your rules keep off the board" className="agx-cnt">Hides {hidden}</button>
  );
  const undoButton = <Button size="hit" onClick={onUndo} disabled={!canUndo || !onUndo} title="Undo the last change to the rules"><PfIcon name="undo" size={14} />Undo</Button>;
  const clearButton = <Button size="hit" onClick={() => { onChange(emptyLanes()); setTreeOpen(false); }} disabled={total === 0} title="Remove every rule">Clear rules</Button>;
  const keyed = [...filter.show.children, ...filter.hide.children, filter.show, filter.hide]
    .map((n) => ({ id: n.id, hid: result.hiddenBy.get(n.id) ?? 0, group: n.id === filter.show.id || n.id === filter.hide.id }))
    .filter((r) => r.hid > 0 || !r.group);

  const editRule = editNode && !isGroup(editNode) ? editNode : null;
  const treeEl = treeOpen && mode !== "quiet" && (
    <PrFilterTree filter={filter} onChange={onChange} result={result} colours={colours} fields={fields} rows={rows} read={read} flash={flash} onClose={() => setTreeOpen(false)} />
  );

  return (
    <div ref={root} className="relative shrink-0">
      <div className="agx-drow" role="group" aria-label="Your rules" data-deck={mode}>
        {viewsRow}
        {viewsRow && <span aria-hidden className="agx-drow-sep" />}
        {narrow ? (
          <>
            <Button size="hit" onClick={() => setSheet(true)} aria-haspopup="dialog" aria-expanded={sheet}><PfIcon name="filter" size={14} />{total ? `${total} rule${total === 1 ? "" : "s"}` : "Filter"}</Button>
            <span className="flex-1" />
            {hidesBadge}
          </>
        ) : (
          <>
            {toggle}
            <span className="agx-drow-l">Your rules</span>
            {open ? controls : <span className="agx-cnt">{total} rule{total === 1 ? "" : "s"}</span>}
            <span className="flex-1" />
            {hidesBadge}{undoButton}{clearButton}
          </>
        )}
      </div>
      {narrow && sheet && (
        <PrFilterSheet title="Filter" onClose={() => setSheet(false)}>
          <div className="flex flex-wrap items-center gap-1.5">{controls}{undoButton}{clearButton}</div>
          {treeEl}
        </PrFilterSheet>
      )}

      {!narrow && treeEl}
      {inline}

      {text.trim() && (
        <Pop anchor={inputRef.current} onClose={() => setText("")} width={Math.min(420, Math.max(300, width - 24))} label="Will add" keepFocus>
          {parsed && "error" in parsed ? (
            <div className="px-2.5 py-2 text-[12px] flex gap-2 items-start" style={{ color: "var(--error-ink)" }}>
              <PfIcon name="conflict" size={14} />
              <span>{parsed.error}. Nothing added.</span>
            </div>
          ) : (
            <div className="p-1.5">
              <PopHead>Will add</PopHead>
              {items.map((it, i) => (
                <div key={i} className="flex items-center gap-2 px-2 py-1.5 rounded-md text-[12px]" style={{ background: sel < 0 ? "var(--surface-inset)" : "transparent", color: "var(--text)" }}>
                  <span style={{ color: it.lane === "hide" ? "var(--error-ink)" : "var(--success-ink)" }}><PfIcon name={it.lane === "hide" ? "eyeoff" : "eye"} size={14} /></span>
                  <span className="truncate">{it.label}</span>
                  <span className="ml-auto text-[11px] tabular-nums" style={{ color: "var(--text4)" }}>{it.n > 0 ? `−${it.n}` : "0"}</span>
                </div>
              ))}
              {hints.length > 0 && <div className="my-1" style={{ borderTop: LINE }} />}
              {hints.map((h, i) => (
                <button key={h.label} type="button" onClick={() => { onChange(addParsed(filter, [h.add])); setFlash(typedFlash([h.add])); setText(""); }}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[12px] text-left agx-hover"
                  style={{ background: sel === i ? "var(--surface-inset)" : "transparent", color: "var(--text2)" }}>
                  <span style={{ color: h.lane === "hide" ? "var(--error-ink)" : "var(--success-ink)" }}><PfIcon name={h.lane === "hide" ? "eyeoff" : "eye"} size={14} /></span>
                  <span className="truncate">{h.label}</span>
                  <span className="ml-auto text-[11px] tabular-nums" style={{ color: "var(--text4)" }}>{h.n > 0 ? `−${h.n}` : "0"}</span>
                </button>
              ))}
              <div className="px-2 pt-1.5 pb-1 text-[11px]" style={{ color: "var(--text4)", borderTop: LINE, marginTop: 4 }}>⏎ add · ⇥ other lane · ⌫ edit the last rule</div>
            </div>
          )}
        </Pop>
      )}

      {hides && (
        <Pop anchor={hidesRef.current} onClose={() => setHides(false)} width={360} align="right" label="What your rules hide">
          <div className="p-2">
            <PopHead>What your rules hide</PopHead>
            <div className="px-2 pb-1.5 flex flex-col gap-1.5">
              <Strip rows={rows} result={result} colours={colours} label={(p, by) => `#${p.number} ${p.title}${by ? ` — hidden by ${culpritName(filter, by)}` : ""}`} />
              <span className="text-[11.5px] tabular-nums" style={{ color: "var(--text3)" }} aria-live="polite">
                <b style={{ color: "var(--text)", fontWeight: 600 }}>{result.kept.length}</b> of {rows.length} shown · {hidden} hidden
              </span>
            </div>
            <div className="flex flex-col" style={{ borderTop: LINE }}>
              {keyed.map((r) => (
                <div key={r.id} className="flex items-center gap-2 px-2 py-1 text-[12px]" style={{ color: "var(--text2)" }}>
                  <i aria-hidden className="shrink-0" style={{ width: 9, height: 9, borderRadius: 3, background: colours.get(r.id) ?? "var(--text3)" }} />
                  <span className="truncate">{r.group ? culpritName(filter, r.id) : ruleWithLane(laneOfId(filter, r.id) ?? "show", findNode(filter, r.id)!)}</span>
                  <span className="ml-auto text-[11px] tabular-nums" style={{ color: "var(--text4)" }}>{r.hid > 0 ? `−${r.hid}` : "hides nothing: it can go"}</span>
                </div>
              ))}
            </div>
          </div>
        </Pop>
      )}

      {help && (
        <Pop anchor={helpRef.current} onClose={() => setHelp(false)} width={420} label="Syntax" align="right">
          <div className="p-2">
            <PopHead>Syntax</PopHead>
            <div className="grid gap-x-3.5 gap-y-1.5 px-2 pb-2 text-[12px]" style={{ gridTemplateColumns: "auto 1fr", color: "var(--text2)" }}>
              {SYNTAX.map(([c, d]) => <><code key={c} className="font-mono text-[11.5px] px-1.5 rounded justify-self-start" style={{ background: "var(--surface-inset)", color: "var(--text)" }}>{c}</code><span key={c + d}>{d}</span></>)}
            </div>
            <div className="px-2 pb-1 text-[11px]" style={{ color: "var(--text4)" }}>A leading minus hides; everything else shows only. The search box above is separate: it looks at every PR.</div>
          </div>
        </Pop>
      )}

      {fieldMenu && (
        <Pop anchor={plusRef.current} onClose={() => setFieldMenu(false)} width={260} label="Rule on">
          <div className="p-1.5" role="menu">
            <PopHead>Rule on</PopHead>
            {editorFields(fields).map((f) => (
              <button key={f.key} type="button" role="menuitem" onClick={() => startAdd(f.key)}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[12px] text-left agx-hover" style={{ color: "var(--text2)" }}>
                <span style={{ color: "var(--text4)" }}><PfIcon name={fieldIcon(f.key)} size={14} /></span>{f.label}
              </button>
            ))}
          </div>
        </Pop>
      )}

      {adding && (
        <RuleEditor anchor={plusRef.current} initial={adding} isNew fields={fields} rows={rows} read={read}
          onCommit={(lane, rule) => { onChange(addParsed(filter, [{ lane, node: rule }])); setAdding(null); }}
          onClose={() => setAdding(null)} />
      )}
      {editRule && (
        <RuleEditor key={editRule.id} anchor={chipEls.current.get(editRule.id) ?? root.current} initial={{ lane: laneOfId(filter, editRule.id) ?? "show", rule: editRule }} isNew={false}
          fields={fields} rows={rows} read={read}
          onCommit={(lane, rule) => { onChange(replaceRule(filter, lane, rule)); setEditing(null); }}
          onRemove={() => { onChange(removeNode(filter, editRule.id)); setEditing(null); }}
          onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

/** The empty board's explanation: which rule is the wall, and the way out. */
export function FilterWall({ filter, result, total, onChange, onUndo, canUndo, onOpen }: {
  filter: LaneFilter; result: LaneResult<PrSummary>; total: number;
  onChange: (f: LaneFilter) => void; onUndo?: () => void; canUndo?: boolean; onOpen: (id: string) => void;
}) {
  const wall = wallRule(result, total, result.kept.length);
  const copy = wallCopy(filter, total);
  const removable = wall && wall.id !== filter.show.id && wall.id !== filter.hide.id;
  const named = wall && removable ? `${laneOfId(filter, wall.id) === "hide" ? "Hide" : "Show only"} · ${culpritName(filter, wall.id)}` : null;
  return (
    <div className="agx-blank h-full" data-wall={wall?.id}>
      <div style={{ maxWidth: 520 }}>
        <span aria-hidden className="agx-blank-tile" style={{ "--tone": "var(--warning)" } as CSSProperties}><PfIcon name="eye" size={18} /></span>
        <div className="agx-blank-t">{copy.title}</div>
        <p className="agx-blank-s m-0">{copy.parts.map((p, i) => (p.b ? <b key={i} style={{ color: "var(--text)", fontWeight: 600 }}>{p.t}</b> : <span key={i}>{p.t}</span>))}</p>
        <div className="flex flex-wrap justify-center gap-1.5">
          {named && wall && <Button size="hit" onClick={() => onChange(removeNode(filter, wall.id))}>Remove “{named}”</Button>}
          {wall && <Button size="hit" onClick={() => onOpen(wall.id)}>Open the rule</Button>}
          {canUndo && onUndo && <Button size="hit" onClick={onUndo}><PfIcon name="undo" size={14} />Undo</Button>}
          <Button size="hit" tone="primary" onClick={() => onChange(emptyLanes())}>Clear all rules</Button>
        </div>
      </div>
    </div>
  );
}
