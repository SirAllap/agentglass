import { useMemo, useRef, useState, type ReactNode } from "react";
import type { JiraStatus, JiraSteps } from "../../../../shared/providers.ts";
import type { JiraUnit } from "../../../../shared/jiraStatusUnits.ts";
import { JIRA, jiraAdd, jiraBlocks, jiraRemove, jiraSteps, type StepsPatch } from "../../lib/jiraWorkflow.ts";
import { triggerOf } from "../../lib/stepBlocksView.ts";
import { allStatuses, isActive, moments, resolveImplicit, withCounted, type MapSpace, type StepKind } from "../../lib/workflowMap.ts";
import { eyeIds, partitionUnits } from "../../lib/workflowLayout.ts";
import type { UnitsState } from "../../lib/jiraUnits.ts";
import { SettingRow, Switch } from "../SettingRow.tsx";
import { SettingsCard, StatusBadge } from "../SettingsKit.tsx";
import { Button, Segmented } from "../workspace/Chrome.tsx";
import { Dot, StatusPopover, type PanelView } from "../StatusPanel.tsx";
import { ListEye, WorkflowMap } from "../WorkflowMap.tsx";
import { WFM_CSS } from "../workflowMapStyle.ts";
import { Card, CardView, CountedPicker, PrView, Tagged, ago, hint } from "../TrackerMapParts.tsx";
import { setting } from "../../lib/settingsRegistry.ts";
import { HIT } from "../../lib/iconSize.ts";

const n = JIRA.nouns;

const Value = ({ children }: { children: ReactNode }) => <span className="text-[13px]">{children}</span>;
const runsOn = (s: JiraStatus): string => (s.deployment === "cloud" || (!s.deployment && s.kind === "cloud") ? "Jira Cloud" : "Jira Data Center");
const signIn = (s: JiraStatus): string => (s.auth === "bearer" ? "Personal access token" : "Account and token");

/** What the page is handed: everything it draws, and what a press asks for. Nothing in here reaches the network. */
export interface JiraViewProps {
  status: JiraStatus;
  /** The write switch as the settings hold it. */
  writes: boolean;
  writesBusy?: boolean;
  /** The saved steps; null while they are being read. */
  steps: JiraSteps | null;
  /** Projects whose older per-project hand-off rule still wins over the hand-off step. */
  overrides: string[];
  units: UnitsState;
  views: { views: number; folders: number } | null;
  note: string | null;
  /** The per-project tracker choice, drawn between the map and the saved views. */
  tracker?: ReactNode;
  onWrites: (on: boolean) => void;
  /** Save a change to the steps; resolves false when it did not save. */
  onSteps: (patch: StepsPatch) => Promise<boolean>;
  onReread: () => void;
  onClearOverride: (project: string) => void;
  onOpenTab: () => void;
  onDisconnect: () => void;
  busy?: boolean;
}

/**
 * Jira's Settings page, drawn from what it is handed: the connection and the one
 * switch that lets anything write, what was found on the site, the workflow map,
 * where each step shows up, and the rest. The container (`JiraPane`) reads and
 * saves; this decides what each state looks like, so a test can draw any of them.
 */
