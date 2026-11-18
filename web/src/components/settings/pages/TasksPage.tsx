import { useEffect, useMemo, useState, type ReactElement } from "react";
import { SettingsPage } from "../shell/SettingsPage.tsx";
import { Section } from "../shell/Section.tsx";
import { SettingRow } from "../shell/SettingRow.tsx";
import { Switch } from "../../SettingRow.tsx";
import { Select } from "../../Select.tsx";
import { Button, Segmented } from "../../workspace/Chrome.tsx";
import { useInstantSave } from "../save/index.ts";
import { setting } from "../../../lib/settingsRegistry.ts";
import { api } from "../../../lib/api.ts";
import { type TaskLanding } from "../../../lib/taskLanding.ts";
import { TASK_SOURCES, moveTaskSource, resetTaskSourceOrder, taskSourceShown, type TaskSourceId } from "../../../lib/taskSources.ts";
import { cardIdIn } from "../../../../../shared/cardRef.ts";
import { INPUT, INPUT_STYLE } from "../../workspace/Chrome.tsx";
import { useTrackerSetup } from "../../../lib/trackerSetup.ts";
import { rememberTrackerChoices, trackerRows } from "../../../lib/trackerView.ts";
import type { TrackerChoice } from "../../../../../shared/providers.ts";
import type { PageCtx } from "./ctx.ts";

/** One sentence per source, 14 words at most. */
export const SOURCE_HELP: Record<TaskSourceId, string> = {
  github: "Shows issues from the repository you are in.",
  local: "Shows your own list, from Taskwarrior.",
  clickup: "Shows the boards you work from and cards assigned to you.",
  jira: "Shows open cards assigned to you.",
};

/** Source on/off + order. Each source keeps its own `tasks.source.<id>` id; the arrows only reorder. */
function SourceRows({ c }: { c: PageCtx }) {
  const { sourceOrder, setSourceTick, trackerSetup } = c;
  const state = (id: TaskSourceId) => id === "clickup" ? (trackerSetup?.clickup ? "connected" : "not connected")
    : id === "jira" ? (trackerSetup?.jira ? "connected" : "not connected") : undefined;
  return (
    <>
      {sourceOrder.map((id, i) => {
        const s = TASK_SOURCES.find((x) => x.id === id);
        if (!s) return null;
        const on = taskSourceShown(id);
        const st = state(id);
        return (
          <SettingRow key={id} kind="control" label={s.label} help={st ? `${SOURCE_HELP[id]} ${st[0]!.toUpperCase()}${st.slice(1)}.` : SOURCE_HELP[id]}
            control={
              <span className="flex items-center gap-2.5">
                <span className="flex shrink-0 gap-1">
                  {([-1, 1] as const).map((by) => (
                    <Button key={by} size="compact" square disabled={by === -1 ? i === 0 : i === sourceOrder.length - 1}
                      onClick={() => { moveTaskSource(id, by); setSourceTick((n) => n + 1); }}
                      label={`Move ${s.label} ${by === -1 ? "earlier" : "later"}`}>{by === -1 ? "↑" : "↓"}</Button>
                  ))}
                </span>
                <SourceSwitch id={id} on={on} label={s.label} onChanged={() => setSourceTick((n) => n + 1)} />
              </span>
            } />
        );
      })}
    </>
  );
}

function SourceSwitch({ id, on, label, onChanged }: { id: TaskSourceId; on: boolean; label: string; onChanged: () => void }) {
  const save = useInstantSave<boolean>(on, (v) => { setting(`tasks.source.${id}`).set(v); onChanged(); });
  return (
    <button role="switch" aria-checked={on} aria-label={label} onClick={() => save(!on)} className="agx-btn"><Switch on={on} /></button>
  );
}

/** Try a branch name against the card id rule: what it finds, and in which tracker. */
function TryBranchRow() {
  const setup = useTrackerSetup();
  const [text, setText] = useState("feat/ORBIT-1042-retry");
  const id = cardIdIn(text);
  const prefix = id?.split("-")[0]?.toLowerCase();
  const tracker = !id ? "" : (setup?.jira?.prefixes ?? []).some((x) => x.toLowerCase() === prefix) ? " · Jira" : setup?.clickup?.prefix && setup.clickup.prefix.toLowerCase() === prefix ? " · ClickUp" : "";
  return (
    <>
      <SettingRow kind="control" label="Test a branch name" help="See what the rule finds."
        control={<span data-try-branch className="text-[12px]" style={{ color: "var(--text2)" }}>{id ? `${id.toUpperCase()}${tracker}` : "No card id"}</span>} />
      <div className="px-3 pb-2.5">
        <input value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} aria-label="Branch name to test" className={`t-mono min-w-0 w-full ${INPUT}`} style={INPUT_STYLE} />
      </div>
    </>
  );
}

