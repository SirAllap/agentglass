/*
 * The filter panel: `Where [field] [is] [values]`, one row at a time.
 *
 * Shaped after the tracker's own, because that shape is right and because
 * somebody who already knows theirs should not have to learn a second one. Our
 * chrome, though — the tracker's is a light-grey card with heavy dropdowns,
 * and this sits on a settings-dark surface among chips. See `filters.ts` for
 * what a rule is and why the join is one switch for the whole set.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Portal } from "../Portal.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { EMPTY, OPS, fieldsOf, liveCount, takesValues, type FieldSpec, type FilterSet, type Op, type Rule } from "./filters.ts";
import type { ProviderTask } from "../../../../shared/providers.ts";

const edge = (pct: number) => `1px solid color-mix(in srgb, var(--border) ${pct}%, transparent)`;
let seq = 0;
const newRule = (): Rule => ({ id: `r${++seq}`, field: "", op: "is", values: [] });

/** A dropdown that closes when you click elsewhere. Every control here is one
 *  and each was growing its own listener. */
function useAway<T extends HTMLElement>(open: boolean, close: () => void, alsoInside?: string) {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const el = e.target as Node;
      /* The panel is a Portal, so it is NOT inside `ref` — every click in it
         would read as a click away and close the thing being used. Whatever
         `alsoInside` names counts as inside. */
      if (alsoInside && (el as Element)?.closest?.(alsoInside)) return;
      if (ref.current && !ref.current.contains(el)) close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open, close, alsoInside]);
  return ref;
}

function Pick({ label, muted, children, width, lead }: {
  label: string; muted?: boolean; children: (close: () => void) => React.ReactNode; width?: number;
  /** A swatch or a glyph before the label — the chosen status's colour, the
   *  tag mark on a values control. */
  lead?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useAway<HTMLSpanElement>(open, () => setOpen(false));
  return (
    <span ref={ref} className="relative inline-flex">
      <button onClick={() => setOpen((v) => !v)}
        className="text-[11.5px] px-2 py-1 rounded-lg flex items-center gap-1.5 whitespace-nowrap"
        style={{
          /* Open reads as open: the border takes the accent and the caret
             turns over. Without it, three controls in a row give no sign of
             which one the menu below belongs to. */
          border: open ? "1px solid color-mix(in srgb, var(--primary) 45%, transparent)" : edge(22),
          color: muted ? "var(--text4)" : "var(--text)",
          background: "var(--bg)", minWidth: width,
        }}>
        {lead}
        <span className="truncate max-w-[200px]">{label}</span>
        {/* ICON.xs, not 9. Below twelve a stroked glyph stops resolving into a
            shape at 1x — there is a test that says so, and it caught this. */}
        <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}
          strokeLinecap="round" strokeLinejoin="round" aria-hidden
          className="shrink-0 ml-auto" style={{ color: "var(--text4)", transform: open ? "rotate(180deg)" : undefined }}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <span className="absolute z-10 top-full left-0 mt-1 rounded-lg overflow-hidden flex flex-col"
          style={{ background: "var(--bg2)", border: "1px solid var(--border)", boxShadow: "0 18px 40px -22px var(--shadow)", minWidth: 220 }}>
          {children(() => setOpen(false))}
        </span>
      )}
    </span>
  );
}

/** A searchable menu. Below eight entries the search box is more chrome than
 *  help; a board with twenty-six statuses is unusable without it. */
function Menu({ items, onPick, selected, current }: {
  items: { value: string; label: string; color?: string }[];
  onPick: (v: string) => void;
  /** Present when SEVERAL can be on — draws boxes and ticks what is chosen. */
  selected?: string[];
  /** Present when only one can — draws a tick beside the one that is. */
  current?: string;
}) {
  const [q, setQ] = useState("");
  const ql = q.trim().toLowerCase();
  const shown = ql ? items.filter((i) => i.label.toLowerCase().includes(ql)) : items;
  return (
    <>
      {items.length > 8 && (
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…"
          className="text-[11.5px] px-2.5 py-1.5 outline-none shrink-0"
          style={{ background: "var(--bg)", borderBottom: "1px solid var(--border)", color: "var(--text)" }} />
      )}
      <span className="agx-scroll overflow-y-auto overflow-x-hidden flex flex-col" style={{ maxHeight: 260 }}>
        {shown.map((i) => {
          const on = selected ? selected.includes(i.value) : i.value === current;
          return (
            <button key={i.value} onClick={() => onPick(i.value)}
              className="text-[11.5px] px-2.5 py-1.5 text-left flex items-center gap-2 agx-hover"
              style={{ color: on ? "var(--text)" : "var(--text2)" }}>
              {/* A BOX when several can be on, a TICK when only one can. The
                  shape is the affordance: a checkbox next to a single-choice
                  list invites you to try to pick two. */}
              {selected && (
                <span className="shrink-0 grid place-items-center rounded" style={{
                  width: 13, height: 13,
                  border: on ? "1px solid var(--primary)" : edge(45),
                  background: on ? "var(--primary)" : "transparent",
                  color: "var(--bg)", fontSize: 9, lineHeight: "13px",
                }}>{on ? "✓" : ""}</span>
              )}
              {i.color && <span className="shrink-0 rounded-full" style={{ width: 8, height: 8, background: i.color }} />}
              <span className="truncate">{i.label}</span>
              {!selected && on && (
                <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}
                  strokeLinecap="round" strokeLinejoin="round" aria-hidden
                  className="ml-auto shrink-0" style={{ color: "var(--primary)" }}>
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              )}
            </button>
          );
        })}
        {!shown.length && <span className="text-[11.5px] px-2.5 py-2" style={{ color: "var(--text4)" }}>Nothing matches.</span>}
      </span>
    </>
  );
}

