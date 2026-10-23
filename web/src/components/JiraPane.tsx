import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api } from "../lib/api.ts";
import { emitControl } from "../lib/controlBus.ts";
import { closeSettings } from "../lib/openSettings.ts";
import { noteJiraSettings, useJiraSettings } from "../lib/jiraSettings.ts";
import { rememberTaskSource } from "../lib/taskLanding.ts";
import { __forgetTrackerSetup } from "../lib/trackerSetup.ts";
import { PROVIDERS, type JiraStatus, type JiraSteps } from "../../../shared/providers.ts";
import { SettingRow } from "./SettingRow.tsx";
import { Field, ProblemNote, SettingsCard, SettingsForm, StatusBadge, helpIdFor } from "./SettingsKit.tsx";
import { useReportProblem, useReportSaving } from "./SettingsPageState.tsx";
import { problemChip } from "../lib/settingsStates.ts";
import { Button, INPUT, INPUT_STYLE, Segmented } from "./workspace/Chrome.tsx";
import { JiraSettingsView } from "./jira/JiraSettingsView.tsx";
import { WaitingMap } from "./ClickUpPane.tsx";
import { __forgetJiraUnits, useJiraUnits } from "../lib/jiraUnits.ts";
import type { StepsPatch } from "../lib/jiraWorkflow.ts";
import { noteJiraSteps } from "../lib/jiraStepUi.ts";
import { PlugIcon } from "./settingsNavIcons.tsx";
import { ICON } from "../lib/iconSize.ts";

const SPEC = PROVIDERS.find((p) => p.id === "jira")!;

/** Sign in: the page's face before Jira is connected. Jira's Cloud / Data Center choice comes first because it decides which fields there are. */
function ConnectCard({ onDone, onCancel }: { onDone: () => void; onCancel?: () => void }) {
  const [kind, setKind] = useState<"cloud" | "dc">("cloud");
  const [site, setSite] = useState("");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const cloud = kind === "cloud";
  const ready = !!token.trim() && !!site.trim();
  const go = async () => {
    if (!ready || busy) return;
    setBusy(true);
    const r = await api.jiraConnect(email.trim(), site.trim(), token.trim()).catch(() => ({ ok: false, error: "Could not reach the server" }));
    setBusy(false);
    if (!r.ok) { setNote(r.error ?? "That did not work"); return; }
    // Cleared on success and only on success: a refused token is usually one that was pasted short.
    setToken(""); setEmail(""); setSite(""); setNote(null);
    __forgetTrackerSetup();
    onDone();
  };
  return (
    <SettingsCard title="Jira" icon={<PlugIcon size={ICON.sm} />} desc="Link it once and a pull request knows its card."
      status={<StatusBadge tone="off">Not connected</StatusBadge>}>
      <SettingRow agentExempt label="Connect with a token" hint={SPEC.what}
        detail={SPEC.note ? { summary: SPEC.noteTitle ?? "Where the token is stored", body: SPEC.note } : undefined}
        below={
          <SettingsForm label="Connect Jira" onSubmit={() => void go()}>
            <div className="agx-field" role="group" aria-labelledby="jira-kind">
              <span id="jira-kind" className="agx-field-l">Jira type</span>
              <Segmented label="Jira type" value={kind}
                onChange={(v) => { setKind(v); setEmail(""); }}
                options={[{ id: "cloud", label: "Cloud" }, { id: "dc", label: "Data Center" }]} />
            </div>
            <Field label="Site" htmlFor="jira-site" help={cloud ? "Your site's address, without https://." : "Your Jira's address, without https://."}>
              <input id="jira-site" type="text" value={site} onChange={(e) => setSite(e.target.value)}
                placeholder={cloud ? "acme.atlassian.net" : "jira.example.com"} spellCheck={false} autoComplete="off"
                aria-describedby={helpIdFor("jira-site")} className={`w-full ${INPUT}`} style={INPUT_STYLE} />
            </Field>
            <Field label={cloud ? "Email" : "Username (optional)"} htmlFor="jira-email"
              help={cloud ? "The email you sign in to Atlassian with." : "Only to sign in with an account and its password. Leave it empty for a personal access token."}>
              <input id="jira-email" type="text" value={email} onChange={(e) => setEmail(e.target.value)}
                placeholder={cloud ? "you@acme.example" : ""} spellCheck={false} autoComplete="off"
                aria-describedby={helpIdFor("jira-email")} className={`w-full ${INPUT}`} style={INPUT_STYLE} />
            </Field>
            {/* `type=password`, and there is nothing to reveal: the value here is what you are typing, never what is stored. */}
            <Field label={cloud ? "API token" : "Personal access token or password"} htmlFor="jira-token"
              link={cloud && SPEC.help ? { href: SPEC.help, text: "How to get one" } : undefined}
              help={cloud ? "Made on your Atlassian account's security page." : "Made under your Jira profile, in Personal access tokens."}>
              <input id="jira-token" type="password" value={token} onChange={(e) => setToken(e.target.value)}
                placeholder="Paste the token" spellCheck={false} autoComplete="off"
                aria-describedby={helpIdFor("jira-token")} className={`w-full ${INPUT}`} style={INPUT_STYLE} />
            </Field>
            <div className="agx-field">
              <div className="agx-sform-actions">
                <Button type="submit" tone="primary" pending={busy} disabled={!ready}>Connect</Button>
                {onCancel && <Button onClick={onCancel}>Cancel</Button>}
              </div>
              {note && <div role="alert" className="agx-field-e">{note}</div>}
            </div>
          </SettingsForm>
        } />
    </SettingsCard>
  );
}

const EMPTY_STEPS: JiraSteps = { handoff: { enabled: false, blocks: [] }, review: { enabled: false, blocks: [] }, merge: { enabled: false, blocks: [] } };

