import { useEffect, useState } from "react";
import { api } from "../../lib/api.ts";
import { Select } from "../Select.tsx";
import { SettingRow, Toggle } from "../SettingRow.tsx";
import { EmptyState, SettingsCard, StatusBadge } from "../SettingsKit.tsx";
import { noteJiraSettings, useJiraSettings } from "../../lib/jiraSettings.ts";
import { useTrackerSetup } from "../../lib/trackerSetup.ts";
import type { JiraHandoffRule, JiraProjectChoice } from "../../../../shared/providers.ts";

type ProjectStatus = { id: string; name: string; kind: "open" | "done" | "other" };
const NONE = "\u0000none";
const EMPTY: JiraHandoffRule = { to: null, askTo: false, clear: false, askClear: false };

/**
 * The Jira hand-off, set per project: the status the hand-off button moves a
 * card to, and whether it takes the assignee off on the way. Each value can
 * instead ask when it runs, and then it is where the question starts. Nothing
 * here names a status: the list is the project's own, read from the site when
 * the list is opened (one request, remembered by the server for ten minutes).
 *
 * A card for Jira's Settings page (`<HandoffSettings />`, no props); it
 * draws nothing while Jira is not connected. Saving writes the local settings
 * file only, never Jira.
 */
export function HandoffSettings() {
  const connected = !!useTrackerSetup()?.jira;
  const settings = useJiraSettings();
  const [projects, setProjects] = useState<JiraProjectChoice[] | null>(null);
  const [error, setError] = useState("");
  const [project, setProject] = useState("");
  const [statuses, setStatuses] = useState<Record<string, ProjectStatus[] | string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!connected || projects) return;
    void api.jiraProjectChoices().then((r) => {
      if (!r?.ok) { setError(r?.error || "Could not read the site's projects"); setProjects([]); return; }
      setProjects(r.projects);
      setProject((p) => p || r.projects[0]?.key || "");
    }).catch(() => { setError("Could not reach the server"); setProjects([]); });
  }, [connected, projects]);

  if (!connected) return null;
  const rule = (project && settings?.handoff[project]) || EMPTY;
  const list = statuses[project];
  const loadStatuses = () => {
    if (!project || list !== undefined) return;
    void api.jiraProjectStatuses(project)
      .then((r) => setStatuses((m) => ({ ...m, [project]: r?.ok ? (r.statuses ?? []) : (r?.error || "Could not read the statuses") })))
      .catch(() => setStatuses((m) => ({ ...m, [project]: "Could not reach the server" })));
  };
  // Until the stored rules are read, a press would save over them from an empty rule.
  const frozen = saving || !settings;
  const save = async (next: JiraHandoffRule) => {
    if (!project || frozen) return;
    setSaving(true);
    const empty = !next.to && !next.askTo && !next.clear && !next.askClear;
    const r = await api.setJiraHandoff(project, empty ? null : next).catch(() => null);
    setSaving(false);
    if (!r?.ok) { setError(r?.error || "Could not save the hand-off"); return; }
    setError("");
    noteJiraSettings({ writes: !!r.writes, handoff: r.handoff ?? {} });
  };

  const configured = Object.keys(settings?.handoff ?? {}).length;
  const shown = Array.isArray(list) ? list : [];
  // The saved status stays in the list before the project's statuses are read, so the select shows it.
  const statusOptions = [
    { value: NONE, label: "None", dim: true },
    ...(rule.to && !shown.some((s) => s.id === rule.to!.id) ? [{ value: rule.to.id, label: rule.to.name, pill: true }] : []),
    ...shown.map((s) => ({ value: s.id, label: s.name, pill: true, dim: s.kind === "done" })),
    ...(typeof list === "string" ? [{ value: "\u0000why", label: list, disabled: true }] : []),
  ];

  return (
    <SettingsCard title="QA hand-off"
      desc="Where a card's hand-off button moves it, and whether it takes the assignee off. Either can ask when it runs instead, starting from what is set here."
      status={<StatusBadge tone={configured ? "ok" : "off"}>{configured ? `${configured} ${configured === 1 ? "project" : "projects"} set` : "Not set"}</StatusBadge>}>
      {projects === null && <EmptyState>Reading the site's projects…</EmptyState>}
      {projects && !projects.length && !error && <EmptyState>This account sees no projects to set a hand-off for.</EmptyState>}
      {!!projects?.length && (
        <>
          <SettingRow agentExempt label="Project" hint="Each project has its own hand-off."
            control={<Select value={project} title="Project" onChange={setProject}
              options={projects.map((p) => ({ value: p.key, label: `${p.key} · ${p.name}`, ...(settings?.handoff[p.key] ? { hint: "set" } : null) }))} />} />
          <SettingRow agentExempt label="Moves the card to" hint="The project's own statuses. None leaves it to be chosen."
            control={<Select value={rule.to?.id ?? NONE} title="Hand-off status" onOpen={loadStatuses} busy={saving} disabled={!settings}
              onChange={(v) => {
                if (v === NONE) { void save({ ...rule, to: null }); return; }
                const s = shown.find((x) => x.id === v) ?? (rule.to?.id === v ? rule.to : null);
                if (s) void save({ ...rule, to: { id: s.id, name: s.name } });
              }}
              options={statusOptions} />} />
          <Toggle agentExempt on={rule.askTo} disabled={frozen} onClick={() => { void save({ ...rule, askTo: !rule.askTo }); }}
            label="Ask which status when it runs"
            hint="The status above becomes where the question starts, instead of being fixed." />
          <Toggle agentExempt on={rule.clear} disabled={frozen} onClick={() => { void save({ ...rule, clear: !rule.clear }); }}
            label="Take the assignee off"
            hint="Whoever is on the card comes off it as it moves, unless somebody else was put on it meanwhile." />
          <Toggle agentExempt on={rule.askClear} disabled={frozen} onClick={() => { void save({ ...rule, askClear: !rule.askClear }); }}
            label="Ask about the assignee when it runs"
            hint="Fix the choice above, or be asked each time." />
        </>
      )}
      {error && <SettingRow agentExempt label="That did not work" hint={<span role="alert" style={{ color: "var(--error-ink)" }}>{error}</span>} />}
    </SettingsCard>
  );
}