function RuleRow({ fields, rule, onChange, onDrop }: {
  fields: FieldSpec[]; rule: Rule; onChange: (r: Rule) => void; onDrop: () => void;
}) {
  const spec = fields.find((f) => f.key === rule.field);
  const chosen = spec ? rule.values.map((v) => spec.options.find((o) => o.value === v)?.label ?? v) : [];
  const opLabel = OPS.find((o) => o.value === rule.op)?.label ?? "is";
  const needsValues = takesValues(rule.op);
  /* The swatch of the single chosen value, on the control itself — the way a
     status reads on the tracker's own filter. Only when there is exactly one:
     two colours in one button is a flag, not a value. */
  const oneColour = spec && rule.values.length === 1
    ? spec.options.find((o) => o.value === rule.values[0])?.color
    : undefined;

  return (
    /* EACH ROW IN ITS OWN BOX. Three controls and a bin floating on the panel
       ground read as seven things; boxed, they read as one rule with parts —
       which matters at three rows, where the eye has to find where one ends. */
    <span className="flex items-center gap-1.5 flex-wrap flex-1 rounded-lg px-2 py-1.5"
      style={{ background: "var(--bg)", border: edge(14) }}>
      <Pick label={spec?.label ?? "Select filter"} muted={!spec} width={132}>
        {(close) => (
          <Menu items={fields.map((f) => ({ value: f.key, label: f.label }))} current={rule.field}
            onPick={(v) => { onChange({ ...rule, field: v, values: [] }); close(); }} />
        )}
      </Pick>
      <Pick label={opLabel} width={84}>
        {(close) => (
          <Menu items={OPS.map((o) => ({ value: o.value, label: o.label }))} current={rule.op}
            onPick={(v) => {
              /* Moving to "is set" or "is not set" drops the values: they mean
                 nothing there, and leaving them would bring them back if the
                 operator moved again — a rule that quietly remembers an old
                 answer is worse than one that asks. */
              const op = v as Op;
              onChange({ ...rule, op, values: takesValues(op) ? rule.values : [] });
              close();
            }} />
        )}
      </Pick>
      {needsValues && (
        <Pick
          label={chosen.length === 0
            ? (spec && spec.options.length === 1 ? "Select an option" : "Select options")
            : chosen.length <= 2 ? chosen.join(", ") : `${chosen.length} selected`}
          muted={!chosen.length}
          width={176}
          lead={oneColour
            ? <span className="shrink-0 rounded-full" style={{ width: 8, height: 8, background: oneColour }} />
            : undefined}>
          {() => (spec
            ? (
              /* Multi-select: the menu STAYS OPEN. Picking three squads through
                 three rounds of open-pick-reopen is what makes a filter builder
                 feel like paperwork. */
              <Menu items={spec.options} selected={rule.values}
                onPick={(v) => onChange({
                  ...rule,
                  values: rule.values.includes(v) ? rule.values.filter((x) => x !== v) : [...rule.values, v],
                })} />
            )
            : <span className="text-[11.5px] px-2.5 py-2" style={{ color: "var(--text4)" }}>Choose a field first.</span>)}
        </Pick>
      )}
      {/* A BIN, not a close: this removes a row rather than dismissing the
          panel, and ✕ in a panel that also has a way out reads as the way out.
          Its own SVG rather than a glyph — a bare character has no accessible
          name and a hit area the size of itself. */}
      <button onClick={onDrop} title="Remove this row" aria-label="Remove this row"
        className="shrink-0 ml-auto grid place-items-center rounded agx-hover"
        style={{ width: 22, height: 22, color: "var(--text4)" }}>
        <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
          strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
        </svg>
      </button>
    </span>
  );
}

