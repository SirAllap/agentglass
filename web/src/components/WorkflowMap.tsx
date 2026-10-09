import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, EDGE, LINE, Tabs, tintEdge } from "./workspace/Chrome.tsx";
import { Select } from "./Select.tsx";
import { Dot, StatusPanel, StatusPopover, type PanelView } from "./StatusPanel.tsx";
import { ArrowIcon, CaretIcon, ListIcon, MergeIcon, NoteIcon, PlusIcon, UserIcon } from "../lib/glyphIcons.tsx";
import { ICON } from "../lib/iconSize.ts";
import {
  UNASSIGN_LABEL, addable, allStatuses, isActive, moments, needsStatus, pinsOn, reachOf, suggestStatus,
  type Moment, type Nouns, type MapSpace, type Step, type StepKind, type TrackerAdapter, type Unassign,
} from "../lib/workflowMap.ts";

/**
 * The workflow map: where in the app a step appears, tied by a line to a status
 * of the user's own.
 *
 * It knows no tracker. Words come from the adapter's nouns, the statuses from
 * the spaces it is handed, and the steps that exist from the adapter's kinds; the
 * page that mounts it decides what saving means. Nothing is offered that the
 * tracker did not send, nothing is added until it is asked for, and a step
 * without its status does nothing and says so.
 */
export interface MapProps {
  adapter: TrackerAdapter;
  spaces: MapSpace[];
  /** What the status list is doing; steps and lines stay readable under every state. */
  panel: PanelView;
  steps: Step[];
  changesOn: boolean;
  /** Paused by something outside the map (a refused token): the steps are shown and cannot be touched. */
  frozen?: boolean;
  /** Resolves false when the save failed: the composer then stays open with what was picked. */
  onAdd: (kind: StepKind, status: string | null) => Promise<boolean> | void;
  onStatus: (kind: StepKind, status: string | null) => void;
  onRemove: (kind: StepKind) => void;
  onUnassign: (v: Unassign) => void;
  onRetry: () => void;
}

const UNASSIGN_OPTIONS = (["none", "me", "all"] as const).map((v) => ({ value: v, label: UNASSIGN_LABEL[v][0]!.toUpperCase() + UNASSIGN_LABEL[v].slice(1), hint: undefined }));
/** The mark each moment wears in the map, drawn and not typed. */
export const GLYPH: Record<StepKind, (p: { size?: number }) => React.ReactElement> = { move: ArrowIcon, menu: ListIcon, merge: MergeIcon, people: UserIcon, note: NoteIcon };
function Glyph({ kind, box = 20 }: { kind: StepKind; box?: number }) {
  const I = GLYPH[kind];
  return <span aria-hidden className="inline-grid place-items-center rounded-md shrink-0" style={{ width: box, height: box, background: "color-mix(in srgb, var(--text) 10%, transparent)" }}><I size={ICON.xs} /></span>;
}
/** A reach marker: filled where the status exists, an empty ring where it does not. */
function Bullet({ on }: { on: boolean }) {
  return <span aria-hidden className="inline-block rounded-full mr-1 align-middle" style={{ width: 7, height: 7, background: on ? "var(--success)" : "transparent", border: on ? "none" : "1.5px solid var(--warning)" }} />;
}
const TYPE_WORD: Record<string, string> = { open: "not started", done: "done", closed: "closed" };

function Tag({ tone, children }: { tone: "ok" | "warn" | "dim" | "info"; children: ReactNode }) {
  const c = tone === "ok" ? "var(--success)" : tone === "warn" ? "var(--warning)" : tone === "info" ? "var(--primary)" : "var(--text)";
  const ink = tone === "ok" ? "var(--success-ink)" : tone === "warn" ? "var(--warning-ink)" : tone === "info" ? "var(--primary-ink)" : "var(--text3)";
  return (
    <span className="inline-flex items-center rounded-full px-2 text-[10.5px] whitespace-nowrap" style={{ height: 20, background: `color-mix(in srgb, ${c} ${tone === "dim" ? 8 : 18}%, transparent)`, color: ink, border: LINE }}>
      {children}
    </span>
  );
}
export { Tag };

