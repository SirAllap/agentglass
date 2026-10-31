import { useId, useRef, useState, type ReactNode } from "react";
import "./pilotSettings.css";
import { api } from "../../lib/api.ts";
import type { Actor, Pilot, PilotSettings, PilotSnapshot } from "../../lib/flightPilot.ts";
import { CommentIcon, CrossIcon as XIcon, EditIcon, FlagIcon, HandIcon, LockIcon, MergeIcon, PlusIcon as AddIcon, StarIcon, UserIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import {
  DEFAULT_PILOT_SETTINGS, fmtUsd, meter, nowLine, parseUsd, track,
  type Field, type RowNote, type StationKey, type UsdField,
} from "../../lib/pilotSettings.ts";
import { projectName } from "../../lib/flightPlan.ts";
import { pickProject } from "../../lib/flightProjects.ts";
import { ShieldIcon } from "../settingsNavIcons.tsx";
import { EyeIcon, PlaneIcon, TickIcon, WrenchIcon } from "./fpIcons.tsx";
import { ProjectsCard, type ProjectRow } from "./ProjectsCard.tsx";
import { usePilotSettings } from "./usePilotSettings.ts";

const CoinIcon = ({ size = ICON.md }: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" /><path d="M14.5 9.2c-.4-.8-1.4-1.2-2.5-1.2-1.4 0-2.5.7-2.5 1.8s1 1.6 2.5 2 2.5.8 2.5 2-1.1 1.9-2.5 1.9c-1.2 0-2.2-.5-2.6-1.4M12 6.5V8m0 8v1.5" />
  </svg>
);

const STEP_ICON: Record<StationKey, (p: { size?: number }) => ReactNode> = {
  create: AddIcon, write: EditIcon, review: EyeIcon, answer: CommentIcon, go: FlagIcon, launch: PlaneIcon, build: WrenchIcon, integrate: MergeIcon,
};
const MODES: { id: Pilot; name: string; actor: Actor; Icon: (p: { size?: number }) => ReactNode; text: string }[] = [
  { id: "manual", name: "Manual", actor: "person", Icon: UserIcon, text: "You say every Go and answer every finding. The orchestrator may draft plans and suggest answers." },
  { id: "copilot", name: "Co-pilot", actor: "coordinator", Icon: StarIcon, text: "The orchestrator writes, runs Preflight and answers it. You get one card per plan: Go or No-go." },
  { id: "autopilot", name: "Autopilot", actor: "coordinator", Icon: PlaneIcon, text: "The orchestrator also says Go. It stops and asks you only for the reasons on the right." },
];
const SUMMARY: Record<Pilot, ReactNode> = {
  manual: <>In Manual <b>you</b> say every Go and answer every finding. <b>The orchestrator</b> may draft plans and suggest answers. Nothing leaves this machine.</>,
  copilot: <>In Co-pilot <b>you</b> say Go or No-go, once per plan. <b>The orchestrator</b> writes, runs Preflight, answers it and follows the builder. Nothing leaves this machine.</>,
  autopilot: <>In Autopilot <b>you</b> create plans when you want to and answer <b>one question</b> when asked. <b>The orchestrator</b> does everything else up to merging into your local main. Nothing leaves this machine.</>,
};
const MODELS = [["sonnet", "Sonnet 5.5"], ["opus", "Opus"], ["haiku", "Haiku"]] as const;
const PERMS = [["default", "Ask"], ["auto", "Auto"], ["bypassPermissions", "Bypass"]] as const;
/** Each fixed refusal; a note says how far it is enforced, and every chip keeps its size. */
const NEVER: readonly (readonly [string, string?])[] = [["Pushes"], ["Opens a PR"], ["Merges"], ["Releases"], ["Leaves its worktree", "File edits enforced, shell checked, scripts by brief."], ["Changes settings"]];
const ORDINAL = ["second", "third", "fourth"];

type Ids = { lb: string; db: string };

/** One settings row. The note replaces the hint in the same slot, so an error never makes the row taller. */
function PilotRow({ title, hint, note, saving, extra, children }: {
  title: ReactNode; hint: ReactNode; note?: RowNote; saving?: boolean; extra?: ReactNode; children: (ids: Ids) => ReactNode;
}) {
  const id = useId();
  const ids = { lb: `${id}t`, db: `${id}d` };
  return (
    <div className="ps-row" data-saving={saving || undefined}>
      <div>
        <div className="ps-t" id={ids.lb}>{title}</div>
        <div className="ps-s" id={ids.db} data-tone={note?.kind} aria-live="polite">
          {note ? <>{note.kind === "lock" && <LockIcon size={ICON.xs} />}{note.text}</> : hint}
        </div>
        {extra}
      </div>
      <div className="ps-rc" aria-busy={saving || undefined}>{children(ids)}</div>
    </div>
  );
}

function Head({ icon, title, sub, badge }: { icon: ReactNode; title: string; sub: string; badge?: ReactNode }) {
  return (
    <div className="ps-ch">
      <span className="ps-ci">{icon}</span>
      <div><h4>{title}</h4><p>{sub}</p></div>
      {badge}
    </div>
  );
}

/** A segmented choice of real radios: one tab stop, arrow keys move and choose. */
function Seg<T extends string | number>({ value, options, onPick, ids, disabled }: {
  value: T; options: readonly (readonly [T, string])[]; onPick: (v: T) => void; ids: Ids; disabled?: boolean;
}) {
  const name = useId();
  return (
    <div className="ps-seg" role="radiogroup" aria-labelledby={ids.lb} aria-describedby={ids.db}>
      {options.map(([v, w]) => (
        <label key={String(v)} className="ps-seg-o">
          <input className="ps-in" type="radio" name={name} checked={value === v} disabled={disabled} onChange={() => onPick(v)} />
          <span>{w}</span>
        </label>
      ))}
    </div>
  );
}

function Switch({ on, onToggle, ids, disabled }: { on: boolean; onToggle: () => void; ids: Ids; disabled?: boolean }) {
  return <button type="button" className="ps-tog" role="switch" aria-checked={on} aria-labelledby={ids.lb} aria-describedby={ids.db} disabled={disabled} onClick={onToggle} />;
}

/** A dollar box. It holds what is typed until Enter or blur, then says yes or no in the row; Escape puts the value back. */
function UsdBox({ field, value, label, ids, disabled, invalid, onCommit, onBad }: {
  field: UsdField; value: number; label: string; ids: Ids; disabled?: boolean; invalid: boolean; onCommit: (n: number) => void; onBad: (msg: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const r = parseUsd(field, draft);
    setDraft(null);
    if (!r.ok) { onBad(r.error); return; }
    onBad("");
    if (r.value !== value) onCommit(r.value);
  };
  return (
    <label className="ps-usd" data-bad={invalid || undefined}>
      <span aria-hidden="true">$</span>
      <input
        type="text" inputMode="decimal" autoComplete="off" spellCheck={false} aria-label={label} aria-describedby={ids.db} aria-invalid={invalid || undefined}
        disabled={disabled} value={draft ?? fmtUsd(value)}
        onChange={(e) => setDraft(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); else if (e.key === "Escape") { setDraft(null); onBad(""); } }}
      />
    </label>
  );
}

export interface PilotSettingsViewProps {
  /** null while the first read is out: the layout draws, the controls wait. */
  settings: PilotSettings | null;
  /** What the engine says about the project's flying; absent until it is read. */
  snapshot?: PilotSnapshot | null;
  /** How many cards would wait for the person under each mode, right now. */
  waiting?: Record<Pilot, number>;
  project: string;
  notes?: Partial<Record<Field, RowNote>>;
  saving?: Partial<Record<Field, number>>;
  loadError?: string;
  onChange: (patch: Partial<PilotSettings>) => void;
  onRetry?: () => void;
  /** More cards under the left column (the master switch). */
  extra?: ReactNode;
  /** The card that lists the projects, across the top: the cards below edit the one it has selected. */
  top?: ReactNode;
}

/** The Settings tab as the approved design draws it: who flies and the track on the left, the limits on the right. */
export function PilotSettingsView({ settings, snapshot, waiting, project, notes = {}, saving = {}, loadError, onChange, onRetry, extra, top }: PilotSettingsViewProps) {
  const gid = useId();
  const [bad, setBad] = useState<Partial<Record<UsdField, string>>>({});
  const s = settings ?? DEFAULT_PILOT_SETTINGS;
  const off = settings === null || !!loadError;
  const busy = (f: Field) => (saving[f] ?? 0) > 0;
  const noteOf = (f: Field): RowNote | undefined => {
    const b = (bad as Record<string, string | undefined>)[f];
    return b ? { kind: "error", text: b } : notes[f];
  };
  const usd = (f: UsdField, label: string, ids: Ids) => (
    <UsdBox field={f} value={s[f]} label={label} ids={ids} disabled={off} invalid={!!bad[f]}
      onBad={(m) => setBad((x) => ({ ...x, [f]: m || undefined }))} onCommit={(n) => onChange({ [f]: n })} />
  );
  const seated = snapshot ? snapshot.seat !== null : undefined;
  const bud = snapshot?.budget;
  const steps = track(s.pilot);
  const Seat = snapshot === undefined || snapshot === null ? null
    : snapshot.seat !== null ? <span className="ps-badge" data-tone="seat">Orchestrator · {snapshot.seat}</span>
    : <span className="ps-badge" data-tone="none"><LockIcon size={ICON.xs} />No seat: acts as Manual</span>;
  const spend = (f: "dailyUsd" | "weeklyUsd") => {
    const day = f === "dailyUsd";
    const spent = bud ? (day ? bud.todayUsd : bud.weekUsd) : undefined;
    const m = meter(spent ?? 0, s[f]);
    const reached = snapshot?.budgetReached === (day ? "day" : "week");
    const label = day ? "Today" : "This week";
    return {
      hint: spent === undefined ? <>{label} not read yet · cap ${fmtUsd(s[f])}</> : <>{label} <b>${fmtUsd(spent)}</b> of ${fmtUsd(s[f])}{reached ? " · Autopilot is on Co-pilot" : ""}</>,
      bar: <div className="ps-bar" role="meter" aria-label={`${label} spend`} aria-valuemin={0} aria-valuemax={s[f]} aria-valuenow={Math.min(spent ?? 0, s[f])} data-tone={m.tone} style={{ ["--p" as string]: m.pct }}><i /></div>,
    };
  };
  const day = spend("dailyUsd"), week = spend("weeklyUsd");
  const reviews: [keyof PilotSettings["reviews"], string][] = [["plan", "The plan"], ["taskDone", "Finished task"], ["pr", "Pull request"]];

  return (
    <div className="ps page" data-loading={settings === null && !loadError ? "" : undefined} data-fail={loadError ? "" : undefined}>
      <div className="ps-grid" aria-busy={settings === null && !loadError}>
        {loadError && (
          <div className="ps-fail">
            <div className="err-note" role="alert"><span className="sev b" aria-hidden="true">!</span><div><b>{loadError}.</b> The settings could not be read, so nothing here can be changed yet.</div></div>
            {onRetry && <button type="button" className="btn sm" onClick={onRetry}>Try again</button>}
          </div>
        )}

        {top}
        <div className="ps-col">
          <section className="ps-card" aria-labelledby={`${gid}w`}>
            <Head icon={<StarIcon size={ICON.md} />} title={`Who flies · ${projectName(project)}`} sub={`One choice for every plan in ${projectName(project)}. The orchestrator is the seat you gave this project.`} badge={Seat} />
            <div className="ps-modes" role="radiogroup" aria-labelledby={`${gid}w`} aria-describedby={`${gid}sum`}>
              <span id={`${gid}w`} className="ps-sr">Who flies</span>
              {MODES.map((m) => {
                const now = nowLine(m.id, waiting?.[m.id], snapshot?.flying, seated);
                return (
                  <label key={m.id} className="ps-mode" data-actor={m.actor} data-pilot={m.id}>
                    <input className="ps-in" type="radio" name={`${gid}p`} checked={s.pilot === m.id} disabled={off} onChange={() => onChange({ pilot: m.id })}
                      aria-labelledby={`${gid}${m.id}n`} aria-describedby={`${gid}${m.id}d ${gid}${m.id}w`} />
                    <span className="ps-top"><span className="ps-tile"><m.Icon size={ICON.sm} /></span><b id={`${gid}${m.id}n`}>{m.name}</b><span className="ps-radio" aria-hidden="true" /></span>
                    <p id={`${gid}${m.id}d`}>{m.text}</p>
                    <span className="ps-now" id={`${gid}${m.id}w`}><em>NOW</em>{now ? <><b>{now.bold}</b>{now.tail}</> : "not read yet"}</span>
                    <span className="ps-gated" data-void={m.id === "autopilot" ? undefined : ""} aria-hidden={m.id === "autopilot" ? undefined : true}><LockIcon size={ICON.xs} />Only you can turn this on</span>
                  </label>
                );
              })}
            </div>
            {notes.pilot && <div className="ps-s" style={{ padding: "0 18px 10px" }} data-tone={notes.pilot.kind} aria-live="polite">{notes.pilot.kind === "lock" && <LockIcon size={ICON.xs} />}{notes.pilot.text}</div>}
            <p className="ps-summary" id={`${gid}sum`}>{SUMMARY[s.pilot]}</p>
            <ol className="ps-lanes" aria-label={`Who does each step in ${MODES.find((m) => m.id === s.pilot)!.name}`}>
              {steps.map((st) => {
                const I = STEP_ICON[st.key];
                return (
                  <li key={st.key} className="ps-st" data-actor={st.actor} data-gate={st.gate ? "" : undefined}>
                    <span className="ps-dot"><I size={ICON.xs} /></span>
                    <span className="ps-nm">{st.label}{st.gate && <span className="ps-sr"> (the Go)</span>}</span>
                    <span className="ps-by">{st.by}</span>
                  </li>
                );
              })}
            </ol>
            <div className="ps-legend">
              <span className="ps-key" data-actor="person">you</span><span className="ps-key" data-actor="coordinator">orchestrator</span>
              <span className="ps-key" data-actor="reviewer">Preflight (read-only)</span><span className="ps-key" data-actor="builder">builder</span>
              <span>· filled dot = the Go</span>
            </div>
          </section>

          <section className="ps-card">
            <Head icon={<EyeIcon size={ICON.md} />} title={`Preflight · ${projectName(project)}`} sub="A fresh reviewer reads the plan and only the files it cites. Small plans skip it. Where it looks, the model and the cap are this project's; sizes and second looks are shared." />
            <PilotRow title="Reviews" hint="Where it looks. Each look costs one run." note={noteOf("reviews")} saving={busy("reviews")}>
              {(ids) => (
                <div role="group" aria-labelledby={ids.lb} aria-describedby={ids.db} style={{ display: "contents" }}>
                  {reviews.map(([k, w]) => (
                    <label key={k} className="ps-chk">
                      <input className="ps-in" type="checkbox" checked={s.reviews[k]} disabled={off} onChange={() => onChange({ reviews: { ...s.reviews, [k]: !s.reviews[k] } })} />
                      <span className="ps-box"><TickIcon size={ICON.xs} /></span>{w}
                    </label>
                  ))}
                </div>
              )}
            </PilotRow>
            <PilotRow title="Sizes reviewed" hint="S never: it goes straight to a builder." note={noteOf("sizes")} saving={busy("sizes")}>
              {(ids) => <Seg ids={ids} disabled={off} value={s.sizes} options={[["L", "L only"], ["ML", "M and L"]] as const} onPick={(v) => onChange({ sizes: v })} />}
            </PilotRow>
            <PilotRow title="Second looks" hint="Co-pilot and Manual: after a blocker is fixed, look again at most this often. Autopilot spends to the budget instead, at most 8 looks per plan." note={noteOf("secondLooks")} saving={busy("secondLooks")}>
              {(ids) => <Seg ids={ids} disabled={off} value={s.secondLooks} options={[[0, "0"], [1, "1"], [2, "2"]] as const} onPick={(v) => onChange({ secondLooks: v })} />}
            </PilotRow>
            <PilotRow title="Model · cap per run" hint="Sonnet reads a plan well for a few cents." note={noteOf("model") ?? noteOf("costCapUsd")} saving={busy("model") || busy("costCapUsd")}>
              {(ids) => <>
                <select className="sel" aria-label="Model" aria-describedby={ids.db} disabled={off} value={s.model} onChange={(e) => onChange({ model: e.target.value })}>
                  {[...MODELS, ...(MODELS.some(([k]) => k === s.model) ? [] : [[s.model, s.model] as const])].map(([k, w]) => <option key={k} value={k}>{w}</option>)}
                </select>
                {usd("costCapUsd", "Cost cap per run, in dollars", ids)}
              </>}
            </PilotRow>
          </section>
          {extra}
        </div>

        <div className="ps-col">
          <section className="ps-card">
            <Head icon={<CoinIcon />} title="Budget" sub="Preflight runs and builders together. At the cap Autopilot drops to Co-pilot until tomorrow." badge={<span className="ps-badge">All projects</span>} />
            <PilotRow title="Each day" hint={day.hint} extra={day.bar} note={noteOf("dailyUsd")} saving={busy("dailyUsd")}>{(ids) => usd("dailyUsd", "Daily budget, in dollars", ids)}</PilotRow>
            <PilotRow title="Each week" hint={week.hint} extra={week.bar} note={noteOf("weeklyUsd")} saving={busy("weeklyUsd")}>{(ids) => usd("weeklyUsd", "Weekly budget, in dollars", ids)}</PilotRow>
            <PilotRow title="Flying at once" hint={`A ${ORDINAL[s.maxFlying - 1]} plan waits for a free slot.`} note={noteOf("maxFlying")} saving={busy("maxFlying")}>
              {(ids) => <Seg ids={ids} disabled={off} value={s.maxFlying} options={[[1, "1"], [2, "2"], [3, "3"]] as const} onPick={(v) => onChange({ maxFlying: v })} />}
            </PilotRow>
            <p className="ps-never-note">Counts Preflight and builders. Your own Go is never capped. The orchestrator's own spend is not counted.</p>
          </section>

          <section className="ps-card">
            <Head icon={<HandIcon size={ICON.md} />} title="Stops and asks you" sub="One question, never a list. Everything else the orchestrator answers." badge={<span className="ps-badge">{projectName(project)}</span>} />
            <PilotRow title="A finding only you can decide" hint="Product calls: what the person wants, not how.">{() => <span className="ps-lock"><LockIcon size={ICON.xs} />Always</span>}</PilotRow>
            <PilotRow title="The budget runs out" hint="Or the builder is denied a tool twice.">{() => <span className="ps-lock"><LockIcon size={ICON.xs} />Always</span>}</PilotRow>
            <PilotRow title="A large plan" hint="L plans wait for your Go, as in Co-pilot." note={noteOf("askOnLarge")} saving={busy("askOnLarge")}>
              {(ids) => <Switch ids={ids} disabled={off} on={s.askOnLarge} onToggle={() => onChange({ askOnLarge: !s.askOnLarge })} />}
            </PilotRow>
            <PilotRow title="A sensitive plan" hint="Touches auth, migrations, secrets, payments, CI or a new dependency." note={noteOf("askOnSensitive")} saving={busy("askOnSensitive")}>
              {(ids) => <Switch ids={ids} disabled={off} on={s.askOnSensitive} onToggle={() => onChange({ askOnSensitive: !s.askOnSensitive })} />}
            </PilotRow>
          </section>

          <section className="ps-card">
            <Head icon={<ShieldIcon size={ICON.md} />} title="The builder never" sub="File edits and shell commands are checked before they run. A script the builder writes and then runs is not." badge={<span className="ps-badge"><LockIcon size={ICON.xs} />Not a setting</span>} />
            <ul className="ps-never" aria-label="The builder never">
              {NEVER.map(([w, note]) => <li key={w} title={note ? `${w}: ${note}` : undefined}><XIcon size={ICON.xs} />{w}</li>)}
            </ul>
            {NEVER.filter(([, n]) => n).map(([w, n]) => <p key={w} className="ps-never-note">{w}: {n}</p>)}
            <PilotRow title="Builder starts from" hint="Local trunk keeps a project whose merges stay local honest; origin cuts from the remote." note={noteOf("builderBase")} saving={busy("builderBase")}>
              {(ids) => <Seg ids={ids} disabled={off} value={s.builderBase} options={[["local", "Local trunk"], ["remote", "Origin"]] as const} onPick={(v) => onChange({ builderBase: v })} />}
            </PilotRow>
            <PilotRow title="Permission mode" hint="Bypass skips every prompt; only you set it, here." note={noteOf("permissions")} saving={busy("permissions")}>
              {(ids) => <>
                <select className="sel" aria-labelledby={ids.lb} aria-describedby={ids.db} disabled={off} value={s.permissions} onChange={(e) => onChange({ permissions: e.target.value as PilotSettings["permissions"] })}>
                  {PERMS.map(([k, w]) => <option key={k} value={k}>{w}</option>)}
                </select>
                <span className="ps-lock"><LockIcon size={ICON.xs} />you</span>
              </>}
            </PilotRow>
            <div className="ps-foot">
              <p>GitHub's branch protection is the last barrier for anything remote.</p>
              <p>If agentglass does not answer in 2 s, a call goes through unchecked.</p>
              <p>A builder's settings and rules changes are denied in the command check. That is not a guarantee: the server only sees the header its own CLI sends, and a script the builder writes and runs is not checked.</p>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

/** What the tab needs to know about every project in scope; the view reads it from the engine. */
export interface ProjectsInScope {
  rows: ProjectRow[];
  /** Per project: what would wait on the person under each mode, for the "Now" line of its mode cards. */
  waitingFor: (root: string) => Record<Pilot, number> | undefined;
  snapshotFor: (root: string) => PilotSnapshot | null;
}

/** Settings, inside the view: every project in scope in one card, and below it the pilot and its safeguards for the one that is picked, through the settings door. */
export function SettingsTab({ enabled, root, onEnabled, onChanged, scope }: {
  enabled: boolean; root: string; onEnabled: (v: boolean) => void; onChanged: () => void; scope: ProjectsInScope;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  const waitingNow = Object.fromEntries(scope.rows.map((r) => [r.root, r.waiting]));
  const picked = pickProject(scope.rows.map((r) => r.root), waitingNow, chosen) || root;
  const reloadMoments = useRef<(() => void) | null>(null);
  const p = usePilotSettings(picked, () => { onChanged(); reloadMoments.current?.(); });
  const [onNote, setOnNote] = useState<RowNote | undefined>();
  const toggle = async () => {
    const r = await api.settingsDoorSet("flightPlan.enabled", !enabled).catch(() => ({ ok: false, error: "could not reach the server" } as { ok: boolean; applied?: boolean; error?: string }));
    if (!r.ok) setOnNote({ kind: "error", text: `Not saved: ${r.error ?? "refused"}` });
    else if (r.applied === false) setOnNote({ kind: "wait", text: "Waits for your approval." });
    else { setOnNote(undefined); onEnabled(!enabled); onChanged(); }
  };
  const master = (
    <section className="ps-card">
      <PilotRow title="Use Flight plan" hint="Off means nothing is reviewed and nothing waits, in every project." note={onNote}>
        {(ids) => <Switch ids={ids} on={enabled} onToggle={() => void toggle()} />}
      </PilotRow>
    </section>
  );
  const top = <ProjectsCard rows={scope.rows} selected={picked} onSelect={setChosen} enabled={enabled} momentsRef={reloadMoments} onWrote={() => { onChanged(); void p.reload(); }} />;
  return <PilotSettingsView settings={p.settings} snapshot={scope.snapshotFor(picked)} waiting={scope.waitingFor(picked)} project={picked} notes={p.notes} saving={p.saving} loadError={p.loadError} onChange={p.change} onRetry={() => void p.reload()} extra={master} top={top} />;
}
