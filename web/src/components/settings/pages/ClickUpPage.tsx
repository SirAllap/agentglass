import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api } from "../../../lib/api.ts";
import { Dot } from "../../StatusPanel.tsx";
import { ListEye } from "../../WorkflowMap.tsx";
import { Tagged } from "../../TrackerMapParts.tsx";
import { eyeIds } from "../../../lib/workflowLayout.ts";
import { SettingsPage } from "../shell/SettingsPage.tsx";
import { Section, DangerZone } from "../shell/Section.tsx";
import { SettingRow } from "../shell/SettingRow.tsx";
import { Switch } from "../../SettingRow.tsx";
import { Button, Segmented } from "../../workspace/Chrome.tsx";
import { DangerAction, useInstantSave } from "../save/index.ts";
import { CardSkillsRow, ClickUpPane, type ClickUpView } from "../../ClickUpPane.tsx";
import { WaitingMap } from "../../ClickUpPane.tsx";
import { WorkflowMap } from "../../WorkflowMap.tsx";
import { WFM_CSS } from "../../workflowMapStyle.ts";
import { StatusPopover } from "../../StatusPanel.tsx";
import { CardView, CountedPicker, PrView, ago } from "../../TrackerMapParts.tsx";
import { CLICKUP, clickupAdd, clickupBlocks, clickupRemove, addTurnsWritesOn } from "../../../lib/clickupWorkflow.ts";
import { triggerOf } from "../../../lib/stepBlocksView.ts";
import { withCounted } from "../../../lib/workflowMap.ts";
import { DEFAULT_CARD_SKILL_PATTERN } from "../../../../../shared/cardSkills.ts";
import type { ClickUpStepBlock } from "../../../../../shared/providers.ts";

const n = CLICKUP.nouns;

/** The minute's allowance as the last response said it. A read-out of the server's own count, not a value to set. */
function BudgetRow() {
  const [b, setB] = useState<{ limit: number; used: number; resetsInSec: number; known: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { setBusy(true); void api.clickupBudget().then((r) => { if (r.ok) setB(r); }).catch(() => undefined).finally(() => setBusy(false)); }, []);
  useEffect(() => { load(); }, [load]);
  return (
    <SettingRow kind="control" label="Last minute" help="Cached reads do not count."
      control={<span className="flex items-center gap-2"><span className="text-[12px] tabular-nums" style={{ color: "var(--text2)" }}>{b ? `${b.used} / ${b.limit}` : "Reading"}</span>
        <Button onClick={load} disabled={busy}>Read again</Button></span>} />
  );
}