/** A control that opens a list of the user's own statuses (or who comes off): a chip with a caret. */
function PickChip({ label, aria, gone, onOpen, ...rest }: { label: string; aria: string; gone?: boolean; onOpen: (el: HTMLElement) => void } & Record<`data-${string}`, string>) {
  return (
    <button type="button" aria-haspopup="listbox" aria-label={aria} onClick={(e) => onOpen(e.currentTarget)} {...rest}
      className="agx-chip inline-flex items-center gap-1.5 rounded-lg px-2 text-[11.5px] whitespace-nowrap align-middle mx-0.5"
      style={{
        height: 24, border: gone ? "1px dashed var(--text3)" : tintEdge("var(--primary)", 45),
        background: gone ? "transparent" : "color-mix(in srgb, var(--primary) 12%, transparent)", color: gone ? "var(--text3)" : "var(--primary-ink)",
      }}>
      {label}<span aria-hidden className="flex opacity-60"><CaretIcon size={ICON.xs} /></span>
    </button>
  );
}

function Pill({ children, sel, gone }: { children: ReactNode; sel?: boolean; gone?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-lg px-2 text-[11.5px] whitespace-nowrap align-middle"
      style={{ height: 24, border: gone ? "1px dashed var(--text3)" : EDGE, color: gone ? "var(--text3)" : sel ? "var(--primary-ink)" : "var(--text)", background: sel ? "color-mix(in srgb, var(--primary) 12%, transparent)" : "color-mix(in srgb, var(--text) 4%, transparent)" }}>
      {children}
    </span>
  );
}

function SmallBtn({ children }: { children: ReactNode }) {
  return <span className="inline-flex items-center rounded-md px-2 text-[11px]" style={{ height: 22, border: EDGE, color: "var(--text)" }}>{children}</span>;
}

/** What the step will put on screen, drawn with an invented item so a preview never shows somebody's own. */
export function Preview({ adapter, step }: { adapter: TrackerAdapter; step: { kind: StepKind; status: string | null; unassign: Unassign } }) {
  const n = adapter.nouns, sm = adapter.sample;
  const card = <><Pill><Dot type="custom" />{sm.id}</Pill><Pill><Dot type="custom" />{sm.status}</Pill></>;
  const cap = (t: ReactNode) => <div className="mt-1 text-[10.5px]" style={{ color: "var(--text3)" }}>{t}</div>;
  const row = (c: ReactNode) => <div className="flex flex-wrap gap-1.5 items-center">{c}</div>;
  switch (step.kind) {
    case "move": return step.status
      ? <>{row(<>{card}<SmallBtn>{n.move} {step.status}</SmallBtn></>)}{cap(<>Press it: {sm.status} → {step.status}{step.unassign !== "none" ? `, and ${UNASSIGN_LABEL[step.unassign]} comes off the ${n.item}` : ""}. Nothing else changes.</>)}</>
      : cap("Pick a status to see the button.");
    case "menu": return <>{row(<><Pill>Request changes</Pill><Pill>Approve</Pill>{step.status ? <Pill sel>{n.move} {step.status}</Pill> : <Pill gone>pick a status</Pill>}</>)}{cap("One more item in the review menu.")}</>;
    case "merge": return <>{row(<><span className="text-[11px]" style={{ color: "var(--text3)" }}>{n.move} {sm.id}:</span><Pill>{step.status ?? "Leave it there"}</Pill></>)}{cap(step.status ? "Preselected when you merge; you can still change it." : `Nothing is preselected: the ${n.item} stays where it is.`)}</>;
    case "people": return <>{row(<><Pill><UserIcon size={ICON.xs} /> Assigned</Pill><span className="text-[11px]" style={{ color: "var(--text3)" }}>{sm.who}, {sm.others}, +22</span></>)}{cap(`Each name is a toggle on the ${n.item}.`)}</>;
    case "note": return <>{row(<>{card}<SmallBtn><NoteIcon size={ICON.xs} /> Note</SmallBtn></>)}{cap(`Opens a box; sends a comment to the ${n.item}.`)}</>;
  }
}

