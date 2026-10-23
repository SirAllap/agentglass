import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api } from "../lib/api.ts";
import { emitControl } from "../lib/controlBus.ts";
import { closeSettings } from "../lib/openSettings.ts";
import { noteJiraSettings, useJiraSettings } from "../lib/jiraSettings.ts";
import { rememberTaskSource } from "../lib/taskLanding.ts";
import { __forgetTrackerSetup } from "../lib/trackerSetup.ts";
import { PROVIDERS, type JiraProjectChoice, type JiraStatus } from "../../../shared/providers.ts";
import { SettingRow, Switch } from "./SettingRow.tsx";
import { EmptyState, Field, SettingsCard, SettingsForm, StatusBadge, helpIdFor } from "./SettingsKit.tsx";
import { Button, INPUT, INPUT_STYLE, Segmented } from "./workspace/Chrome.tsx";
import { HandoffSettings } from "./jira/HandoffSettings.tsx";
import { HIT } from "../lib/iconSize.ts";

const SPEC = PROVIDERS.find((p) => p.id === "jira")!;

/** Sign in: the page's face before Jira is connected. Jira's Cloud / Data Center choice comes first because it decides which fields there are. */
function ConnectCard({ onDone }: { onDone: () => void }) {
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
    <SettingsCard title="Jira" desc="Link it once and a pull request knows its card."
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
              </div>
              {note && <div role="alert" className="agx-field-e">{note}</div>}
            </div>
          </SettingsForm>
        } />
    </SettingsCard>
  );
}

const Tag = ({ children }: { children: ReactNode }) => (
  <span className="inline-flex items-center px-2 rounded-md text-[11px] font-semibold" style={{ height: 20, background: "var(--bg)", boxShadow: "inset 0 0 0 1px var(--surface-line)" }}>{children}</span>
);
const Value = ({ children }: { children: ReactNode }) => <span className="text-[13px]">{children}</span>;

const runsOn = (s: JiraStatus): string => (s.deployment === "cloud" || (!s.deployment && s.kind === "cloud") ? "Jira Cloud" : "Jira Data Center");
const signIn = (s: JiraStatus): string => (s.auth === "bearer" ? "Personal access token" : "Account and token");

/**
 * Jira's own page, built from the settings kit like ClickUp's. It owns the
 * connection (the form that used to live in Tools & services), the switch
 * that lets agentglass write, the projects the site exposes, the hand-off,
 * and the way into the saved views. `tracker` is the per-project tracker
 * choice, drawn between the projects and the hand-off.
 */
