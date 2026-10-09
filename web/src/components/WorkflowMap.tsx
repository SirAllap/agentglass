import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, LINE } from "./workspace/Chrome.tsx";
import { Dot, StatusPanel, StatusPopover, type PanelView } from "./StatusPanel.tsx";
import { WFM_CSS } from "./workflowMapStyle.ts";
import { ArrowIcon, CaretIcon, DoneIcon, EyeIcon, EyeOffIcon, ListIcon, MergeIcon, NoteIcon, PlusIcon, UserIcon, WarningIcon, CrossIcon } from "../lib/glyphIcons.tsx";
import { StepBlocks, type MapPerson } from "./StepBlocks.tsx";
import type { FieldChoice } from "./StepExtraRows.tsx";
import type { StepBlock } from "../../../shared/providers.ts";
import { blocksSentence, blockNeedsValue, stepIsEmpty, triggerOf } from "../lib/stepBlocksView.ts";
import { HIT, ICON } from "../lib/iconSize.ts";
import {
  STEP_ORDER, allStatuses, isActive, moments, needsStatus, suggestStatus,
  type MapSpace, type Moment, type Nouns, type Step, type StepKind, type TrackerAdapter,
} from "../lib/workflowMap.ts";
import {
  coveragePill, coverageRows, defaultUnit, eyeIds, lineInk, notInUnit, planConnectors, statusHome,
  type CoveragePill, type Partition, type Wire,
} from "../lib/workflowLayout.ts";

/**
 * The workflow map: a card for every step, a column of the statuses of the list being
 * looked at, and a coloured line from each card's status control to the same status in
 * the column.
 *
 * It knows no tracker. Words come from the adapter's nouns, the lists from the partition
 * it is handed (the ones that count, and the ones folded away), and the steps that exist
 * from the adapter's kinds; the page that mounts it decides what saving means. Nothing is
 * offered that the tracker did not send, nothing is saved until it has what it needs (a
 * step that needs a status says so), and a step without its status
 * does nothing and says so.
 */
export interface MapProps {
  adapter: TrackerAdapter;
  /** The lists that count, and those folded away (still here, to count again). */
  part: Partition;
  /** What the status list is doing; steps and lines stay readable under every state. */
  panel: PanelView;
  steps: Step[];
  changesOn: boolean;
  /** Paused by something outside the map (a refused token): the steps are shown and cannot be touched. */
  frozen?: boolean;
  /** Under the picker's list: where the statuses come from and how old they are. */
  source?: ReactNode;
  /** The step the person's attention is on, so the page can show which part of a pull request it adds. */
  onHover?: (k: StepKind | null) => void;
  /** Add a step. The ones built from blocks start empty; resolves false when the save failed. */
  onAdd: (kind: StepKind) => Promise<boolean> | void;
  /** Replace a step's blocks, in the order given. */
  onBlocks: (kind: StepKind, blocks: StepBlock[]) => void;
  onRemove: (kind: StepKind) => void;
  /** The custom fields of the lists this person works in, for a "Set a field" block. Null: could not be read. */
  fields?: () => Promise<FieldChoice[] | null>;
  /** The people a step can name, read when the person list opens (the tracker's cached members). Null: could not be read. */
  people?: () => Promise<MapPerson[] | null>;
  onRetry: () => void;
  /** Count a folded list again. */
  onCountAgain?: (unit: MapSpace) => void;
  /** The eye on a list: hide it from the counted ones, or bring it back. Absent: no eye is drawn. */
  onToggleCounted?: (unit: MapSpace) => void;
}

export type { MapPerson };

/**
 * The eye on a list: hide it from the ones that count, or bring it back. It has its place at the end of
 * its row in every state (a disabled eye when hiding would leave nothing counted, an empty box when no
 * handler is given), so a press moves the row and never a control.
 */
