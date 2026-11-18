import { useMemo, useState, type ReactNode } from "react";
import { SettingsPage } from "../shell/SettingsPage.tsx";
import { Section, DangerZone } from "../shell/Section.tsx";
import { SettingRow } from "../shell/SettingRow.tsx";
import { Switch } from "../../SettingRow.tsx";
import { Button, Segmented } from "../../workspace/Chrome.tsx";
import { DangerAction, useInstantSave } from "../save/index.ts";
import { JiraPane } from "../../JiraPane.tsx";
import type { JiraViewProps } from "../../jira/JiraSettingsView.tsx";
import { WorkflowMap } from "../../WorkflowMap.tsx";
import { WFM_CSS } from "../../workflowMapStyle.ts";
import { StatusPopover } from "../../StatusPanel.tsx";
import { CopyClickUpSteps } from "../../jira/CopyClickUpSteps.tsx";
import { CardView, CountedPicker, PrView, ago } from "../../TrackerMapParts.tsx";
import { JIRA, jiraAdd, jiraBlocks, jiraDotColour, jiraRemove, jiraSteps } from "../../../lib/jiraWorkflow.ts";
import { triggerOf } from "../../../lib/stepBlocksView.ts";
import { allStatuses, isActive, moments, resolveImplicit, withCounted, type MapSpace, type StepKind } from "../../../lib/workflowMap.ts";
import { eyeIds, partitionUnits } from "../../../lib/workflowLayout.ts";
import { setting } from "../../../lib/settingsRegistry.ts";
import { useSyncFavourites } from "../../../lib/jiraFavourites.ts";
import { useConfirmBoardMoves } from "../../../lib/jiraBoardMovePref.ts";
import type { PanelView } from "../../StatusPanel.tsx";
import type { JiraUnit } from "../../../../../shared/jiraStatusUnits.ts";
import type { PageCtx } from "./ctx.ts";

const n = JIRA.nouns;
const PURPOSE = "Link your Jira site so a pull request knows its card, and choose what steps do.";
const Val = ({ children }: { children: ReactNode }) => <span className="text-[13px]">{children}</span>;