/** Who comes off the item: a three-way list that takes focus once when it opens and moves it with the arrows. */
function UnassignList({ value, onPick, onEsc }: { value: Unassign; onPick: (v: Unassign) => void; onEsc: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus(); }, []);
  return (
    <div ref={ref} role="listbox" aria-label="Who comes off" className="p-1 rounded-xl" style={{ background: "var(--surface-card)", border: EDGE }}>
      {UNASSIGN_OPTIONS.map((o) => (
        <div key={o.value} role="option" tabIndex={0} aria-selected={value === o.value}
          onClick={() => onPick(o.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(o.value); }
            else if (e.key === "Escape") { e.stopPropagation(); onEsc(); }
            else if (e.key === "ArrowDown") { e.preventDefault(); ((e.currentTarget.nextElementSibling ?? e.currentTarget) as HTMLElement).focus(); }
            else if (e.key === "ArrowUp") { e.preventDefault(); ((e.currentTarget.previousElementSibling ?? e.currentTarget) as HTMLElement).focus(); }
          }}
          className="flex items-center gap-2 px-2 rounded-lg cursor-pointer text-[12px] min-h-[28px] outline-none focus-visible:ring-2"
          style={{ background: value === o.value ? "color-mix(in srgb, var(--primary) 16%, transparent)" : undefined, color: "var(--text)" }}>
          {o.label}<span className="ml-auto text-[10px]" style={{ color: "var(--text3)" }}>{o.value === "none" ? "default" : ""}</span>
        </div>
      ))}
    </div>
  );
}