export function JiraPane({ tracker }: { tracker?: ReactNode }) {
  const [status, setStatus] = useState<JiraStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [projects, setProjects] = useState<JiraProjectChoice[] | null>(null);
  const [projectsError, setProjectsError] = useState("");
  const [views, setViews] = useState<{ views: number; folders: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const settings = useJiraSettings();

  const read = useCallback(() => {
    setFailed(false);
    void api.jiraStatus().then((s) => setStatus(s)).catch(() => { setFailed(true); });
  }, []);
  useEffect(() => { read(); }, [read]);

  const connected = !!status?.connected;
  useEffect(() => {
    if (!connected) return;
    let live = true;
    void api.jiraProjectChoices().then((r) => {
      if (!live) return;
      if (!r?.ok) { setProjectsError(r?.error || "Could not read the site's projects"); setProjects([]); return; }
      setProjectsError(""); setProjects(r.projects);
    }).catch(() => { if (live) { setProjectsError("Could not reach the server"); setProjects([]); } });
    void api.jiraViews().then((v) => { if (live && v) setViews({ views: v.views?.length ?? 0, folders: v.folders?.length ?? 0 }); }).catch(() => undefined);
    return () => { live = false; };
  }, [connected]);

  if (!status) {
    return <div className="py-6 text-[11px]" style={{ color: failed ? "var(--error-ink)" : "var(--text3)" }}>{failed ? "Could not read Jira's state." : "Reading your settings…"}</div>;
  }
  if (!connected) return <ConnectCard onDone={read} />;

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
  const disconnect = async () => {
    setBusy(true);
    const r = await api.providerDisconnect("jira").catch(() => null);
    setBusy(false);
    if (!r?.ok) { setNote(r?.error ?? "Could not disconnect"); return; }
    __forgetTrackerSetup();
    setProjects(null); setViews(null); setNote(null);
    read();
  };
  const openTab = () => {
    rememberTaskSource("jira");
    emitControl({ cmd: "view", to: "tasks" });
    emitControl({ cmd: "esc" });
    closeSettings();
  };

  return (
    <>
      <SettingsCard title="Jira" desc={status.account ? `Signed in as ${status.account}.` : SPEC.what}
        status={<StatusBadge tone="ok">Connected</StatusBadge>}>
        <SettingRow agentExempt label="Site" control={<Value>{status.site}</Value>} />
        <SettingRow agentExempt label="Runs on" control={<Value>{runsOn(status)}</Value>} />
        <SettingRow agentExempt label="Signs in with" control={<Value>{signIn(status)}</Value>} />
      </SettingsCard>

      {/* The one switch that decides whether anything can write. Its state is a badge first in the control column, the switch after it. */}
      <SettingsCard title="Changes in Jira">
        <SettingRow agentExempt label={<span id="jira-changes-l">Let agentglass change cards</span>}
          hint={writes
            ? "Only the buttons on a card can change it (move, assign, comment, hand off), one at a time, when you press them."
            : "agentglass only reads. Turn this on to let the buttons on a Jira card move it, assign it, comment on it and hand it off."}
          status={<span data-guard={writes ? "on" : "off"}><StatusBadge tone={writes ? "warn" : "off"}>{writes ? "On" : "Read-only"}</StatusBadge></span>}
          control={<button type="button" role="switch" aria-checked={writes} aria-labelledby="jira-changes-l" disabled={busy}
            onClick={() => void setWrites(!writes)} className="agx-switch-hit inline-flex items-center rounded-full" style={{ minHeight: HIT }}>
            <Switch on={writes} busy={busy} /></button>} />
        {note && <SettingRow agentExempt label="That did not work" hint={<span role="alert" style={{ color: "var(--error-ink)" }}>{note}</span>} />}
      </SettingsCard>

      <SettingsCard title="Projects" desc="The projects this site exposes, and the key each card id starts with."
        status={<StatusBadge tone={projectsError ? "warn" : projects ? "ok" : "checking"}>{projectsError ? "Not read" : projects ? `${projects.length} found` : "Reading"}</StatusBadge>}>
        {projectsError && <SettingRow agentExempt label={projectsError} hint="Open the page again to try again." />}
        {!projectsError && projects && !projects.length && <EmptyState>This account sees no projects.</EmptyState>}
        {!!projects?.length && (
          <SettingRow agentExempt label="Projects on this site"
            below={
              <ul className="m-0 p-0 flex flex-col gap-2" style={{ listStyle: "none" }}>
                {projects.map((p) => (
                  <li key={p.key} className="flex gap-2 items-center flex-wrap"><Tag>{p.key}</Tag><span className="text-[13px]">{p.name}</span></li>
                ))}
              </ul>
            } />
        )}
      </SettingsCard>
      {tracker}

      <HandoffSettings />

      <SettingsCard title="Saved views and folders"
        desc="The boards and filters you saved sit in the Jira tab's sidebar. Add and remove them there.">
        <SettingRow agentExempt label="Views and folders"
          hint={views ? `${views.views} ${views.views === 1 ? "view" : "views"} · ${views.folders} ${views.folders === 1 ? "folder" : "folders"} saved on this machine.` : "Reading what is saved…"}
          actions={<Button onClick={openTab}>Open the Jira tab</Button>} />
      </SettingsCard>

      <SettingsCard title="Disconnect">
        <SettingRow agentExempt label="Disconnect Jira" hint="Removes the token from this machine. Nothing changes in Jira."
          actions={<Button tone="danger" pending={busy} onClick={() => void disconnect()}>Disconnect</Button>} />
      </SettingsCard>
    </>
  );
}