/**
 * Jira's own page: the connection form before Jira is connected, and after it the
 * workflow page (`JiraSettingsView`), which is drawn from what this reads and saves.
 * `tracker` is the per-project tracker choice, drawn between the map and the saved views.
 * Everything saved here is the local settings file; only the switch lets a press write to Jira.
 */
export function JiraPane({ tracker }: { tracker?: ReactNode }) {
  const [status, setStatus] = useState<JiraStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [steps, setSteps] = useState<JiraSteps | null>(null);
  const [overrides, setOverrides] = useState<string[]>([]);
  const [views, setViews] = useState<{ views: number; folders: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  const settings = useJiraSettings();

  const read = useCallback(() => {
    setFailed(false);
    void api.jiraStatus().then((s) => setStatus(s)).catch(() => { setFailed(true); });
  }, []);
  useEffect(() => { read(); }, [read]);

  const connected = !!status?.connected;
  const { state: units, reread } = useJiraUnits(connected);
  /* Two reads can fail and the page already knew about both: its own state (nothing is drawn without it)
     and the cards behind the connection (drawn from what was last read, with "As of"). The shell shows both
     as the same red dot and chip, and a write that is out as "Saving". */
  useReportProblem("jira",
    failed ? { chip: problemChip(), title: "Could not read Jira's state." }
      : units.kind === "error" ? { chip: problemChip(units), title: units.error } : null,
    failed ? read : reread);
  useReportSaving("jira", busy);
  const readSteps = useCallback(() => {
    void api.jiraSteps().then((r) => { if (r?.ok && r.steps) { setSteps(r.steps); setOverrides(r.overrides ?? []); } else setSteps((s) => s ?? EMPTY_STEPS); }).catch(() => setSteps((s) => s ?? EMPTY_STEPS));
  }, []);
  useEffect(() => {
    if (!connected) return;
    let live = true;
    readSteps();
    void api.jiraViews().then((v) => { if (live && v) setViews({ views: v.views?.length ?? 0, folders: v.folders?.length ?? 0 }); }).catch(() => undefined);
    return () => { live = false; };
  }, [connected, readSteps]);

  if (!status) {
    if (failed) {
      return (
        <SettingsCard title="Jira" icon={<PlugIcon size={ICON.sm} />} tone="error" status={<StatusBadge tone="err">Not reachable</StatusBadge>}>
          <ProblemNote title="Could not read Jira's state" action={<Button onClick={read}>Try again</Button>}>
            The local server did not answer, so nothing here is known. Nothing was changed.
          </ProblemNote>
        </SettingsCard>
      );
    }
    return <div className="py-6 text-[11px]" style={{ color: "var(--text3)" }}>Reading your settings…</div>;
  }
  if (!connected) return <div className="wfm"><ConnectCard onDone={read} /><WaitingMap name="Jira" /></div>;

  const writes = settings ? settings.writes : status.writes;
  const setWrites = async (on: boolean) => {
    setBusy(true);
    const r = await api.jiraWrites(on).catch(() => null);
    setBusy(false);
    if (!r?.ok) { setNote(r?.error ?? "That did not save"); return; }
    setNote(null);
    setStatus({ ...status, writes: !!r.writes });
    if (settings) noteJiraSettings({ ...settings, writes: !!r.writes });
  };
  const setWriteKind = async (kind: keyof JiraStatus["writeKinds"], on: boolean) => {
    setBusy(true);
    const r = await api.jiraWriteKind(kind, on).catch(() => null);
    setBusy(false);
    if (!r?.ok || !r.writeKinds) { setNote(r?.error ?? "That did not save"); return; }
    setNote(null);
    setStatus({ ...status, writeKinds: r.writeKinds });
  };
  const saveSteps = async (patch: StepsPatch): Promise<boolean> => {
    const r = await api.setJiraSteps(patch).catch(() => null);
    if (!r?.ok || !r.steps) { setNote(r?.error ?? "That did not save"); return false; }
    setNote(null); setSteps(r.steps); setOverrides(r.overrides ?? []); noteJiraSteps({ steps: r.steps, overrides: r.overrides ?? [] });
    return true;
  };
  const clearOverride = async (project: string) => {
    const r = await api.setJiraHandoff(project, null).catch(() => null);
    if (!r?.ok) { setNote(r?.error ?? "That did not save"); return; }
    setNote(null);
    if (settings && r.handoff) noteJiraSettings({ writes: settings.writes, handoff: r.handoff });
    readSteps();
  };
  const disconnect = async () => {
    setBusy(true);
    const r = await api.providerDisconnect("jira").catch(() => null);
    setBusy(false);
    if (!r?.ok) { setNote(r?.error ?? "Could not disconnect"); return; }
    __forgetTrackerSetup(); __forgetJiraUnits();
    setSteps(null); setViews(null); setNote(null);
    read();
  };
  const openTab = () => {
    rememberTaskSource("jira");
    emitControl({ cmd: "view", to: "tasks" });
    emitControl({ cmd: "esc" });
    closeSettings();
  };

  if (replacing) return <div className="wfm"><ConnectCard onDone={() => { setReplacing(false); read(); }} onCancel={() => setReplacing(false)} /></div>;

  return (
    <JiraSettingsView status={status} writes={writes} writesBusy={busy} steps={steps} overrides={overrides} units={units} views={views} note={note}
      tracker={tracker} busy={busy}
      onWrites={(on) => void setWrites(on)} onWriteKind={(k, on) => void setWriteKind(k, on)} onReplace={() => setReplacing(true)} onSteps={saveSteps} onReread={reread}
      onClearOverride={(k) => void clearOverride(k)} onOpenTab={openTab} onDisconnect={() => void disconnect()} />
  );
}