export function WorkflowMap(p: MapProps) {
  const { adapter, spaces, panel, steps, changesOn, frozen } = p;
  const n = adapter.nouns;
  const M = useMemo(() => moments(n), [n]);
  const listed = useMemo(() => allStatuses(spaces), [spaces]);
  const [spaceIdx, setSpaceIdx] = useState(0);
  const space = spaces[Math.min(spaceIdx, Math.max(0, spaces.length - 1))];
  const [composer, setComposer] = useState<{ kind: StepKind | null; status: string | null } | null>(null);
  const [picker, setPicker] = useState<{ kind: StepKind; anchor: HTMLElement } | null>(null);
  const [lit, setLit] = useState<string | null>(null);
  const [flash, setFlash] = useState<StepKind | null>(null);
  const [unassignAt, setUnassignAt] = useState<HTMLElement | null>(null);
  const [focusNext, setFocusNext] = useState<string | null>(null);
  const root = useRef<HTMLElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const uid = useId();
  const dormant = !changesOn && steps.length > 0;
  const free = addable(adapter, steps);

  /* Focus lands where the person's hands were: back on the control that opened a list, on the new step, or on Add. */
  /* The target may not exist yet (a step appears only once its save lands), so the request is
     kept until it does, and dropped after two seconds rather than waiting for ever. */
  useEffect(() => {
    if (!focusNext) return;
    const el = root.current?.querySelector<HTMLElement>(focusNext);
    if (el) { el.focus(); setFocusNext(null); return; }
    const t = setTimeout(() => setFocusNext(null), 2000);
    return () => clearTimeout(t);
  }, [focusNext, steps, composer]);
  useEffect(() => { if (flash) { const t = setTimeout(() => setFlash(null), 1300); return () => clearTimeout(t); } }, [flash]);

  /* The lines. Drawn from where the chips and the status rows actually are, so
     they follow a wrapped sentence, a changed space and a resized window. */
  const draw = useCallback(() => {
    const g = grid.current, s = svg.current;
    if (!g || !s) return;
    const gb = s.getBoundingClientRect();
    let out = "";
    for (const st of steps) {
      if (!st.status || !changesOn || !isActive(st, M[st.kind])) continue;
      if (!space) continue; // nothing read yet: a line to "not in" nowhere would say something false
      const chip = g.querySelector<HTMLElement>(`[data-chip="${st.kind}"]`);
      if (!chip) continue;
      const a = chip.getBoundingClientRect(), y1 = a.top + a.height / 2 - gb.top;
      const row = [...g.querySelectorAll<HTMLElement>("[data-status]")].find((r) => r.dataset.status!.toLowerCase() === st.status!.toLowerCase());
      if (row) {
        const r = row.getBoundingClientRect(), y2 = r.top + r.height / 2 - gb.top, w = gb.width;
        out += `<path d="M0 ${y1} C${w * 0.55} ${y1} ${w * 0.45} ${y2} ${w} ${y2}" fill="none" stroke="var(--primary)" stroke-width="1.5" stroke-linecap="round"${flash === st.kind ? ' class="agx-wf-draw" pathLength="1"' : ""}/>`;
      } else {
        out += `<path d="M0 ${y1} H22" stroke="var(--warning)" stroke-width="1.5" stroke-dasharray="4 3" fill="none"/><text x="28" y="${y1 + 4}" font-size="10" fill="var(--warning-ink)">not in ${space.name.replace(/[<&]/g, "")}</text>`;
      }
    }
    s.innerHTML = out;
  }, [steps, changesOn, M, space, flash]);
  useLayoutEffect(() => { draw(); });
  useEffect(() => {
    const g = grid.current;
    if (!g || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(g);
    return () => ro.disconnect();
  }, [draw]);

  const openPicker = (kind: StepKind) => (anchor: HTMLElement) => setPicker({ kind, anchor });
  const closePicker = (refocus: boolean) => {
    if (refocus && picker) setFocusNext(`[data-chip="${picker.kind}"]`);
    setPicker(null);
    setLit(null);
  };

  const spaceWord = n.space[0]!.toUpperCase() + n.space.slice(1);
  const lane = (
    <div className="px-3 pt-2.5 pb-3.5" style={{ borderLeft: LINE, background: "var(--surface-nav)" }}>
      <h3 className="m-0 mb-2 text-[12px] font-semibold flex items-center gap-1.5" style={{ color: "var(--text)" }}>Your statuses in</h3>
      {panel.kind === "loading" && spaces.length === 0 ? null : spaces.length > 1 && (
        spaces.length <= 5
          ? <div className="mb-2"><Tabs label={`${spaceWord}s`} value={String(Math.min(spaceIdx, spaces.length - 1))} onChange={(v) => setSpaceIdx(Number(v))} options={spaces.map((s, i) => ({ id: String(i), label: s.name }))} /></div>
          : <div className="mb-2 flex items-center gap-2"><Select value={String(Math.min(spaceIdx, spaces.length - 1))} onChange={(v) => setSpaceIdx(Number(v))} title={`${spaceWord}: ${space?.name ?? ""}`}
              options={spaces.map((s, i) => ({ value: String(i), label: s.name, hint: `${s.statuses.length} statuses` }))} />
              <span className="text-[11px] tabular-nums" style={{ color: "var(--text3)" }}>{Math.min(spaceIdx, spaces.length - 1) + 1}/{spaces.length}</span></div>
      )}
      <div role="group" aria-label={`Statuses in ${space?.name ?? ""}`}>
        {panel.kind === "loading" && !space
          ? [70, 50, 65, 45, 60, 40].map((w, i) => <div key={i} className="px-2 py-2"><div className="rounded" style={{ width: `${w}%`, height: 12, background: "var(--surface-inset)" }} /></div>)
          : !space || space.statuses.length === 0
            ? <div className="py-2 text-[12px]" style={{ color: "var(--text3)" }}>{space ? `This ${n.space} has no statuses we can read.` : `No ${n.spaces} to show.`}</div>
            : space.statuses.map((s) => {
              const pins = pinsOn(steps.filter((x) => changesOn && isActive(x, M[x.kind])), s.status);
              return (
                <div key={s.status} data-status={s.status} className="flex items-center gap-2 px-2 rounded-lg text-[12px] mb-1"
                  style={{
                    minHeight: 32, color: "var(--text)",
                    background: pins.length ? "var(--surface-card)" : lit && lit.toLowerCase() === s.status.toLowerCase() ? "color-mix(in srgb, var(--primary) 14%, transparent)" : "transparent",
                    border: pins.length ? EDGE : lit && lit.toLowerCase() === s.status.toLowerCase() ? tintEdge("var(--primary)", 100) : tintEdge("transparent", 0),
                  }}>
                  <Dot type={s.type} color={s.color} /><span className="truncate">{s.status}</span>
                  {pins.map((k) => { const I = GLYPH[k]; return <span key={k} title={M[k].title} className="shrink-0 inline-grid place-items-center rounded-full" style={{ minWidth: 18, height: 18, background: "var(--primary)", color: "var(--bg)" }}><I size={ICON.xs} /></span>; })}
                  <span className="ml-auto text-[10px] whitespace-nowrap" style={{ color: "var(--text3)" }}>{TYPE_WORD[s.type] ?? "in flight"}</span>
                </div>
              );
            })}
      </div>
      {space && panel.kind !== "loading" && <p className="mt-2 mb-0 mx-0.5 text-[11px]" style={{ color: "var(--text3)" }}>A pin is a step that points here. Each {n.space} keeps its own statuses.</p>}
    </div>
  );

  const stepRow = (st: Step, i: number) => {
    const m: Moment = M[st.kind];
    const r = reachOf(spaces, st, m);
    const pend = needsStatus(st, m);
    const verb = `${n.verb.toLowerCase()}s`;
    const chip = (gone: boolean, label: string) => (
      <PickChip data-chip={st.kind} gone={gone} label={gone ? "choose a status…" : label} onOpen={openPicker(st.kind)}
        aria={`${m.title}: ${gone ? "choose a status" : `status ${label}`}. Change`} />
    );
    return (
      <div key={st.kind} data-step={st.kind} className="relative agx-settings-x py-3.5"
        style={{
          borderTop: i ? LINE : undefined, opacity: dormant ? 0.6 : 1,
          background: flash === st.kind ? "color-mix(in srgb, var(--primary) 12%, transparent)" : pend ? "color-mix(in srgb, var(--primary) 5%, transparent)" : undefined,
          transition: "background-color 1.2s var(--agx-settle, cubic-bezier(.23,1,.32,1))",
        }}>
        <div className="flex items-center gap-2 pr-20">
          <Glyph kind={st.kind} />
          <span className="font-semibold text-[13px]" style={{ color: "var(--text)" }}>{m.title}</span>
          {dormant ? <Tag tone="dim">dormant: changes are off</Tag> : pend ? <Tag tone="warn">needs a status</Tag> : null}
        </div>
        <div className="mt-2 ml-7 text-[12.5px] leading-[1.9]" style={{ color: "var(--text3)" }}>
          {st.kind === "move" && <>
            <div>Adds a button to the pull request’s {n.item} block. It {verb} the {n.item} to {chip(!st.status, st.status ?? "")}</div>
            {st.also.length > 0 && <div className="text-[11.5px]">If a {n.item}’s list has none of that, it tries: {st.also.join(", ")}.</div>}
            <div>Also takes <PickChip data-chip="unassign" label={UNASSIGN_LABEL[st.unassign]} aria={`Who comes off the ${n.item}: ${UNASSIGN_LABEL[st.unassign]}. Change`} onOpen={(el) => setUnassignAt(el)} /> off the {n.item}.</div>
          </>}
          {st.kind === "menu" && <div>Adds an item to the review menu. It {verb} the {n.item} to {chip(!st.status, st.status ?? "")}</div>}
          {st.kind === "merge" && <div>Adds a choice to the merge dialog, preselected to {chip(false, st.status ?? "Leave it there")}</div>}
          {st.kind === "people" && <div>Adds an Assigned list to the review menu: the {n.item}’s members, each a toggle.</div>}
          {st.kind === "note" && <div>Adds a “Note” button to the pull request’s {n.item} block. It writes a comment on the {n.item}.</div>}
        </div>
        {st.implicit && st.status && <div className="mt-1 ml-7 text-[11.5px]" style={{ color: "var(--text3)" }}>The built-in default, until you choose one.</div>}
        <div className="mt-2 ml-7 text-[11px] flex flex-wrap gap-x-2.5 gap-y-1" style={{ color: "var(--text3)" }}>
          {r.kind === "everywhere" && <span style={{ color: "var(--success-ink)" }}><Bullet on />Works in every {n.space}</span>}
          {r.kind === "none-needed" && <span>No status: nothing moves.</span>}
          {r.kind === "pending" && <span style={{ color: "var(--warning-ink)" }}>Not active until you pick a status.</span>}
          {r.kind === "all" && <span style={{ color: "var(--success-ink)" }}><Bullet on />In all {r.count} {n.spaces}</span>}
          {r.kind === "some" && (r.total <= 5
            ? spaces.map((s) => r.has.includes(s.name)
              ? <span key={s.id} style={{ color: "var(--success-ink)" }}><Bullet on />{s.name}</span>
              : <span key={s.id} style={{ color: "var(--warning-ink)" }}><Bullet on={false} />{s.name}: no such status — the button is absent</span>)
            : <><span style={{ color: "var(--success-ink)" }}><Bullet on />{r.has.length} of {r.total} {n.spaces}</span><span style={{ color: "var(--warning-ink)" }}><Bullet on={false} />absent in {r.missing.join(", ")}</span></>)}
        </div>
        <div role="group" aria-label="Preview" className="mt-2.5 ml-7 rounded-lg px-2.5 py-2 text-[11.5px]" style={{ border: "1px dashed color-mix(in srgb, var(--text) 25%, transparent)", background: "var(--bg)" }}>
          <Preview adapter={adapter} step={st} />
          <div className="mt-1 text-[10.5px]" style={{ color: "var(--text3)" }}>Shows on: {m.shows}</div>
        </div>
        <span className="absolute" style={{ top: 10, right: 14 }}>
          <Button size="compact" label={`Remove step: ${m.title}`} onClick={() => { p.onRemove(st.kind); setFocusNext("[data-add]"); }} disabled={frozen}>Remove</Button>
        </span>
      </div>
    );
  };

  const move = steps.find((s) => s.kind === "move");

  const doAdd = async () => {
    if (!composer?.kind) return;
    const k = composer.kind;
    const ok = await p.onAdd(composer.kind, composer.status);
    if (ok === false) return;
    setComposer(null);
    setFlash(k);
    setFocusNext(`[data-step="${k}"] button`);
  };

  const cmpPanel = (kind: StepKind) => (
    <StatusPanel nouns={n} spaces={spaces} listed={listed} view={panel} current={composer?.status} leave={M[kind].optional}
      suggested={suggestStatus(adapter, kind, listed)} onActive={setLit} onRetry={p.onRetry}
      onPick={(v) => { setComposer((c) => c && { ...c, status: v }); setFocusNext("[data-cadd]"); }}
      onClose={() => { setComposer(null); setFocusNext("[data-add]"); }} />
  );

  const composerCard = composer && (
    <div role="group" aria-label="Add a step" className="agx-settings-x py-3.5" style={{ borderTop: LINE, background: "var(--surface-nav)" }}
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setComposer(null); setFocusNext("[data-add]"); } }}>
      <p className="m-0 mb-1 font-semibold text-[13px]" style={{ color: "var(--text)" }}>Add a step</p>
      <p className="m-0 mb-2.5 text-[12px]" style={{ color: "var(--text3)" }}>
        {!composer.kind ? "Choose where in agentglass the step appears." : M[composer.kind].needs ? `Now pick a status. Only statuses from your own ${n.spaces} are offered.` : "This step needs no status."}
      </p>
      <div className="grid gap-4" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,260px)" }}>
        <div>
          {composer.kind ? (
            <div className="flex items-center gap-2.5 rounded-xl px-2.5 py-2" style={{ border: tintEdge("var(--primary)", 100), background: "color-mix(in srgb, var(--primary) 10%, transparent)" }}>
              <Glyph kind={composer.kind} />
              <span className="flex-1 min-w-0"><b className="font-semibold text-[12.5px]">{M[composer.kind].title}</b><br /><span className="text-[11.5px]" style={{ color: "var(--text3)" }}>{M[composer.kind].blurb}</span></span>
              <Button size="compact" onClick={() => { setComposer({ kind: null, status: null }); setFocusNext('[role="radio"]'); }}>Change</Button>
            </div>
          ) : (
            <div role="radiogroup" aria-label="Where in agentglass" className="grid gap-1.5">
              {free.length ? free.map((k, i) => (
                <button key={k} type="button" role="radio" aria-checked={false} tabIndex={i === 0 ? 0 : -1}
                  onClick={() => { setComposer({ kind: k, status: null }); setFocusNext(M[k].needs ? '[role="combobox"]' : "[data-cadd]"); }}
                  onKeyDown={(e) => {
                    const all = [...(e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="radio"]') ?? [])];
                    const at = all.indexOf(e.currentTarget);
                    const d = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
                    if (d) { e.preventDefault(); all[(at + d + all.length) % all.length]?.focus(); }
                  }}
                  className="flex gap-2.5 items-start text-left rounded-xl px-2.5 py-2" style={{ border: EDGE, background: "var(--bg)", color: "var(--text)" }}>
                  <Glyph kind={k} />
                  <span><b className="font-semibold text-[12.5px]">{M[k].title}</b><br /><span className="text-[11.5px]" style={{ color: "var(--text3)" }}>{M[k].blurb}</span></span>
                </button>
              )) : <p className="m-0 text-[12px]" style={{ color: "var(--text3)" }}>Every moment already has a step. Remove one to add it again.</p>}
            </div>
          )}
          {composer.kind && M[composer.kind].needs && <div className="mt-2.5">{cmpPanel(composer.kind)}</div>}
        </div>
        <div>
          <div className="mb-1.5 text-[11.5px]" style={{ color: "var(--text3)" }}>What you will get</div>
          <div className="rounded-xl p-2.5 text-[11.5px]" style={{ border: EDGE, background: "var(--bg)" }}>
            {composer.kind ? <Preview adapter={adapter} step={{ kind: composer.kind, status: composer.status, unassign: "none" }} /> : <span style={{ color: "var(--text3)" }}>Pick a moment to preview it.</span>}
          </div>
          {!changesOn && <p className="mt-2 mb-0 text-[11.5px]" style={{ color: "var(--text3)" }}>Adding the first step turns on changes in {n.name}. It stays off until you do.</p>}
        </div>
      </div>
      {(() => {
        const ready = !!composer.kind && (!M[composer.kind].needs || M[composer.kind].optional || !!composer.status);
        return (
          <div className="mt-3 flex items-center gap-2 flex-wrap">
            <Button tone="primary" disabled={!ready} onClick={() => void doAdd()} data-cadd="">Add step</Button>
            <Button onClick={() => { setComposer(null); setFocusNext("[data-add]"); }}>Cancel</Button>
            <span className="text-[11.5px]" style={{ color: "var(--text3)" }}>{composer.kind && !ready ? "Pick a status to enable Add step." : ""}</span>
          </div>
        );
      })()}
    </div>
  );

  const loading = panel.kind === "loading" && spaces.length === 0;
  return (
    <section ref={root} className="agx-settings-section" aria-labelledby={`${uid}-h`}>
      <div className="agx-settings-head flex items-center gap-2.5 flex-wrap">
        <div className="agx-settings-head-t" id={`${uid}-h`}>Workflow map</div>
        <Tag tone={changesOn ? "warn" : "dim"}>{changesOn ? "changes on" : "read-only"}</Tag>
        {frozen && <Tag tone="warn">paused: token refused</Tag>}
        <span className="flex-1" />
        <Button size="compact" tone="primary" data-add="" aria-expanded={!!composer} disabled={loading || frozen}
          onClick={() => { setComposer((c) => (c ? null : { kind: null, status: null })); setFocusNext(composer ? "[data-add]" : '[role="radio"]'); }}>
          <PlusIcon size={ICON.xs} /> Add a step
        </Button>
      </div>
      <div className="agx-settings-rows" style={{ padding: 0 }}>
        <div ref={grid} className="relative grid" {...(frozen ? ({ inert: "" } as object) : {})} style={{ gridTemplateColumns: "minmax(0,1fr) 84px 300px", opacity: frozen ? 0.55 : 1 }}>
          <div>
            {steps.length
              ? steps.map(stepRow)
              : loading
                ? <div className="agx-settings-x py-6"><div className="font-semibold text-[13px]">Steps appear once your statuses are read.</div><p className="mt-1 mb-0 text-[12px]" style={{ color: "var(--text3)" }}>This takes a few seconds and changes nothing.</p></div>
                : (
                  <div className="agx-settings-x py-6">
                    <div className="font-semibold text-[13px]" style={{ color: "var(--text)" }}>No steps. agentglass only reads.</div>
                    <p className="mt-1 mb-2.5 text-[12px] max-w-[60ch]" style={{ color: "var(--text3)" }}>
                      Your {n.items} and pull requests show up as they are. Add a step when you want a button or a menu item that moves a {n.item} to one of your own statuses.
                    </p>
                    <Button tone="primary" data-add="" onClick={() => { setComposer({ kind: null, status: null }); setFocusNext('[role="radio"]'); }}>Add a step</Button>
                  </div>
                )}
          </div>
          <div className="relative"><svg ref={svg} aria-hidden className="absolute inset-0 w-full h-full overflow-visible pointer-events-none" /></div>
          {lane}
        </div>
        {!frozen && !loading && composerCard}
        <div className="agx-settings-x py-2.5 text-[11px]" style={{ borderTop: "1px dashed color-mix(in srgb, var(--text) 25%, transparent)", color: "var(--text3)" }}>
          Tab moves through the steps in order. On a status chip, <kbd>Enter</kbd> opens your statuses; <kbd>↑</kbd><kbd>↓</kbd> choose, <kbd>Enter</kbd> picks, <kbd>Esc</kbd> closes. A pick costs no request.
        </div>
      </div>
      {picker && (() => {
        const st = steps.find((s) => s.kind === picker.kind);
        if (!st) return null;
        const m = M[st.kind];
        return (
          <StatusPopover anchor={picker.anchor} label={`Status for: ${m.title}`} onClose={closePicker}>
            <StatusPanel nouns={n} spaces={spaces} listed={listed} view={panel} current={st.status ?? ""} leave={m.optional}
              suggested={suggestStatus(adapter, st.kind, listed)} onActive={setLit} onRetry={p.onRetry}
              onPick={(v) => { setPicker(null); setLit(null); p.onStatus(st.kind, v); setFlash(st.kind); setFocusNext(`[data-chip="${st.kind}"]`); }}
              onClose={() => closePicker(true)} />
          </StatusPopover>
        );
      })()}
      {unassignAt && move && (
        <StatusPopover anchor={unassignAt} label={`Who comes off the ${n.item}`} onClose={(f) => { setUnassignAt(null); if (f) setFocusNext('[data-chip="unassign"]'); }}>
          <UnassignList value={move.unassign}
            onPick={(v) => { p.onUnassign(v); setUnassignAt(null); setFocusNext('[data-chip="unassign"]'); }}
            onEsc={() => { setUnassignAt(null); setFocusNext('[data-chip="unassign"]'); }} />
        </StatusPopover>
      )}
      <style>{`@keyframes agx-wf-draw { from { stroke-dasharray: 1; stroke-dashoffset: 1 } to { stroke-dasharray: 1; stroke-dashoffset: 0 } } .agx-wf-draw { animation: agx-wf-draw 380ms cubic-bezier(.23,1,.32,1) } @media (prefers-reduced-motion: reduce) { .agx-wf-draw { animation: none } }`}</style>
    </section>
  );
}
