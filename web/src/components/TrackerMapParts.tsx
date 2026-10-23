import { useEffect, useRef, useState, type ReactNode } from "react";
import { INPUT, INPUT_STYLE, Button, LINE } from "./workspace/Chrome.tsx";
import { SettingRow } from "./SettingRow.tsx";
import { SettingsCard } from "./SettingsKit.tsx";
import { Dot } from "./StatusPanel.tsx";
import { Badge } from "./WorkflowMap.tsx";
import { DoneIcon, LinkIcon, NoteIcon, UserIcon } from "../lib/glyphIcons.tsx";
import { ICON } from "../lib/iconSize.ts";
import { blocksSentence, peopleButtonLabel } from "../lib/stepBlocksView.ts";
import { assignWords } from "../lib/stepAssign.ts";
import { countedIds, movesNothing, type MapSpace, type Nouns, type Step, type StepKind, type TrackerAdapter } from "../lib/workflowMap.ts";

/*
 * The parts of a tracker's Settings page that are the same for every tracker: the
 * section card, a pattern row, the picker of which units count, and the two small
 * drawings under "Where this shows up". They take the adapter's nouns and its
 * invented sample, so a tracker's words are never written here.
 */

/** One name-or-pattern row. A value equal to the shipped one shows as empty, so the placeholder says what applies. */
export function TextRow({ label, hint, value, fallback = "", placeholder, onSave, id }: {
  label: string; hint: ReactNode; value: string; fallback?: string; placeholder: string; id?: string;
  onSave: (v: string) => Promise<string | null>;
}) {
  const saved = value === fallback ? "" : value;
  const [draft, setDraft] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const commit = async () => {
    if (draft === null) return;
    if (draft.trim() === saved) { setDraft(null); setErr(null); return; }
    const e = await onSave(draft);
    setErr(e);
    if (!e) setDraft(null);
  };
  return (
    /* A text field stacks under its description (see SettingRow's `below`):
       squeezed into the control column it showed a third of a pattern. */
    <SettingRow label={label} hint={hint}
      below={<div className="flex flex-col gap-1.5" style={{ maxWidth: 480 }}>
        <input id={id} value={draft ?? saved} onChange={(e) => setDraft(e.target.value)} onBlur={() => void commit()}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          aria-label={label} placeholder={placeholder} spellCheck={false} autoComplete="off"
          className={`w-full ${INPUT}`} style={INPUT_STYLE} />
        {err && <span role="alert" className="agx-field-e">{err}</span>}
      </div>} />
  );
}

/** A section of the page: a settings card (SettingsKit). `open`/`onToggle` make its header a disclosure. */
export function Card({ title, status, actions, children, open, onToggle, desc }: { id?: string; title: string; status?: ReactNode; actions?: ReactNode; desc?: ReactNode; children: ReactNode; open?: boolean; onToggle?: (o: boolean) => void }) {
  return (
    <SettingsCard title={title} desc={desc} status={status} actions={actions}
      fold={onToggle ? { open: !!open, onToggle } : undefined}>
      {children}
    </SettingsCard>
  );
}

export const hint = (c: ReactNode, style?: object) => <span className="text-[11px]" style={{ color: "var(--text3)", ...style }}>{c}</span>;
export const Tagged = ({ children }: { children: ReactNode }) => (
  <span className="inline-flex items-center gap-1 px-2 rounded-md text-[11px]" style={{ height: 20, background: "var(--bg)", boxShadow: "inset 0 0 0 1px var(--surface-line)" }}>{children}</span>
);