function ClickUpConnectedBody({ v }: { v: ClickUpView }) {
  const [countAt, setCountAt] = useState<HTMLElement | null>(null);
  const subtasks = v.prefs.assigned.includeSubtasks;
  const saveSub = useInstantSave<boolean>(subtasks, (on) => { void v.send({ assigned: { includeSubtasks: on } } as never); });
  const folded = v.part.folded;
  const readNote = v.asOf && v.state.kind === "ok" ? `Read ${ago(v.asOf)}, kept for 10 minutes.` : "Nothing needs setting up.";
  const reading = (
    <Section id="reading" title="Reading cards" intro="How agentglass reads your cards from ClickUp.">
      <SettingRow kind="control" settingId="clickup.statusSpaces.counted" label={`${n.lists[0]!.toUpperCase()}${n.lists.slice(1)} that count`}
        help={v.chosen ? "You chose these. The rest are ignored, not deleted." : "Where your cards live, until you choose."}
        control={<span className="flex items-center gap-2"><span className="text-[12px] max-w-[220px]" style={{ color: "var(--text2)" }}>{v.countWord}</span>
          <Button aria-haspopup="listbox" aria-expanded={!!countAt} disabled={!v.units.length} onClick={(e) => setCountAt(countAt ? null : e.currentTarget)}>Change</Button></span>} />
      <SettingRow kind="control" settingId="clickup.includeSubtasks" label="Subtasks on Assigned to me" help="Adds subtasks to that list, so reading takes about twice as long."
        control={<button role="switch" aria-checked={subtasks} aria-label="Subtasks on Assigned to me" onClick={() => saveSub(!subtasks)} className="agx-btn"><Switch on={subtasks} /></button>} />
      <SettingRow kind="locked" label="Card skills default" help="Offers skills that match ClickUp's own naming when a card is open."
        reason="Set by the app" control={<span className="t-mono text-[11px]">{DEFAULT_CARD_SKILL_PATTERN}</span>} />
      <CardSkillsRow />
      <SettingRow kind="locked" label="Not used by steps"
        help={folded.length ? `Left out: ${folded.map((f) => f.unit.name).join(", ")}.` : "Nothing is left out."}
        reason="Read from ClickUp" control={<span className="text-[12px]">{folded.length}</span>} />
      <SettingRow kind="control" label="How we read it" help={readNote}
        control={<Button onClick={v.reread} disabled={v.frozen || v.state.kind === "loading"}>Re-read</Button>} />
    </Section>
  );
  const steps = (
    <Section id="steps" title="Steps" intro="Each step adds one control to agentglass. You build what it does from blocks.">
      <div className="wfm px-3 py-2.5">
        <style>{WFM_CSS}</style>
        <WorkflowMap adapter={CLICKUP} part={v.part} panel={v.panel} steps={v.steps} changesOn={v.changesOn} frozen={v.frozen} source={v.source}
          onHover={v.setHover}
          onAdd={async (kind) => { const ok = await v.send(clickupAdd(kind)); if (ok && addTurnsWritesOn(v.changesOn, v.steps.length)) await v.setChanges(true); return ok; }}
          onBlocks={(kind, blocks) => { const t = triggerOf(kind); if (t) void v.send(clickupBlocks(t, blocks.filter((b): b is ClickUpStepBlock => b.type !== "link"))); }}
          onRemove={(kind) => { void v.send(clickupRemove(kind)); }}
          people={v.readPeople as never} fields={v.readFields}
          onToggleCounted={v.toggleCounted}
          onCountAgain={(u) => { const ids = withCounted(v.units, u.fromList && u.spaceId ? u.spaceId : u.id, true); if (ids) v.count(ids); }}
          onRetry={v.reread} />
        {v.note && <div role="alert" className="text-[12px] mt-2" style={{ color: "var(--error-ink)" }}>{v.note}</div>}
      </div>
    </Section>
  );
  const lists = (
    <Section id="lists" title="Lists" intro="Each list that counts, with its statuses.">
      <SettingRow kind="control" label="Your lists and their statuses" help="Change which lists count under Reading cards."
        control={<span className="text-[12px]" style={{ color: "var(--text2)" }}>{v.part.counted.length}</span>} />
      {v.part.counted.map((u) => (
        <SettingRow key={u.id} kind="control" label={u.name} help={`${u.statuses.length} statuses.`}
          control={<span className="flex items-center gap-2 flex-wrap justify-end">
            <span className="flex gap-1 flex-wrap">{u.statuses.map((s) => <Tagged key={s.status}><Dot type={s.type} color={s.color} />{s.status}</Tagged>)}</span>
            <ListEye unit={u} nouns={n} onToggle={v.toggleCounted} blocked={v.frozen || eyeIds(v.units, u) === null} /></span>} />
      ))}
    </Section>
  );
  const budget = (
    <Section id="budget" title="Request budget" intro="ClickUp allows about 100 requests a minute per token.">
      <BudgetRow />
    </Section>
  );
  const danger = (
    <DangerZone>
      <SettingRow kind="control" label="Disconnect ClickUp" help="Your saved boards and steps stay, and you can reconnect anytime."
        control={<DangerAction label="Disconnect" onConfirm={() => v.disconnect()} />} />
    </DangerZone>
  );
  const shows = (
    <Section id="shows" title="Where this shows up" intro="Hover a step to see which part it adds.">
      <div className="px-3 py-2.5 flex flex-col gap-3">
        <Segmented label={`Does the pull request name a ${n.item}?`} value={v.linked ? "1" : "0"} onChange={(x) => v.setLinked(x === "1")}
          options={[{ id: "1", label: "Linked" }, { id: "0", label: "No link" }]} />
        <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
          <div><PrView adapter={CLICKUP} status={CLICKUP.sample.status} steps={v.live} all={v.steps} writes={v.changesOn} hover={null} linked={v.linked} /></div>
          <div><CardView adapter={CLICKUP} status={CLICKUP.sample.status} writes={v.changesOn} linked={v.linked} /></div>
        </div>
      </div>
    </Section>
  );
  return (
    <>
      <SettingsPage title="ClickUp" purpose="How agentglass reads your ClickUp cards and the steps you add to them."
        sections={[
          { id: "reading", title: "Reading cards", kind: "normal", body: reading },
          { id: "lists", title: "Lists", kind: "normal", body: lists },
          { id: "steps", title: "Steps", kind: "normal", body: steps },
          { id: "shows", title: "Where this shows up", kind: "normal", body: shows },
          { id: "budget", title: "Request budget", kind: "normal", body: budget },
          { id: "danger", title: "Danger zone", kind: "danger", body: danger },
        ]} />
      {countAt && (
        <StatusPopover anchor={countAt} label={`${n.lists} that count`} onClose={(f) => { setCountAt(null); if (f) countAt.focus(); }}>
          <CountedPicker n={n} units={v.units} chosen={v.chosen} onChange={v.count} onReset={() => v.count([])} onClose={() => { setCountAt(null); countAt.focus(); }} />
        </StatusPopover>
      )}
    </>
  );
}

/** ClickUp (shown only while connected): the same reads and saves as before, drawn in the shell's page pattern. */
export function ClickUpPage() {
  return (
    <ClickUpPane render={(r): ReactNode => r.kind === "out"
      ? <SettingsPage title="ClickUp" purpose="Connect ClickUp so a pull request knows its card."
          sections={[{ id: "connect", title: "Connection", kind: "normal", body: <Section id="connect" title="Connection"><div className="wfm px-3 py-2.5"><style>{WFM_CSS}</style>{r.connect}<WaitingMap /></div></Section> }]} />
      : <ClickUpConnectedBody v={r.v} />} />
  );
}