function JiraConnectedBody({ v, setPane }: { v: JiraViewProps; setPane: (p: "tasks") => void }) {
  const { units: state } = v;
  const [hover, setHover] = useState<StepKind | null>(null);
  const [linked, setLinked] = useState(true);
  const [copying, setCopying] = useState(false);
  const [countAt, setCountAt] = useState<HTMLElement | null>(null);
  const [syncOn] = useSyncFavourites();
  const [confirmMoves] = useConfirmBoardMoves();
  const units: MapSpace[] = useMemo(() => {
    const raw = state.kind === "ok" ? state.units : state.kind === "error" || state.kind === "loading" ? state.stale ?? [] : [];
    return raw.map((u: JiraUnit) => ({
      id: u.id, name: u.name, statuses: u.statuses.map((s) => ({ ...s, color: jiraDotColour(s.type) })),
      ...(u.counted === false ? { counted: false } : null), ...(u.cards ? { cards: u.cards } : null),
    }));
  }, [state]);
  const part = useMemo(() => partitionUnits(units), [units]);
  const panel: PanelView = state.kind === "ok" ? { kind: "ok" } : state.kind === "loading" ? { kind: "loading" } : state.kind === "empty" ? { kind: "empty" }
    : { kind: "error", text: state.throttled ? `${n.name} asked us to wait (rate limit).` : state.error };
  const steps = useMemo(() => (v.steps ? resolveImplicit(JIRA, jiraSteps(v.steps), allStatuses(part.counted)) : []), [v.steps, part]);
  const saveSync = useInstantSave<boolean>(syncOn, (on) => { setting("jira.syncFavourites").set(on); });
  const saveConfirm = useInstantSave<boolean>(confirmMoves, (on) => { setting("jira.board.confirmMoves").set(on); });
  if (!v.steps) return <div className="py-6 text-[12px]" style={{ color: "var(--text2)" }}>Reading your settings…</div>;

  const changesOn = v.writes;
  const M = moments(n);
  const live = changesOn ? steps.filter((s) => isActive(s, M[s.kind])) : [];
  const asOf = state.kind === "ok" || state.kind === "empty" ? state.at : state.kind === "error" ? state.staleAt : undefined;
  const chosen = state.kind === "ok" && state.counted.length > 0;
  const count = (ids: string[]) => { setting("jira.statusUnits.counted").set(ids.join(",")); };
  const toggleCounted = (u: MapSpace) => { const ids = eyeIds(units, u); if (ids) count(ids); };
  const sampleStatus = allStatuses(part.counted).find((s) => s.type !== "done")?.name ?? "";
  const source = <>{chosen ? `The ${n.lists} where your cards live` : `The ${n.lists} ${n.name} returned`}{asOf ? `, read from ${n.name} ${ago(asOf)}` : ""}.</>;
  const names = part.counted.length ? part.counted.map((u) => u.name).join(", ") : state.kind === "loading" ? "reading…" : "none";

  const connection = (
    <Section id="connection" title="Connection" intro="Link it once and a pull request knows its card.">
      <SettingRow kind="locked" label="Jira type" help="Where the site runs." reason="Set when you connected" control={<Val>{v.status.kind === "cloud" ? "Cloud" : "Data Center"}</Val>} />
      <SettingRow kind="locked" label="Site" help="The address you connected." reason="Set when you connected" control={<Val><span className="t-mono">{v.status.site}</span></Val>} />
      {v.status.account && <SettingRow kind="locked" label="Signed in as" help={v.status.auth === "bearer" ? "Uses a personal access token." : "Uses your account and a token."} reason="Set when you connected" control={<Val>{v.status.account}</Val>} />}
      <SettingRow kind="control" label="Token" help="Kept on this machine in a file only you can read."
        control={<Button onClick={v.onReplace}>Replace</Button>} />
      <SettingRow kind="locked" label="What connecting does" help="Nothing changes in your workspace until you say so."
        reason="Read-only until you allow changes" control={<Val>{changesOn ? "Changes on" : "Read-only"}</Val>} />
      <SettingRow kind="link" label="Which tracker owns a card" help="Set per repository, on Tasks." linkText="Open Tasks" onOpen={() => setPane("tasks")} />
      <SettingRow kind="control" settingId="jira.statusUnits.counted" label="Projects that count" help={chosen ? `You chose these: ${names}.` : `Where your cards live: ${names}.`}
        control={<Button aria-haspopup="listbox" aria-expanded={!!countAt} disabled={!units.length} onClick={(e) => setCountAt(countAt ? null : e.currentTarget)}>Change</Button>} />
      <SettingRow kind="control" settingId="jira.syncFavourites" label="Sync with Jira filters" help="Lists your starred Jira filters in the sidebar and changes nothing in Jira."
        control={<button role="switch" aria-checked={syncOn} aria-label="Sync with Jira filters" onClick={() => saveSync(!syncOn)} className="agx-btn"><Switch on={syncOn} /></button>} />
      <SettingRow kind="control" settingId="jira.tree.shapes" label="How each space's tree is laid out" help="Shows each space by components or by epics; change one in the sidebar."
        control={<Button onClick={() => { setting("jira.tree.shapes").set(""); }}>Show every space by components</Button>} />
      <SettingRow kind="locked" label="Not used by steps"
        help={part.folded.length ? `Left out: ${part.folded.map((f) => f.unit.name).join(", ")}.` : "Nothing is left out."}
        reason="Read from Jira" control={<Val>{part.folded.length}</Val>} />
      <SettingRow kind="control" label="How we read it"
        help={asOf && state.kind === "ok" ? `Read ${ago(asOf)}, kept for 10 minutes.` : "Nothing needs setting up."}
        control={<Button onClick={v.onReread} disabled={state.kind === "loading"}>Re-read</Button>} />
      {v.note && <div role="alert" className="px-3 py-2 text-[12px]" style={{ color: "var(--error-ink)" }}>{v.note}</div>}
    </Section>
  );
  const stepsSection = (
    <Section id="steps" title="Steps" intro="Each step adds one control to agentglass. You build what it does from blocks.">
      <div className="wfm px-3 py-2.5">
        <style>{WFM_CSS}</style>
        <WorkflowMap adapter={JIRA} part={part} panel={panel} steps={steps} changesOn={changesOn} source={source}
          copy={<Button onClick={() => setCopying(true)} disabled={state.kind === "loading" && !units.length}>Copy steps from ClickUp</Button>}
          {...(v.fields ? { fields: v.fields } : null)}
          onHover={setHover}
          onAdd={(kind) => v.onSteps(jiraAdd(kind))}
          onBlocks={(kind, blocks) => { if (triggerOf(kind)) void v.onSteps(jiraBlocks(kind, blocks)); }}
          onRemove={(kind) => { void v.onSteps(jiraRemove(kind)); }}
          onToggleCounted={toggleCounted}
          onCountAgain={(u) => { const ids = withCounted(units, u.id, true); if (ids) count(ids); }}
          onRetry={v.onReread} />
        {copying && <CopyClickUpSteps statuses={allStatuses(part.counted)} steps={steps} onSave={v.onSteps} onClose={() => setCopying(false)} />}
      </div>
    </Section>
  );
  const shows = (
    <Section id="shows" title="Where this shows up" intro="Hover a step to see which part it adds.">
      <div className="px-3 py-2.5 flex flex-col gap-3">
        <Segmented label={`Does the pull request name a ${n.item}?`} value={linked ? "1" : "0"} onChange={(x) => setLinked(x === "1")}
          options={[{ id: "1", label: "Linked" }, { id: "0", label: "No link" }]} />
        <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
          <div><PrView adapter={JIRA} status={sampleStatus} steps={live} all={steps} writes={changesOn} hover={hover} linked={linked} /></div>
          <div><CardView adapter={JIRA} status={sampleStatus} writes={changesOn} linked={linked} /></div>
        </div>
      </div>
    </Section>
  );
  const board = (
    <Section id="board" title="Board" intro="How a drag on the board asks before it writes to Jira.">
      <SettingRow kind="control" settingId="jira.board.confirmMoves" label="Confirm board moves" help={confirmMoves ? "Moving one card asks first. Moving several always asks." : "Moving one card moves it at once. Moving several still asks."}
        control={<button role="switch" aria-checked={confirmMoves} aria-label="Confirm board moves" onClick={() => saveConfirm(!confirmMoves)} className="agx-btn"><Switch on={confirmMoves} /></button>} />
    </Section>
  );
  const views = (
    <Section id="views" title="Saved views and folders" intro="The boards and filters you saved sit in the Jira tab's sidebar.">
      <SettingRow kind="control" label="Views and folders"
        help={v.views ? `${v.views.views} ${v.views.views === 1 ? "view" : "views"} and ${v.views.folders} ${v.views.folders === 1 ? "folder" : "folders"} saved on this machine.` : "Reading what is saved…"}
        control={<Button onClick={v.onOpenTab}>Open the Jira tab</Button>} />
      <SettingRow kind="control" label="Projects with their own hand-off"
        help={v.overrides.length ? `${v.overrides.join(", ")} keep an older rule. Clear one to use the step.` : "No project keeps an older rule."}
        control={v.overrides.length
          ? <span className="flex gap-1 flex-wrap">{v.overrides.map((k) => <Button key={k} size="compact" label={`Use the hand-off step for ${k}`} onClick={() => v.onClearOverride(k)}>{k}</Button>)}</span>
          : <span className="text-[12px]" style={{ color: "var(--text2)" }}>None</span>} />
    </Section>
  );
  const pairs = v.pairs ? <Section id="reviewers" title="Reviewers">{v.pairs}</Section> : null;
  const danger = (
    <DangerZone>
      <SettingRow kind="control" label="Disconnect Jira" help="Removes the token from this machine and changes nothing in Jira."
        control={<DangerAction label="Disconnect" onConfirm={v.onDisconnect} />} />
    </DangerZone>
  );
  return (
    <>
      <SettingsPage title="Jira" purpose={PURPOSE} sections={[
        { id: "connection", title: "Connection", kind: "normal", body: connection },
        { id: "steps", title: "Steps", kind: "normal", body: stepsSection },
        { id: "shows", title: "Where this shows up", kind: "normal", body: shows },
        { id: "board", title: "Board", kind: "normal", body: board },
        { id: "views", title: "Saved views and folders", kind: "normal", body: views },
        ...(pairs ? [{ id: "reviewers", title: "Reviewers", kind: "normal" as const, body: pairs }] : []),
        { id: "danger", title: "Danger zone", kind: "danger", body: danger },
      ]} />
      {countAt && (
        <StatusPopover anchor={countAt} label={`${n.lists} that count`} onClose={(f) => { setCountAt(null); if (f) countAt.focus(); }}>
          <CountedPicker n={n} units={units} chosen={chosen} onChange={count} onReset={() => count([])} onClose={() => { setCountAt(null); countAt.focus(); }} />
        </StatusPopover>
      )}
    </>
  );
}

/** Jira: the same reads and saves as before, drawn in the shell's page pattern. */
export function JiraPage({ c }: { c: PageCtx }) {
  const go = () => c.setPane("tasks");
  const wrap = (body: ReactNode) => (
    <SettingsPage title="Jira" purpose={PURPOSE} sections={[{ id: "connection", title: "Connection", kind: "normal", body: <Section id="connection" title="Connection"><div className="wfm px-3 py-2.5"><style>{WFM_CSS}</style>{body}</div></Section> }]} />
  );
  return (
    <JiraPane render={(r) => r.kind === "on" ? <JiraConnectedBody v={r.v} setPane={go} /> : wrap(r.connect)} />
  );
}