/** "Look it up in": one tracker connected says which; both connected, one choice per repository. */
function LookUpRows() {
  const setup = useTrackerSetup();
  const both = !!setup?.clickup && !!setup?.jira;
  const [rows, setRows] = useState<{ repos: string[]; chosen: Record<string, Exclude<TrackerChoice, "auto">>; writes: Record<string, true> } | null>(null);
  const [note, setNote] = useState("");
  useEffect(() => {
    if (!both) return;
    let live = true;
    void api.trackerProjects(true).then((r) => {
      if (!live || !r.ok) return;
      const chosen = r.projects ?? {};
      setRows({ repos: [...(r.repos ?? []), ...Object.keys(chosen)], chosen, writes: r.clickupWrites ?? {} });
    }).catch(() => { /* stays empty rather than guessing */ });
    return () => { live = false; };
  }, [both]);
  const list = useMemo(() => (rows ? trackerRows(rows.repos, rows.chosen, rows.writes) : []), [rows]);
  const pick = async (repo: string, v: TrackerChoice) => {
    const r = await api.setTrackerProject(repo, v);
    if (!r.ok) { setNote(r.error ?? "Could not save that."); return; }
    setNote("");
    rememberTrackerChoices(r.projects ?? {});
    setRows((cur) => cur && { ...cur, chosen: r.projects ?? {} });
  };
  const only = setup?.jira ? "Jira" : setup?.clickup ? "ClickUp" : null;
  if (!both) {
    return (
      <SettingRow kind="locked" label="Look it up in"
        help={only ? "The one tracker you connected." : "Connect ClickUp or Jira to find cards."}
        reason={only ? "Only one tracker connected" : "No tracker connected"}
        control={<span className="text-[13px]">{only ?? "None"}</span>} />
    );
  }
  return (
    <>
      {note && <div role="alert" className="px-3 py-2 text-[12px]" style={{ color: "var(--error-ink)" }}>{note}</div>}
      {!list.length && <div className="px-3 py-2.5 text-[12px]" style={{ color: "var(--text2)" }}>No repositories to choose for yet.</div>}
      {list.map((row) => (
        <SettingRow key={row.repo} kind="control" label={row.repo} help="Auto reads the prefix of the card id."
          control={<Segmented<TrackerChoice> track label={`${row.repo}: which tracker`} value={row.tracker} onChange={(v) => void pick(row.repo, v)}
            options={[{ id: "auto", label: "Auto" }, { id: "clickup", label: "ClickUp" }, { id: "jira", label: "Jira" }]} />} />
      ))}
    </>
  );
}

/** Tasks: which sources the Tasks view shows, and where a card id is looked up. `folded` is what a page
 *  folded in draws (Tools & services' sections), after these in the same page so the page keeps one rail. */
export function TasksPage({ c, folded }: { c: PageCtx; folded?: ReactElement }) {
  const { landing, setLandingState, setSourceTick } = c;
  const saveLanding = useInstantSave<TaskLanding>(landing, (v) => { setting("tasks.landing").set(v); setLandingState(v); });
  return (
    <SettingsPage title="Tasks" purpose="Choose which sources fill the Tasks view and where a card id is looked up."
      sections={[
        {
          id: "sources", title: "Sources", kind: "normal", body: (
            <Section id="sources" title="Sources" intro="Every source adds its cards to the same board.">
              <SettingRow kind="control" settingId="tasks.landing" label="Tasks view opens on" help="Pick where the view lands when you come back."
                control={<Select align="right" value={landing} onChange={(v) => saveLanding(v as TaskLanding)}
                  options={[{ value: "last", label: "Last used" }, { value: "all", label: "All" }, ...TASK_SOURCES.map((s) => ({ value: s.id, label: s.label }))]} />} />
              <SourceRows c={c} />
              <SettingRow kind="control" label="How sources are chosen" help="One source has to stay on."
                control={<Button onClick={() => { resetTaskSourceOrder(); setSourceTick((n) => n + 1); }}>Reset order</Button>} />
            </Section>
          ),
        },
        {
          id: "card-tracker", title: "Card tracker", kind: "normal", body: (
            <Section id="card-tracker" title="Card tracker" intro="Where a card id in a branch or pull request is looked up.">
              <LookUpRows />
              <SettingRow kind="locked" label="Card id rule" help="Finds a key like ORBIT-1042 in a branch or title."
                reason="Built in" control={<span className="t-mono text-[12px]">ORBIT-1042</span>} />
              <TryBranchRow />
            </Section>
          ),
        },
        ...(folded ? [{ id: "services", title: "Tools & services", kind: "normal" as const, body: folded }] : []),
      ]} />
  );
}
