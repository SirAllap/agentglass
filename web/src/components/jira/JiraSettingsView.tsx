import { useMemo, useRef, useState, type ReactNode } from "react";
import type { JiraStatus, JiraSteps } from "../../../../shared/providers.ts";
import type { JiraUnit } from "../../../../shared/jiraStatusUnits.ts";
import { JIRA, jiraAdd, jiraBlocks, jiraDotColour, jiraRemove, jiraSteps, type StepsPatch } from "../../lib/jiraWorkflow.ts";
import { triggerOf } from "../../lib/stepBlocksView.ts";
import { allStatuses, isActive, moments, resolveImplicit, withCounted, type MapSpace, type StepKind } from "../../lib/workflowMap.ts";
import { eyeIds, partitionUnits } from "../../lib/workflowLayout.ts";
import type { UnitsState } from "../../lib/jiraUnits.ts";
import { SettingRow, Switch, Toggle } from "../SettingRow.tsx";
import { SettingsCard, StatusBadge } from "../SettingsKit.tsx";
import { Button, Segmented } from "../workspace/Chrome.tsx";
import { Dot, StatusPopover, type PanelView } from "../StatusPanel.tsx";
import { ListEye, WorkflowMap } from "../WorkflowMap.tsx";
import { WFM_CSS } from "../workflowMapStyle.ts";
import { CardView, CountedPicker, PrView, Tagged, ago, hint } from "../TrackerMapParts.tsx";
import { CopyClickUpSteps } from "./CopyClickUpSteps.tsx";
import { setting } from "../../lib/settingsRegistry.ts";
import { DEFAULT_SYNC_FAVOURITES, useSyncFavourites } from "../../lib/jiraFavourites.ts";
import { DEFAULT_CONFIRM_BOARD_MOVES, useConfirmBoardMoves } from "../../lib/jiraBoardMovePref.ts";
import { openSettings } from "../../lib/openSettings.ts";
import { HIT, ICON } from "../../lib/iconSize.ts";
import { ColumnsIcon, PlugIcon, SearchIcon, ServerIcon, ShieldIcon, SlidersIcon } from "../settingsNavIcons.tsx";

export type WriteKind = keyof JiraStatus["writeKinds"];
/** What each kind of write is, in the order the page lists them; the words are the card's own. */
const WRITE_KINDS: { kind: WriteKind; label: string; hint: string }[] = [
  { kind: "move", label: "Move cards between steps", hint: "A step or a hand-off moves the card to one of your statuses." },
  { kind: "comment", label: "Comment on a card", hint: "Posts, edits and deletes your own comments." },
  { kind: "link", label: "Link a pull request to its card", hint: "Adds the pull request as a link on the card." },
  { kind: "assign", label: "Assign a person", hint: "Puts a person on the card or takes them off." },
];

const n = JIRA.nouns;