export function ListEye({ unit, nouns, onToggle, blocked }: { unit: MapSpace; nouns: Pick<Nouns, "list" | "name">; onToggle?: (u: MapSpace) => void; blocked?: boolean }) {
  if (!onToggle) return <span aria-hidden className="shrink-0" style={{ width: HIT, marginRight: 6 }} />;
  const off = unit.counted === false;
  const label = off ? "Show it again" : blocked ? `At least one ${nouns.list} has to count` : `Hide this ${nouns.list} from ${nouns.name} statuses`;
  return (
    <button type="button" className="wfm-eye" data-eye={off ? "off" : "on"} title={label} aria-label={`${label}: ${unit.name}`} disabled={blocked}
      onClick={() => onToggle(unit)}>
      {off ? <EyeOffIcon size={ICON.md} /> : <EyeIcon size={ICON.md} />}
    </button>
  );
}

/** The mark each moment wears in the map, drawn and not typed. */
export const GLYPH: Record<StepKind, (p: { size?: number }) => React.ReactElement> = { move: ArrowIcon, menu: ListIcon, merge: MergeIcon, people: UserIcon, note: NoteIcon };

/** A small status label: filled for what is on, quiet for what is not. */
export function Badge({ tone, children }: { tone?: "ok" | "warn" | "err" | "dim"; children: ReactNode }) {
  const hue = tone === "ok" ? "var(--success)" : tone === "warn" ? "var(--warning)" : tone === "err" ? "var(--error)" : null;
  const ink = tone === "ok" ? "var(--success-ink)" : tone === "warn" ? "var(--warning-ink)" : tone === "err" ? "var(--error-ink)" : "var(--text3)";
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap font-bold uppercase" style={{
      height: 20, padding: "0 8px", borderRadius: 10, fontSize: 10, letterSpacing: ".04em", color: ink,
      background: hue ? `color-mix(in srgb, ${hue} 16%, var(--bg))` : "var(--bg)",
      boxShadow: `inset 0 0 0 1px ${hue ? `color-mix(in srgb, ${hue} 50%, transparent)` : "var(--surface-line)"}`,
    }}>{children}</span>
  );
}

/** One bar per counted list: filled where the status exists. */
function Segs({ on }: { on: boolean[] }) {
  return <span className="wfm-segs" aria-hidden>{on.map((y, i) => <i key={i} {...(y ? { "data-y": "" } : {})} />)}</span>;
}

const PRESS_LEAD: Partial<Record<StepKind, string>> = { move: "Press it:", menu: "Pick it:", merge: "Confirm the merge:" };
const hint = (c: ReactNode, extra?: object) => <span className="text-[11px]" style={{ color: "var(--text3)", ...extra }}>{c}</span>;