export function FilterBuilder({ tasks, value, onChange }: {
  tasks: ProviderTask[]; value: FilterSet; onChange: (f: FilterSet) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useAway<HTMLSpanElement>(open, () => setOpen(false), "[data-agx-filters]");
  const fields = useMemo(() => fieldsOf(tasks), [tasks]);
  const n = liveCount(value);

  const set = (rules: Rule[]) => onChange({ ...value, rules });

  /*
   * A PORTAL, not an absolute child.
   *
   * The chip row is inside a header with its own clipping, so a panel
   * positioned inside it came out cut off at the second row — measured on
   * screen, not guessed. Anchored off the button's own rect instead, the way
   * the notification panel and the plan panel already are.
   *
   * Right-aligned to the button and clamped to the window: 520px hanging off a
   * button near the right edge would otherwise run past it.
   */
  const btn = useRef<HTMLButtonElement | null>(null);
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  const toggle = () => {
    if (open) { setOpen(false); return; }
    const r = btn.current?.getBoundingClientRect();
    if (r) setAt({ top: Math.round(r.bottom + 6), right: Math.max(8, Math.round(window.innerWidth - r.right)) });
    setOpen(true);
  };

  return (
    <span ref={ref} className="relative inline-flex shrink-0">
      <button ref={btn} onClick={toggle}
        title="Build a filter — field, is or is not, values"
        className="text-[11.5px] px-2 py-1 rounded-lg flex items-center gap-1.5 whitespace-nowrap"
        style={{
          border: n ? "1px solid color-mix(in srgb, var(--primary) 45%, transparent)" : edge(22),
          color: n ? "var(--text)" : "var(--text3)",
          background: n ? "color-mix(in srgb, var(--primary) 12%, transparent)" : "transparent",
        }}>
        <span>Filters</span>
        {n > 0 && <span className="tabular-nums text-[10px]" style={{ color: "var(--primary)" }}>{n}</span>}
      </button>

      {open && at && (
        <Portal z={10040}>
        {/* NO overflow on the panel itself. A scroll container clips its
            children, and every control in here opens a menu that is taller
            than the row it hangs off — with `overflow-y-auto` set here, the
            field menu was cut at "Status" against the panel's own edge. The
            ROWS scroll instead, so the menus are free to overhang. */}
        <span data-agx-filters="" className="fixed rounded-xl p-3 flex flex-col gap-2"
          style={{
            top: at.top, right: at.right, minWidth: 520, maxWidth: "min(94vw, 720px)",
            background: "var(--bg2)", border: "1px solid var(--border)",
            boxShadow: "0 22px 48px -20px var(--shadow)",
          }}>
          {!fields.length ? (
            <span className="text-[11.5px]" style={{ color: "var(--text4)" }}>
              Nothing to filter by yet — this board has not loaded any cards.
            </span>
          ) : (
            <>
              <span className="flex flex-col gap-2 agx-scroll" style={{ maxHeight: "min(46vh, 340px)", overflowY: value.rules.length > 4 ? "auto" : "visible" }}>
              {value.rules.map((r, i) => (
                <span key={r.id} className="flex items-start gap-2">
                  {/* The join is one switch for the whole set, and it only
                      appears once there is something to join. */}
                  <span className="shrink-0 pt-1" style={{ width: 54 }}>
                    {i === 0 ? (
                      <span className="text-[10.5px]" style={{ color: "var(--text4)" }}>Where</span>
                    ) : i === 1 ? (
                      <Pick label={value.join === "or" ? "OR" : "AND"} width={54}>
                        {(close) => (
                          <Menu items={[{ value: "and", label: "AND" }, { value: "or", label: "OR" }]}
                            onPick={(v) => { onChange({ ...value, join: v as FilterSet["join"] }); close(); }} />
                        )}
                      </Pick>
                    ) : (
                      <span className="text-[10.5px]" style={{ color: "var(--text4)" }}>{value.join === "or" ? "OR" : "AND"}</span>
                    )}
                  </span>
                  <RuleRow fields={fields} rule={r}
                    onChange={(next) => set(value.rules.map((x) => (x.id === r.id ? next : x)))}
                    onDrop={() => set(value.rules.filter((x) => x.id !== r.id))} />
                </span>
              ))}
              </span>
              <span className="flex items-center gap-2 pt-1">
                <button onClick={() => set([...value.rules, newRule()])}
                  className="text-[11.5px] px-2 py-1 rounded-lg"
                  style={{ border: edge(22), color: "var(--text2)" }}>+ Add filter</button>
                {value.rules.length > 0 && (
                  <button onClick={() => onChange(EMPTY)}
                    className="ml-auto text-[11.5px] px-2 py-1 rounded-lg"
                    style={{ border: "1px solid color-mix(in srgb, var(--error) 30%, transparent)", color: "var(--error)" }}>
                    Clear all
                  </button>
                )}
              </span>
            </>
          )}
        </span>
        </Portal>
      )}
    </span>
  );
}