const Value = ({ children }: { children: ReactNode }) => <span className="text-[13px]">{children}</span>;
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
  /** The learned GitHub reviewer → Jira account pairs, a card of its own in the page index. */
  pairs?: ReactNode;
  onWrites: (on: boolean) => void;
  /** One kind of write, under the master switch. */
  onWriteKind: (kind: WriteKind, on: boolean) => void;
  /** Sign in again with another token (the form comes back in this page's place). */
  onReplace: () => void;
  /** Save a change to the steps; resolves false when it did not save. */
  onSteps: (patch: StepsPatch) => Promise<boolean>;
  onReread: () => void;
  onClearOverride: (project: string) => void;
  onOpenTab: () => void;
  onDisconnect: () => void;
  /** The site's custom fields, by name, for a "Set a field" block. Null: they could not be read. */
  fields?: () => Promise<{ name: string; type: string }[] | null>;
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
  const [copying, setCopying] = useState(false);
  const [countAt, setCountAt] = useState<HTMLElement | null>(null);
  const advRef = useRef<HTMLDivElement>(null);

  const units: MapSpace[] = useMemo(() => {
    const raw = state.kind === "ok" ? state.units : state.kind === "error" || state.kind === "loading" ? state.stale ?? [] : [];
    return raw.map((u: JiraUnit) => ({
      id: u.id, name: u.name,
      /* Jira sends a status's category and not a colour: the dot wears the category's house colour. */
      statuses: u.statuses.map((s) => ({ ...s, color: jiraDotColour(s.type) })),
      ...(u.counted === false ? { counted: false } : null), ...(u.cards ? { cards: u.cards } : null),
    }));
  }, [state]);
  const part = useMemo(() => partitionUnits(units), [units]);
  const panel: PanelView = state.kind === "ok" ? { kind: "ok" }
    : state.kind === "loading" ? { kind: "loading" }
    : state.kind === "empty" ? { kind: "empty" }
    : { kind: "error", text: state.throttled ? `${n.name} asked us to wait (rate limit).` : state.error };

  const steps = useMemo(() => (p.steps ? resolveImplicit(JIRA, jiraSteps(p.steps), allStatuses(part.counted)) : []), [p.steps, part]);
  const [syncOn] = useSyncFavourites();
  const [confirmMoves] = useConfirmBoardMoves();
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
      <SettingsCard title={n.name} icon={<PlugIcon size={ICON.sm} />} desc="Link it once and a pull request knows its card."
        status={<StatusBadge tone="ok">Connected</StatusBadge>}>
        <SettingRow agentExempt label="Jira type" hint="Where the site runs." control={<Value>{p.status.kind === "cloud" ? "Cloud" : "Data Center"}</Value>} />
        <SettingRow agentExempt label="Site" control={<Value><span className="t-mono">{p.status.site}</span></Value>} />
        {p.status.account && <SettingRow agentExempt label="Signed in as" hint={signIn(p.status)} control={<Value>{p.status.account}</Value>} />}
        <SettingRow agentExempt label="Token" hint="Kept on this machine in a file only you can read, never shown again."
          control={<span className="flex items-center gap-2"><StatusBadge tone="ok">Stored</StatusBadge><Button onClick={p.onReplace}>Replace</Button></span>} />
        <SettingRow agentExempt label={`Changes in ${n.name}`} hint={changesOn ? "On. Set on Permissions › Changes outside." : "Read-only. Turn it on at Permissions › Changes outside."}
          status={<span data-guard={changesOn ? "on" : "off"}><StatusBadge tone={changesOn ? "ok" : "off"}>{changesOn ? "On" : "Read-only"}</StatusBadge></span>}
          onClick={() => openSettings("permOut")} />
        {p.note && <SettingRow agentExempt label="That did not work" hint={<span role="alert" style={{ color: "var(--error-ink)" }}>{p.note}</span>} />}
        <SettingRow agentExempt label="Disconnect Jira" hint="Removes the token from this machine. Nothing changes in Jira."
          actions={<Button tone="danger" pending={p.busy} onClick={p.onDisconnect}>Disconnect</Button>} />
      </SettingsCard>

      <SettingsCard icon={<SearchIcon size={ICON.sm} />} title="What we found" fold={{ open: foundOpen ?? steps.length === 0, onToggle: setFoundOpen }}
        desc={state.kind === "loading" ? undefined : `${part.counted.length} ${n.lists} count · ${distinct} statuses${part.folded.length ? ` · ${part.folded.length} ignored` : ""}`}
        status={<StatusBadge tone={statusTone}>{statusText}</StatusBadge>}>
        <SettingRow settingId="jira.statusUnits.counted" label="Projects that count"
          hint={<>{part.counted.length ? part.counted.map((u) => u.name).join(", ") : state.kind === "loading" ? "reading…" : "none"}<span className="block mt-1">{chosen ? "You chose these. The rest are ignored, not deleted." : `Where your ${n.items} live, until you choose.`}</span>{state.kind === "ok" && state.note && <span className="block mt-1">{state.note}</span>}</>}
          actions={<Button aria-haspopup="listbox" aria-expanded={!!countAt} disabled={!units.length} onClick={(e) => setCountAt(countAt ? null : e.currentTarget)}>Change</Button>} />
        <Toggle on={syncOn} modified={syncOn !== DEFAULT_SYNC_FAVOURITES} onClick={() => { setting("jira.syncFavourites").set(!syncOn); }}
          settingId="jira.syncFavourites" label="Sync with Jira filters"
          hint="List the filters you starred in Jira under Starred filters in the sidebar, with their counts. Off shows only the searches saved here. Nothing changes in Jira." />
        <SettingRow settingId="jira.tree.shapes" label="How each space's tree is laid out"
          hint="Each space in the sidebar is read by components (each with its epics) or by epics (each once, with all its cards). Switch it from the space's own header in the sidebar."
          actions={<Button onClick={() => { setting("jira.tree.shapes").set(""); }}>Show every space by components</Button>} />
        <SettingRow agentExempt label={`Your ${n.lists} and their statuses`}
          below={state.kind === "loading" && !units.length ? hint("reading…")
            : part.counted.length ? (
              <ul className="m-0 p-0 flex flex-col gap-2" style={{ listStyle: "none" }}>
                {part.counted.map((u) => (
                  <li key={u.id} className="flex gap-2 items-start">
                    <span className="flex gap-2 items-center flex-wrap flex-1 min-w-0"><b>{u.name}</b>{hint(`${u.id} · ${u.statuses.length} statuses`)}
                      <span className="flex gap-1 flex-wrap">{u.statuses.map((s) => <Tagged key={s.status}><Dot type={s.type} color={jiraDotColour(s.type)} />{s.status}</Tagged>)}</span></span>
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
      </SettingsCard>
      {countAt && (
        <StatusPopover anchor={countAt} label={`${n.lists} that count`} onClose={(f) => { setCountAt(null); if (f) countAt.focus(); }}>
          <CountedPicker n={n} units={units} chosen={chosen} onChange={count} onReset={() => count([])} onClose={() => { setCountAt(null); countAt.focus(); }} />
        </StatusPopover>
      )}

      <WorkflowMap adapter={JIRA} part={part} panel={panel} steps={steps} changesOn={changesOn} source={source}
        copy={<Button onClick={() => setCopying(true)} disabled={state.kind === "loading" && !units.length}>Copy steps from ClickUp</Button>}
        {...(p.fields ? { fields: p.fields } : null)}
        onHover={setHover}
        onAdd={(kind) => p.onSteps(jiraAdd(kind))}
        onBlocks={(kind, blocks) => { if (triggerOf(kind)) void p.onSteps(jiraBlocks(kind, blocks)); }}
        onRemove={(kind) => { void p.onSteps(jiraRemove(kind)); }}
        onToggleCounted={toggleCounted}
        onCountAgain={(u) => { const ids = withCounted(units, u.id, true); if (ids) count(ids); }}
        onRetry={p.onReread} />
      {copying && <CopyClickUpSteps statuses={allStatuses(part.counted)} steps={steps} onSave={p.onSteps} onClose={() => setCopying(false)} />}

      <SettingsCard icon={<ColumnsIcon size={ICON.sm} />} title="Where this shows up" desc="Hover a step above to see which part of this it adds."
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
      </SettingsCard>
      {p.tracker}
      {p.pairs}

      <SettingsCard title="Board" icon={<ColumnsIcon size={ICON.sm} />} desc="How a drag on the board asks before it writes to Jira.">
        <Toggle on={confirmMoves} modified={confirmMoves !== DEFAULT_CONFIRM_BOARD_MOVES} onClick={() => { setting("jira.board.confirmMoves").set(!confirmMoves); }}
          settingId="jira.board.confirmMoves" label="Confirm board moves"
          hint={confirmMoves ? "Moving one card to another column asks first, in a dialog that shows where it goes. Moving several always asks." : "Moving one card moves it at once. Moving several still asks."} />
      </SettingsCard>

      <SettingsCard title="Saved views and folders" icon={<ServerIcon size={ICON.sm} />}
        desc="The boards and filters you saved sit in the Jira tab's sidebar. Add and remove them there.">
        <SettingRow agentExempt label="Views and folders"
          hint={p.views ? `${p.views.views} ${p.views.views === 1 ? "view" : "views"} · ${p.views.folders} ${p.views.folders === 1 ? "folder" : "folders"} saved on this machine.` : "Reading what is saved…"}
          actions={<Button onClick={p.onOpenTab}>Open the Jira tab</Button>} />
      </SettingsCard>

      <div ref={advRef}>
        <SettingsCard icon={<SlidersIcon size={ICON.sm} />} title="Advanced" desc="The older per-project rules." fold={{ open: !!advOpen, onToggle: setAdvOpen }}>
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
        </SettingsCard>
      </div>

    </div>
  );
}