export const ago = (at: number): string => {
  const m = Math.max(0, Math.round((Date.now() - at) / 60_000));
  return m < 1 ? "just now" : m === 1 ? "1 min ago" : m < 120 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

/** Which spaces count: a checklist over every space the page knows, in a popover. Ignoring one folds it away; it is not deleted. */
export function CountedPicker({ n, units, chosen, onChange, onReset, onClose }: { n: Nouns; units: readonly MapSpace[]; chosen: boolean; onChange: (ids: string[]) => void; onReset: () => void; onClose: () => void }) {
  const all = units.filter((u) => !u.fromList);
  const [last, setLast] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.querySelector<HTMLElement>("[role=option]")?.focus(); }, []);
  /* The ticks follow the press at once and the saved answer catches up: two presses in a row each start from the last one. */
  const [ids, setIds] = useState(() => countedIds(units));
  useEffect(() => { setIds(countedIds(units)); }, [units]);
  const toggle = (u: MapSpace) => {
    const next = ids.includes(u.id) ? ids.filter((x) => x !== u.id) : [...ids, u.id];
    setLast(next.length === 0);
    if (!next.length) return;
    setIds(next);
    onChange(next);
  };
  return (
    <div ref={ref} className="wfm wfm-pop" role="listbox" aria-multiselectable="true" onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}
      aria-label={`${n.spaces[0]!.toUpperCase()}${n.spaces.slice(1)} that count`}>
      <div className="px-2 pt-1 pb-1 text-[11px]" style={{ color: "var(--text3)" }}>Steps are judged against the {n.spaces} that count. Ignoring one folds it away; it is not deleted.</div>
      <div className="wfm-lst">
        {all.map((u) => (
          <button key={u.id} type="button" role="option" aria-selected={ids.includes(u.id)} className="wfm-opt" onClick={() => toggle(u)}>
            <span className="ck" aria-hidden>{ids.includes(u.id) ? <DoneIcon size={ICON.xs} /> : null}</span>
            <span className="n"><b>{u.name}</b>{u.group && <span className="block text-[11px]" style={{ color: "var(--text3)" }}>{u.group}</span>}</span>
            <span className="m">{u.statuses.length} statuses</span>
          </button>
        ))}
      </div>
      {last && <div role="status" className="px-2 text-[11px]" style={{ color: "var(--warning-ink)" }}>At least one {n.space} has to count: with none there is no status to pick.</div>}
      {chosen && <div className="pt-1" style={{ borderTop: LINE }}><Button size="compact" onClick={onReset}>Back to the default</Button></div>}
    </div>
  );
}