export function WorkflowMap(p: MapProps) {
  const { adapter, part, panel, changesOn, frozen } = p;
  const n = adapter.nouns;
  const M = useMemo(() => moments(n), [n]);
  const steps = p.steps;
  const units = useMemo(() => [...part.counted, ...part.folded.map((f) => f.unit)], [part]);
  const listed = useMemo(() => allStatuses(part.counted), [part.counted]);
  const [selId, setSelId] = useState<string | null>(null);
  /* Opens on the counted list with most of the person's cards; with no cards to go on it opens on none and asks. */
  const sel: MapSpace | undefined = part.counted.find((u) => u.id === selId) ?? defaultUnit(part.counted) ?? undefined;
  const [composer, setComposer] = useState(false);
  const [picker, setPicker] = useState<{ kind: StepKind; anchor: HTMLElement } | null>(null);
  const [lit, setLit] = useState<string | null>(null);
  const [hl, setHl] = useState<ReadonlySet<StepKind>>(new Set());
  const [openCov, setOpenCov] = useState<ReadonlySet<StepKind>>(new Set());
  const [flash, setFlash] = useState<StepKind | null>(null);
  const [autoAdd, setAutoAdd] = useState<StepKind | null>(null);
  const [focusNext, setFocusNext] = useState<string | null>(null);
  const [foldOpen, setFoldOpen] = useState(false);
  const root = useRef<HTMLElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const stepsBox = useRef<HTMLDivElement>(null);
  const uid = useId();
  const dormant = !changesOn && steps.length > 0;
  const light = (ks: StepKind[], on: boolean) => {
    setHl((cur) => { const next = new Set(cur); for (const k of ks) on ? next.add(k) : next.delete(k); return next; });
    p.onHover?.(on ? (ks[0] ?? null) : null);
  };

  /* Focus lands where the person's hands were: back on the control that opened a list, on the new step, or on Add.
     The target may not exist yet (a step appears only once its save lands), so the request is kept until it does,
     and dropped after two seconds rather than waiting for ever. */
  useEffect(() => {
    if (!focusNext) return;
    const el = root.current?.querySelector<HTMLElement>(focusNext);
    if (el) { el.focus(); setFocusNext(null); return; }
    const t = setTimeout(() => setFocusNext(null), 2000);
    return () => clearTimeout(t);
  }, [focusNext, steps, composer]);
  /* A step built from blocks starts empty, so its menu of blocks opens as soon as the saved step is on the page. */
  useEffect(() => {
    if (!autoAdd) return;
    const el = root.current?.querySelector<HTMLElement>(`[data-step="${autoAdd}"] [data-addblock]`);
    if (el) { setAutoAdd(null); el.click(); return; }
    const t = setTimeout(() => setAutoAdd(null), 2500);
    return () => clearTimeout(t);
  }, [autoAdd, steps]);
  useEffect(() => { if (flash) { const t = setTimeout(() => setFlash(null), 1000); return () => clearTimeout(t); } }, [flash]);

  /* The lines. Drawn from where the controls and the status rows actually are, so they follow a
     wrapped sentence, a changed list, the sticky column and a resized window. Each ends on its
     status's dot and is drawn in that status's own colour, moved until it reads on the page. */
  const draw = useCallback(() => {
    const g = grid.current, s = svg.current, box = stepsBox.current;
    if (!g || !s || !box) return;
    const gr = g.getBoundingClientRect();
    s.setAttribute("width", String(gr.width));
    s.setAttribute("height", String(gr.height));
    const base = getComputedStyle(g.querySelector(".wfm-col") ?? g).backgroundColor;
    const wires: (Wire & { kind: StepKind })[] = [];
    for (const st of steps) {
      if (!st.status || !sel || !isActive(st, M[st.kind])) continue;
      const card = g.querySelector<HTMLElement>(`[data-step="${st.kind}"]`);
      const pick = card?.querySelector<HTMLElement>("[data-pick]");
      const row = [...g.querySelectorAll<HTMLElement>("[data-status]")].find((r) => r.dataset.status!.toLowerCase() === st.status!.toLowerCase());
      const dot = row?.querySelector<HTMLElement>("[data-dot]");
      if (!card || !pick || !dot) continue;
      const c = pick.getBoundingClientRect(), d = dot.getBoundingClientRect(), cr = card.getBoundingClientRect();
      const colour = getComputedStyle(dot.firstElementChild ?? dot).backgroundColor;
      wires.push({
        id: steps.indexOf(st) + 1, kind: st.kind, color: lineInk(colour, base),
        from: { x: cr.right - gr.left, y: c.top + c.height / 2 - gr.top }, to: { x: d.left + d.width / 2 - gr.left, y: d.top + d.height / 2 - gr.top },
      });
    }
    const cards = box.getBoundingClientRect().right - gr.left;
    const kindOf = new Map(wires.map((w) => [w.id, w.kind]));
    let out = "";
    for (const c of planConnectors(wires, cards)) {
      const k = kindOf.get(c.id)!;
      out += `<g class="wfm-ln" data-ln="${k}" ${hl.has(k) ? "data-hl" : ""}><path d="${c.d}" stroke="${c.color}"/><circle cx="${c.from.x}" cy="${c.from.y}" r="3.5" fill="${c.color}" stroke="${base}" stroke-width="1.5"/><circle cx="${c.to.x}" cy="${c.to.y}" r="7" fill="none" stroke="${c.color}" stroke-width="1.5"/></g>`;
    }
    s.innerHTML = out;
    if (hl.size) s.setAttribute("data-has", ""); else s.removeAttribute("data-has");
  }, [steps, sel, M, hl]);
  useLayoutEffect(() => { draw(); });
  useEffect(() => {
    const g = grid.current;
    if (!g) return;
    let raf = 0;
    const again = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); };
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(again) : null;
    ro?.observe(g);
    /* The column is sticky: it moves against the cards while the page scrolls, in whichever box scrolls. */
    document.addEventListener("scroll", again, true);
    window.addEventListener("resize", again);
    void document.fonts?.ready.then(again);
    return () => { cancelAnimationFrame(raf); ro?.disconnect(); document.removeEventListener("scroll", again, true); window.removeEventListener("resize", again); };
  }, [draw]);

  const openPicker = (kind: StepKind) => (anchor: HTMLElement) => setPicker({ kind, anchor });
  const closePicker = (refocus: boolean) => {
    if (refocus && picker) setFocusNext(`[data-step="${picker.kind}"] [data-pick]`);
    setPicker(null);
    setLit(null);
  };
  const toggleCov = (k: StepKind) => setOpenCov((cur) => { const next = new Set(cur); next.has(k) ? next.delete(k) : next.add(k); return next; });

  const chooseMoment = async (k: StepKind) => {
    setComposer(false);
    const ok = await p.onAdd(k);
    if (ok === false) return;
    setFlash(k);
    if (triggerOf(k)) { setAutoAdd(k); setFocusNext(`[data-step="${k}"] [data-addblock]`); } else setFocusNext(`[data-step="${k}"] [data-rm]`);
  };

  const spaceWord = n.lists;
  const statusPanel = (kind: StepKind, current: string | null) => (
    <StatusPanel nouns={n} part={part} view={panel} current={current ?? ""} leave={M[kind].optional}
      suggested={suggestStatus(adapter, kind, listed)} onActive={setLit} onRetry={p.onRetry}
      source={p.source}
      onPick={(v) => {
        setPicker(null); setLit(null);
        const st = steps.find((x) => x.kind === kind);
        if (st?.blocks) p.onBlocks(kind, st.blocks.map((b) => (b.type === "move" ? { type: "move", statusNames: v ? [v] : [] } : b)));
        setFlash(kind);
        setFocusNext(`[data-step="${kind}"] [data-pick]`);
      }}
      onClose={() => closePicker(true)} />
  );

  /* ---------- the column of statuses ---------- */
  const missing = notInUnit(steps, sel);
  const pinsOnStatus = (status: string): { k: StepKind; num: number }[] =>
    steps.flatMap((s, i) => (s.status && s.status.toLowerCase() === status.toLowerCase() && isActive(s, M[s.kind]) && changesOn ? [{ k: s.kind, num: i + 1 }] : []));
  /* The eye on a list (see ListEye): hiding the last counted one is refused, so its eye is the disabled one. */
  const eye = (u: MapSpace) => (
    <ListEye unit={u} nouns={n} onToggle={p.onToggleCounted} blocked={frozen || (u.counted !== false && eyeIds(units, u) === null)} />
  );
  const column = (
    <aside className="wfm-col" aria-label="Your statuses">
      <div className="flex flex-col gap-0.5">
        <h3 className="m-0 text-[13px] font-bold">Your statuses in</h3>
        {hint(`From the ${n.lists} where your tasks live, as ${n.name} orders them.`)}
      </div>
      {panel.kind === "loading" && !sel ? (
        <div aria-busy="true">{[70, 50, 65, 45, 60, 40].map((w, i) => <div key={i} className="px-2 py-2"><div className="agx-skel rounded" style={{ width: `${w}%`, height: 12, background: "var(--surface-inset)" }} /></div>)}</div>
      ) : !sel && part.counted.length === 0 ? (
        <div className="text-[11px]" style={{ color: "var(--text3)" }}>
          {units.length ? <>No {n.list} counts. Count one again below to see its statuses.</> : <>No {n.lists} to show.</>}
        </div>
      ) : (
        <>
          {(part.counted.length > 1 || part.folded.length > 0) && (
            <div className="wfm-lt" role="tablist" aria-label={spaceWord[0]!.toUpperCase() + spaceWord.slice(1)}>
              {part.counted.map((u) => (
                <div key={u.id} className="r" {...(u.id === sel?.id ? { "data-sel": "" } : {})}>
                  <button type="button" className="t" role="tab" aria-selected={u.id === sel?.id} onClick={() => setSelId(u.id)}>
                    <span className="n"><b className="text-[13px]">{u.name}</b>{u.group && hint(u.group)}</span>
                    <span className="text-[11px] tabular-nums" style={{ color: "var(--text3)" }}>{u.statuses.length}</span>
                  </button>
                  {eye(u)}
                </div>
              ))}
            </div>
          )}
          {!sel ? (
            <div className="text-[11px]" style={{ color: "var(--text3)" }}>Your cards could not be read, so no {n.list} is picked for you. Pick one above to see its statuses.</div>
          ) : (
            <>
            <div role="group" aria-label={`Statuses in ${sel.name}`} className="flex flex-col gap-0.5">
              {sel.statuses.length === 0 ? <div className="py-2 text-[11px]" style={{ color: "var(--text3)" }}>This {n.list} has no statuses we can read.</div>
                : sel.statuses.map((s) => {
                  const pins = pinsOnStatus(s.status);
                  const lit_ = !!lit && lit.toLowerCase() === s.status.toLowerCase();
                  const ids = pins.map((x) => x.k);
                  const hot = ids.some((k) => hl.has(k)) || lit_;
                  return (
                    <div key={s.status} data-status={s.status} className="wfm-sr" {...(pins.length ? { "data-tg": "" } : {})} {...(hot ? { "data-hl": "" } : {})}
                      onMouseEnter={() => ids.length && light(ids, true)} onMouseLeave={() => ids.length && light(ids, false)}>
                      <span data-dot><Dot type={s.type} color={s.color} /></span>
                      <span className="n">{s.status}</span>
                      <span className="wfm-pins">{pins.map((x) => <span key={x.k} className="wfm-pin" {...(hl.has(x.k) ? { "data-hl": "" } : {})} title={`Step ${x.num}`} onMouseEnter={() => light([x.k], true)} onMouseLeave={() => light([x.k], false)}>{x.num}</span>)}</span>
                    </div>
                  );
                })}
            </div>
            <div className="text-[11px]" style={{ color: "var(--text3)" }}>A line runs from a step’s status to the same status here. Hover a step or a status to follow one line.</div>
            {missing.length > 0 && (
              <div className="flex flex-col gap-1 pt-3" style={{ borderTop: LINE }}>
                <span className="text-[10px] font-semibold uppercase" style={{ letterSpacing: ".1em", color: "var(--text3)" }}>Not in {sel.name}</span>
                <div className="text-[11px]" style={{ color: "var(--text3)" }}>
                  {missing.map((num) => <span key={num} className="wfm-pin mr-1" data-off="" {...(hl.has(steps[num - 1]!.kind) ? { "data-hl": "" } : {})} onMouseEnter={() => light([steps[num - 1]!.kind], true)} onMouseLeave={() => light([steps[num - 1]!.kind], false)}>{num}</span>)}
                  point at a status this {n.list} does not have.
                </div>
              </div>
            )}
            </>
          )}
        </>
      )}
      {part.folded.length > 0 && (
        <details className="wfm-fold" open={foldOpen} onToggle={(e) => setFoldOpen((e.target as HTMLDetailsElement).open)} style={{ borderTop: LINE }}>
          <summary><span className="chev" aria-hidden><CaretIcon size={ICON.xs} /></span><b className="text-[13px]">Ignored ({part.folded.length})</b></summary>
          <div className="wfm-lt mt-2">
            {part.folded.map((f) => (
              <div key={f.unit.id} className="r">
                <span className="nm"><b className="text-[13px]">{f.unit.name}</b>{hint("ignored")}</span>
                {eye(f.unit)}
              </div>
            ))}
          </div>
        </details>
      )}
    </aside>
  );

  /* ---------- a step ---------- */
  const stepCard = (st: Step, i: number) => {
    const m: Moment = M[st.kind];
    const num = i + 1;
    const pend = needsStatus(st, m);
    const pill: CoveragePill | null = coveragePill(part, st, m, n);
    const home = st.status ? statusHome(part, st.status) : null;
    const bad = !!pill && (pill.tone === "none" || pill.tone === "ignored");
    const open = openCov.has(st.kind);
    const Icon = GLYPH[st.kind];
    const trig = triggerOf(st.kind);
    const empty = !!trig && stepIsEmpty(trig, st.blocks ?? []);
    const moveBlock = st.blocks?.find((x): x is Extract<StepBlock, { type: "move" }> => x.type === "move");
    const awaiting = pend || (!!trig && !!moveBlock && blockNeedsValue(trig, moveBlock) && !st.status);
    const stDot = st.status ? listed.find((x) => x.name.toLowerCase() === st.status!.toLowerCase()) : undefined;
    const count = home && home.counted.length === 0 && home.folded.length > 0 ? part.folded.find((f) => f.unit.statuses.some((x) => x.status.toLowerCase() === st.status!.toLowerCase())) : null;
    return (
      <article key={st.kind} data-step={st.kind} aria-label={`Step ${num}: ${m.title}`}
        {...(awaiting || empty || pill?.tone === "ignored" ? { "data-need": "" } : bad ? { "data-bad": "" } : {})} {...(hl.has(st.kind) ? { "data-hl": "" } : {})} {...(flash === st.kind ? { "data-flash": "" } : {})}
        className="wfm-step" style={{ opacity: dormant ? 0.82 : 1 }}
        onMouseEnter={() => light([st.kind], true)} onMouseLeave={() => light([st.kind], false)}
        onFocus={() => light([st.kind], true)} onBlur={() => light([st.kind], false)}>
        <header className="wfm-sh">
          <span className="wfm-pin" data-lg="" aria-hidden>{num}</span>
          <div className="flex flex-col gap-0.5 min-w-0">
            <h3 className="m-0 text-[13px] font-bold">{m.title}</h3>
            <span className="inline-flex gap-1 items-center text-[11px]" style={{ color: "var(--text3)" }}><Icon size={ICON.xs} /> Shows on {m.shows}</span>
          </div>
          <div className="wfm-acts">
            {dormant ? <Badge>Not active · changes off</Badge> : empty ? <Badge tone="warn">Needs a block</Badge> : awaiting ? <Badge tone="warn">Needs a status</Badge> : null}
            {pill && (pill.expands
              ? <button type="button" className="wfm-cov" data-tone={pill.tone} aria-expanded={open} aria-label={`Coverage: ${pill.label}. ${open ? "Hide" : "Show"} per-${n.list} detail`} onClick={() => toggleCov(st.kind)}>
                <Segs on={pill.bars} />{pill.label}<span className="cv" aria-hidden><CaretIcon size={ICON.xs} /></span></button>
              : <span className="wfm-cov" data-tone="static"><Segs on={pill.bars} />{pill.label}</span>)}
            <Button size="compact" tone="plain" data-rm="" label={`Remove step ${num}`} disabled={frozen}
              style={{ background: "transparent", border: 0, color: "var(--text3)" }}
              onClick={() => { setPicker(null); p.onRemove(st.kind); setFocusNext("[data-add]"); }}>Remove step</Button>
          </div>
        </header>
        <div className="wfm-sb">
          <div className="text-[13px]">{m.blurb}</div>
          {trig && st.blocks && (
            <>
              <StepBlocks trigger={trig} blocks={st.blocks} status={st.status} statusType={stDot?.type ?? "custom"} statusColor={stDot?.color}
                {...(awaiting ? { moveTone: "empty" as const } : pill?.tone === "ignored" ? { moveTone: "ignored" as const } : bad ? { moveTone: "bad" as const } : null)}
                n={n} frozen={frozen} people={p.people} {...(p.fields ? { fields: p.fields } : null)} statusOpen={picker?.kind === st.kind}
                onChange={(next) => p.onBlocks(st.kind, next)}
                onPickStatus={(anchor) => (picker?.kind === st.kind ? closePicker(false) : openPicker(st.kind)(anchor))} />
              <div className="text-[13px]" data-press={st.kind} style={{ color: "var(--text2)", borderLeft: "3px solid var(--text)", padding: "8px 12px", borderRadius: 10, background: "var(--bg)", boxShadow: "inset 0 0 0 1px var(--w-line)" }}>
                {blocksSentence({ lead: PRESS_LEAD[st.kind] ?? "Press it:", trigger: trig, blocks: st.blocks, item: n.item, status: st.status })}
              </div>
            </>
          )}
          {st.kind === "move" && st.also.length > 0 && <div className="text-[11px]" style={{ color: "var(--text3)" }}>If a {n.item}’s {n.list} has none of that, it tries: {st.also.join(", ")}.</div>}
          {st.implicit && st.status && <div className="text-[11px]" style={{ color: "var(--text3)" }}>The built-in default, until you choose one.</div>}
          {bad && st.status && (
            <div className="flex gap-2 items-start text-[13px]" style={{ color: pill!.tone === "ignored" ? "var(--warning-ink)" : "var(--error-ink)" }} role="status">
              <span className="shrink-0 mt-0.5"><WarningIcon size={ICON.md} /></span>
              <span>
                {pill!.tone === "ignored"
                  ? <>“{st.status}” only exists in {n.lists} you ignore ({home!.folded.join(", ")}). The control stays hidden until you count one again or pick one of your statuses.</>
                  : <>No {n.list} has a status called “{st.status}”. It may have been renamed. The control stays hidden until you pick one of your statuses.</>}
                {count && p.onCountAgain && <> <button type="button" className="wfm-again" onClick={() => p.onCountAgain!(count.unit)} style={{ fontWeight: 700, textDecoration: "underline", background: "none", border: 0, padding: 0, color: "inherit", cursor: "pointer" }}>Count {count.unit.name} again</button></>}
              </span>
            </div>
          )}
          {open && st.status && pill?.expands && (
            <div className="wfm-covd">
              {coverageRows(part, st.status).map((r) => (
                <div key={r.unit.id} className="r" {...(r.has ? { "data-y": "" } : {})}>
                  <b>{r.unit.name}{r.unit.group && <><br /><span className="font-normal text-[11px]" style={{ color: "var(--text3)" }}>{r.unit.group}</span></>}</b>
                  <span className="s" aria-hidden>{r.has ? <DoneIcon size={ICON.xs} /> : <CrossIcon size={ICON.xs} />}</span>
                  <span className="s">{r.has ? "Shows here." : `No status named “${st.status}” here, so the control is hidden.`}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </article>
    );
  };

  const loading = panel.kind === "loading" && units.length === 0;
  const momentCard = (k: StepKind) => {
    const I = GLYPH[k], m = M[k];
    const used = steps.some((x) => x.kind === k);
    return (
      <button key={k} type="button" className="wfm-mom" data-mom={k} aria-disabled={used} onClick={() => { if (!used) void chooseMoment(k); }}>
        <span className="gl"><I size={ICON.md} /></span>
        <span className="flex flex-col gap-0.5"><b className="text-[13px]">{m.title}</b>{hint(m.blurb)}
          {used ? hint("Already has a step. Remove it to add it again.", { color: "var(--warning-ink)" }) : triggerOf(k) ? hint("You add its blocks next.") : null}</span>
      </button>
    );
  };
  const kinds = STEP_ORDER.filter((k) => adapter.kinds.includes(k));
  const moments_ = <div className="wfm-moments" role="group" aria-label="Where in agentglass">{kinds.map(momentCard)}</div>;

  return (
    <section ref={root} className="wfm agx-settings-section" aria-labelledby={`${uid}-h`}>
      <style>{WFM_CSS}</style>
      <div className="agx-settings-head flex items-center gap-4 flex-wrap">
        <div className="flex flex-col gap-0.5 flex-1 min-w-0">
          <div className="agx-settings-head-t" id={`${uid}-h`}>Workflow map</div>
          {hint("Each step puts one control into agentglass. You build what it does from blocks.")}
        </div>
        <Badge tone={changesOn ? "warn" : "dim"}>{changesOn ? "Changes on" : "Changes off"}</Badge>
        {frozen && <Badge tone="warn">Paused: token refused</Badge>}
        <Button tone="primary" data-add="" aria-expanded={composer} disabled={loading || frozen}
          onClick={() => { setComposer((c) => !c); setFocusNext(composer ? "[data-add]" : "[data-mom]"); }}>
          <PlusIcon size={ICON.xs} /> Add a step
        </Button>
      </div>
      <div className="agx-settings-rows" style={{ padding: 24 }}>
        <div ref={grid} className="wfm-grid" {...(frozen ? ({ inert: "" } as object) : {})} style={{ opacity: frozen ? 0.55 : 1 }}>
          <div ref={stepsBox} className="wfm-steps">
            {!changesOn && steps.length > 0 && (
              <div className="wfm-banner" data-tone="warn" role="status"><span className="shrink-0" style={{ color: "var(--warning-ink)" }}><WarningIcon size={ICON.md} /></span>
                <div className="flex flex-col gap-1"><b>Changes are off, so no step is active.</b>{hint(`Your steps are saved. Turn on “Changes in ${n.name}” above and they appear.`, { color: "var(--warning-ink)" })}</div></div>
            )}
            {composer && !frozen && (
              <div role="group" aria-label="Add a step" className="flex flex-col gap-3 p-4 rounded-xl" style={{ background: "var(--bg)", boxShadow: "0 0 0 1px var(--primary)" }}
                onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setComposer(false); setFocusNext("[data-add]"); } }}>
                <div className="flex items-center gap-2"><h3 className="m-0 text-[13px] font-bold">Add a step</h3>{hint("Pick where the step shows up. Its blocks come next.")}<span className="flex-1" />
                  <Button size="compact" onClick={() => { setComposer(false); setFocusNext("[data-add]"); }}>Close</Button></div>
                {moments_}
              </div>
            )}
            {steps.map(stepCard)}
            {!steps.length && !composer && (loading
              ? <div className="p-6 rounded-xl" style={{ border: "1px dashed var(--w-edge)", background: "var(--bg)" }}><b className="text-[13px]">Steps appear once your statuses are read.</b><div className="mt-1 text-[11px]" style={{ color: "var(--text3)" }}>This takes a few seconds and changes nothing.</div></div>
              : (
                <div className="flex flex-col gap-3 items-start p-6 rounded-xl" style={{ border: "1px dashed var(--w-edge)", background: "var(--bg)" }}>
                  <h3 className="m-0 text-[13px] font-bold">No steps yet</h3>
                  <div className="text-[13px] max-w-[520px]">A step adds one control to a pull request, and you build what it does from blocks: move the {n.item}, take people off it, assign it. Nothing in {n.name} changes until you add one and turn changes on.</div>
                  {moments_}
                </div>
              ))}
          </div>
          {column}
          <svg ref={svg} aria-hidden className="wfm-lines" {...(changesOn ? {} : { "data-off": "" })} />
        </div>
        <div className="mt-4 text-[11px]" style={{ color: "var(--text3)" }}>
          Tab moves through the steps in order. On a status control, <kbd>Enter</kbd> opens your statuses; <kbd>↑</kbd><kbd>↓</kbd> choose, <kbd>Enter</kbd> picks, <kbd>Esc</kbd> closes. A pick costs no request.
        </div>
      </div>
      {picker && (() => {
        const st = steps.find((s) => s.kind === picker.kind);
        if (!st) return null;
        return (
          <StatusPopover anchor={picker.anchor} label={`Status for: ${M[st.kind].title}`} onClose={closePicker}>
            {statusPanel(st.kind, st.status)}
          </StatusPopover>
        );
      })()}
    </section>
  );
}