export function JiraSettingsView(p: JiraViewProps) {
  const { units: state } = p;
  const [foundOpen, setFoundOpen] = useState<boolean | null>(null);
  const [advOpen, setAdvOpen] = useState(p.overrides.length > 0);
  const [hover, setHover] = useState<StepKind | null>(null);
  const [linked, setLinked] = useState(true);
  const [countAt, setCountAt] = useState<HTMLElement | null>(null);
  const advRef = useRef<HTMLDivElement>(null);

  const units: MapSpace[] = useMemo(() => {
    const raw = state.kind === "ok" ? state.units : state.kind === "error" || state.kind === "loading" ? state.stale ?? [] : [];
    return raw.map((u: JiraUnit) => ({ id: u.id, name: u.name, statuses: u.statuses, ...(u.counted === false ? { counted: false } : null), ...(u.cards ? { cards: u.cards } : null) }));
  }, [state]);
  const part = useMemo(() => partitionUnits(units), [units]);
  const panel: PanelView = state.kind === "ok" ? { kind: "ok" }
    : state.kind === "loading" ? { kind: "loading" }
    : state.kind === "empty" ? { kind: "empty" }
    : { kind: "error", text: state.throttled ? `${n.name} asked us to wait (rate limit).` : state.error };

  const steps = useMemo(() => (p.steps ? resolveImplicit(JIRA, jiraSteps(p.steps), allStatuses(part.counted)) : []), [p.steps, part]);
  if (!p.steps) return <div className="py-6 text-[11px]" style={{ color: "var(--text3)" }}>Reading your settings…</div>;

  const changesOn = p.writes;
  const M = moments(n);
  const live = changesOn ? steps.filter((s) => isActive(s, M[s.kind])) : [];
  const distinct = allStatuses(part.counted).length;
  const asOf = state.kind === "ok" || state.kind === "empty" ? state.at : state.kind === "error" ? state.staleAt : undefined;
  const chosen = state.kind === "ok" && state.counted.length > 0;
  const narrowed = state.kind === "ok" && !state.note;
  /* The pick goes through its def, the one write path a row and an agent share. Empty is the default. */
  const count = (ids: string[]) => { setting("jira.statusUnits.counted").set(ids.join(",")); };
  const toggleCounted = (u: MapSpace) => { const ids = eyeIds(units, u); if (ids) count(ids); };
  const sampleStatus = allStatuses(part.counted).find((s) => s.type !== "done")?.name ?? "";
  const source = <><b style={{ color: "var(--text)" }}>Where these come from.</b> {narrowed ? `The ${n.lists} where your cards live` : `The ${n.lists} ${n.name} returned`}{asOf ? `, read from ${n.name} ${ago(asOf)}` : ""}. {part.folded.length ? `${part.folded.length} ignored, still listed under What we found.` : ""}</>;
  const showAdvanced = () => { setAdvOpen(true); requestAnimationFrame(() => advRef.current?.querySelector<HTMLElement>("button")?.focus()); };
  const statusTone = state.kind === "error" ? "warn" : state.kind === "loading" ? "checking" : "ok";
  const statusText = state.kind === "loading" ? "Reading" : state.kind === "error" ? (asOf ? `As of ${ago(asOf)}` : "Not read") : "Read-only";

  return (
    <div className="wfm">
      <style>{WFM_CSS}</style>
      {/* The connection, and the one switch that decides whether anything here can write. */}
      <SettingsCard title={n.name} desc={p.status.account ? `Signed in as ${p.status.account}. ${p.status.site ?? ""}`.trim() : p.status.site ?? undefined}
        status={<StatusBadge tone="ok">Connected</StatusBadge>}>
        <SettingRow agentExempt label={<span id="jira-changes-l">{`Changes in ${n.name}`}</span>}
          hint={changesOn ? `Only the steps below can change a ${n.item}, one at a time, when you press their button.` : steps.length ? "agentglass only reads. Turn this on to let the steps below act." : "agentglass only reads. Add a step below, then turn this on to let it act."}
          status={<span data-guard={changesOn ? "on" : "off"}><StatusBadge tone={changesOn ? "warn" : "off"}>{changesOn ? "On" : "Read-only"}</StatusBadge></span>}
          control={<button type="button" role="switch" aria-checked={changesOn} aria-labelledby="jira-changes-l" disabled={p.writesBusy}
            onClick={() => p.onWrites(!changesOn)} className="agx-switch-hit inline-flex items-center rounded-full" style={{ minHeight: HIT }}><Switch on={changesOn} busy={p.writesBusy} /></button>} />
        {p.note && <SettingRow agentExempt label="That did not work" hint={<span role="alert" style={{ color: "var(--error-ink)" }}>{p.note}</span>} />}
      </SettingsCard>

      <Card id="jira-found" title="What we found" open={foundOpen ?? steps.length === 0} onToggle={setFoundOpen}
        desc={state.kind === "loading" ? undefined : `${part.counted.length} ${n.lists} count · ${distinct} statuses${part.folded.length ? ` · ${part.folded.length} ignored` : ""}`}
        status={<StatusBadge tone={statusTone}>{statusText}</StatusBadge>}>
        <SettingRow settingId="jira.statusUnits.counted" label="Projects that count"
          hint={<>{part.counted.length ? part.counted.map((u) => u.name).join(", ") : state.kind === "loading" ? "reading…" : "none"}<span className="block mt-1">{chosen ? "You chose these. The rest are ignored, not deleted." : `Where your ${n.items} live, until you choose.`}</span>{state.kind === "ok" && state.note && <span className="block mt-1">{state.note}</span>}</>}
          actions={<Button aria-haspopup="listbox" aria-expanded={!!countAt} disabled={!units.length} onClick={(e) => setCountAt(countAt ? null : e.currentTarget)}>Change</Button>} />
        <SettingRow agentExempt label={`Your ${n.lists} and their statuses`}
          below={state.kind === "loading" && !units.length ? hint("reading…")
            : part.counted.length ? (
              <ul className="m-0 p-0 flex flex-col gap-2" style={{ listStyle: "none" }}>
                {part.counted.map((u) => (
                  <li key={u.id} className="flex gap-2 items-start">
                    <span className="flex gap-2 items-center flex-wrap flex-1 min-w-0"><b>{u.name}</b>{hint(`${u.id} · ${u.statuses.length} statuses`)}
                      <span className="flex gap-1 flex-wrap">{u.statuses.map((s) => <Tagged key={s.status}><Dot type={s.type} color={s.color} />{s.status}</Tagged>)}</span></span>
                    <ListEye unit={u} nouns={n} onToggle={toggleCounted} blocked={eyeIds(units, u) === null} />
                  </li>
                ))}
              </ul>
            ) : hint(`No ${n.list} counts.`)} />
        <SettingRow agentExempt label="Not used by steps"
          hint={part.folded.length ? `${part.folded.length} ignored (${part.folded.map((f) => f.unit.name).join(", ")}). Their statuses stay out of the picker until you open them.` : "Nothing is ignored."} />
        <SettingRow agentExempt label="How we read it"
          hint={asOf && state.kind === "ok" ? `Read ${ago(asOf)} · cached for 10 min. Only ${n.lists} with a ${n.item} of yours, or that you chose, are read.` : "Nothing needs setting up."}
          actions={<Button onClick={p.onReread} disabled={state.kind === "loading"}>Re-read</Button>}
          below={<span><button type="button" className="agx-textlink text-[12px]" onClick={showAdvanced}>Site and older rules in Advanced</button></span>} />
      </Card>
      {countAt && (
        <StatusPopover anchor={countAt} label={`${n.lists} that count`} onClose={(f) => { setCountAt(null); if (f) countAt.focus(); }}>
          <CountedPicker n={n} units={units} chosen={chosen} onChange={count} onReset={() => count([])} onClose={() => { setCountAt(null); countAt.focus(); }} />
        </StatusPopover>
      )}

      <WorkflowMap adapter={JIRA} part={part} panel={panel} steps={steps} changesOn={changesOn} source={source}
        onHover={setHover}
        onAdd={(kind) => p.onSteps(jiraAdd(kind))}
        onBlocks={(kind, blocks) => { if (triggerOf(kind)) void p.onSteps(jiraBlocks(kind, blocks)); }}
        onRemove={(kind) => { void p.onSteps(jiraRemove(kind)); }}
        onToggleCounted={toggleCounted}
        onCountAgain={(u) => { const ids = withCounted(units, u.id, true); if (ids) count(ids); }}
        onRetry={p.onReread} />

      <Card id="jira-shows" title="Where this shows up" desc="Hover a step above to see which part of this it adds."
        actions={<Segmented label={`Does the pull request name a ${n.item}?`} value={linked ? "1" : "0"} onChange={(v) => setLinked(v === "1")}
          options={[{ id: "1", label: "Linked" }, { id: "0", label: "No link" }]} />}>
        <div className="grid gap-4 agx-settings-x pt-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
          <div><PrView adapter={JIRA} status={sampleStatus} steps={live} all={steps} writes={changesOn} hover={hover} linked={linked} /></div>
          <div><CardView adapter={JIRA} status={sampleStatus} writes={changesOn} linked={linked} /></div>
        </div>
        <div className="agx-settings-x pt-3 pb-3 text-[12px]" style={{ color: "var(--text3)" }}>
          {live.length ? `Only the steps above show up. Everything else about a ${n.item} stays read-only.`
            : steps.length ? "Changes are off, so no step shows."
            : `No steps: the ${n.item} is shown, nothing writes.`}
          {!linked && ` This pull request names no ${n.item}: no ${n.name} block on it and no Pull requests section on the ${n.item}. Tasks works on its own.`}
        </div>
      </Card>
      {p.tracker}

      <SettingsCard title="Saved views and folders"
        desc="The boards and filters you saved sit in the Jira tab's sidebar. Add and remove them there.">
        <SettingRow agentExempt label="Views and folders"
          hint={p.views ? `${p.views.views} ${p.views.views === 1 ? "view" : "views"} · ${p.views.folders} ${p.views.folders === 1 ? "folder" : "folders"} saved on this machine.` : "Reading what is saved…"}
          actions={<Button onClick={p.onOpenTab}>Open the Jira tab</Button>} />
      </SettingsCard>

      <div ref={advRef}>
        <Card id="jira-adv" title="Advanced" desc="The site this reads, and the older per-project rules." open={advOpen} onToggle={setAdvOpen}>
          <SettingRow agentExempt label="Site" control={<Value>{p.status.site}</Value>} />
          <SettingRow agentExempt label="Runs on" control={<Value>{runsOn(p.status)}</Value>} />
          <SettingRow agentExempt label="Signs in with" control={<Value>{signIn(p.status)}</Value>} />
          <SettingRow agentExempt label="Projects with their own hand-off"
            hint={p.overrides.length ? `Before steps there was one hand-off rule per project. These ${p.overrides.length === 1 ? "project keeps its" : "projects keep their"} own until you clear it or save the hand-off step.` : "None: the hand-off step applies to every project."}
            below={p.overrides.length ? (
              <ul className="m-0 p-0 flex flex-col gap-2" style={{ listStyle: "none" }}>
                {p.overrides.map((k) => (
                  <li key={k} className="flex gap-2 items-center flex-wrap"><Tagged>{k}</Tagged>
                    <Button size="compact" label={`Use the hand-off step for ${k}`} onClick={() => p.onClearOverride(k)}>Use the step</Button></li>
                ))}
              </ul>
            ) : undefined} />
        </Card>
      </div>

      <SettingsCard title="Disconnect">
        <SettingRow agentExempt label="Disconnect Jira" hint="Removes the token from this machine. Nothing changes in Jira."
          actions={<Button tone="danger" pending={p.busy} onClick={p.onDisconnect}>Disconnect</Button>} />
      </SettingsCard>
    </div>
  );
}