/** The part of a mini view that a hovered step adds: it lights up, so the person sees where the step lands. */
const lit = (hover: StepKind | null, k: StepKind) => (hover === k ? "wfm-hlx" : undefined);
function Mini({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-2 items-center p-3 rounded-xl" style={{ background: "var(--surface-inset)", boxShadow: "inset 0 0 0 1px var(--surface-line)" }}>{children}</div>;
}
function Pane({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-3 p-4 rounded-xl" style={{ background: "var(--bg)", boxShadow: "0 0 0 1px var(--w-edge, var(--border))" }}>{children}</div>;
}
function Menu({ children }: { children: ReactNode }) {
  return <div className="flex flex-col overflow-hidden rounded-xl" style={{ boxShadow: "inset 0 0 0 1px var(--surface-line)" }}>{children}</div>;
}
const Item = ({ children, cls }: { children: ReactNode; cls?: string }) => (
  <div className={`px-3 py-2 text-[13px] flex gap-2 items-center ${cls ?? ""}`} style={{ borderTop: LINE }}>{children}</div>
);
/* A drawing of a pill inside a mock card: flat fill and no outline, because an outlined pill is how a control looks here and these press nothing. */
const Chip2 = ({ children, cls }: { children: ReactNode; cls?: string }) => (
  <span className={`inline-flex items-center gap-1 px-2 rounded-md text-[11px] font-semibold cursor-default select-none ${cls ?? ""}`} style={{ height: 24, background: "color-mix(in srgb, var(--text) 7%, transparent)" }}>{children}</span>
);

export function PrView({ adapter, status, steps, all, writes, hover, linked }: { adapter: TrackerAdapter; /** The sample card's status: one of the person's own, never a built-in word. */ status: string; steps: Step[]; all: Step[]; writes: boolean; hover: StepKind | null; linked: boolean }) {
  const n = adapter.nouns;
  const sm = { ...adapter.sample, status };
  const g = (k: string) => steps.find((s) => s.kind === k);
  const mv = g("move"), mn = g("menu"), pp = g("people"), nt = g("note");
  const mg = all.find((s) => s.kind === "merge");
  /* A button shows once it does something: a status to move to, or people to change. */
  const mvOn = !!mv && (!!mv.status || (movesNothing(mv) && (mv.unassign !== "none" || mv.assign.who !== "none")));
  /* Jira has no review menu: its hand-off and its review are each a button on the card, and a step that has any block at all gets one. */
  const buttons = adapter.tracker === "jira" ? steps.filter((x) => (x.kind === "move" || x.kind === "menu") && !!x.blocks?.length) : [];
  const jiraLabel = (x: Step) => (x.status ? `${n.move} ${x.status}` : x.kind === "move" ? "Hand off" : "Review");
  return (
    <Pane>
      <div className="flex gap-2 items-center text-[13px]"><Chip2>Open</Chip2><b>#318</b>{hint("orbit/api · 12 checks passed")}</div>
      <div className="text-[13px]">{sm.title}</div>
      {linked ? (
        <>
          <Mini>
            <Chip2><Dot type="custom" />{sm.id}</Chip2><Chip2><Dot type="custom" />{sm.status}</Chip2>
            {adapter.tracker === "jira"
              ? buttons.map((x) => <span key={x.kind} data-slot="button" className="contents"><Chip2 cls={lit(hover, x.kind)}>{jiraLabel(x)}</Chip2></span>)
              : mvOn && <Chip2 cls={lit(hover, "move")}>{mv!.status ? `${n.move} ${mv!.status}` : peopleButtonLabel(mv!)}</Chip2>}
            {nt && <Chip2 cls={lit(hover, "note")}><NoteIcon size={ICON.xs} /> Note</Chip2>}
            {!mvOn && !nt && !buttons.length && hint("No control from a step here.")}
          </Mini>
          {adapter.tracker === "jira" && buttons.map((x) => <div key={x.kind} className={lit(hover, x.kind)} data-preview={x.kind}>{hint(blocksSentence({ lead: "Press the button:", trigger: x.kind === "move" ? "move" : "menu", blocks: x.blocks ?? [], item: n.item, status: x.status }))}</div>)}
          {adapter.tracker !== "jira" && mvOn && <div className={lit(hover, "move")} data-preview="move">{hint(blocksSentence({ lead: "Press the button:", trigger: "move", blocks: mv!.blocks ?? [], item: n.item, status: mv!.status }))}</div>}
          <Menu>
            <div className="px-3 py-2 text-[13px]">Request changes</div>
            <Item>Approve</Item>
            {adapter.tracker !== "jira" && mn?.status && <Item cls={lit(hover, "menu")}><span style={{ color: "var(--primary)", fontWeight: 700 }}>{n.move} {mn.status}</span>{assignWords(mn.assign) && hint(`and assigns ${assignWords(mn.assign)}`)}</Item>}
            {adapter.tracker !== "jira" && mn && !mn.status && movesNothing(mn) && mn.assign.who !== "none" && <Item cls={lit(hover, "menu")}><span style={{ color: "var(--primary)", fontWeight: 700 }}>{peopleButtonLabel(mn)}</span></Item>}
            {pp && <Item cls={lit(hover, "people")}><UserIcon size={ICON.xs} />Assigned · {sm.who}, {sm.others}</Item>}
          </Menu>
          {hint(mg && writes ? <>Merge dialog: <span className={lit(hover, "merge")} style={{ fontWeight: 700, color: "var(--text)" }}>{n.move} {sm.id} to {mg.status ?? "Leave it there"}</span>{mg.status && assignWords(mg.assign) && <> and assigns {assignWords(mg.assign)}</>}</> : "Merge dialog: no extra option.")}
        </>
      ) : (
        <>
          <Mini>{hint(`No ${n.item} is linked to this pull request, so none of the steps show on it.`)}</Mini>
          <Menu><div className="px-3 py-2 text-[13px]">Request changes</div><Item>Approve</Item><Item><LinkIcon size={ICON.xs} />Link a {n.item}… {hint("this machine only")}</Item></Menu>
        </>
      )}
    </Pane>
  );
}

export function CardView({ adapter, status, writes, linked }: { adapter: TrackerAdapter; status: string; writes: boolean; linked: boolean }) {
  const n = adapter.nouns;
  const sm = { ...adapter.sample, status };
  return (
    <Pane>
      <div className="flex gap-2 items-center text-[13px]"><b>{linked ? sm.id : `No ${n.item}`}</b>{linked && <Chip2><Dot type="custom" />{sm.status}</Chip2>}{linked && !writes && <Badge>Read-only</Badge>}</div>
      {linked ? (
        <>
          <div className="text-[13px]">{sm.title}</div>
          {hint(`${sm.who}, ${sm.others} · High`)}
          <Mini>{hint("Pull requests")}<Chip2>Open</Chip2><span className="text-[13px]">#318 Retry the webhook…</span></Mini>
          <div className="flex gap-2"><Chip2>Assign</Chip2><Chip2>Comment</Chip2></div>
          {!writes && hint("Read-only until you turn on changes.")}
        </>
      ) : hint(`Link a pull request to a ${n.item} to see the ${n.item} here.`)}
    </Pane>
  );
}
