/*
 * The accounts of one tracker, on its settings page. One account: nothing but
 * "Connect another account" under today's pane. Two or more: the accounts, which
 * is the default, and which account each repo uses. The default is not a switch,
 * because it cannot be turned off: it wears a badge, and the others offer
 * "Make default". Nothing here holds a token past the connect box.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { accountNameProblem, hasChoice, identityLine, repoOptions, repoRows, type AccountRow, type RepoAccounts } from "../lib/accountsModel.ts";
import { ICON } from "../lib/iconSize.ts";
import { WarningIcon } from "../lib/glyphIcons.tsx";
import { Button, INPUT, INPUT_STYLE } from "./workspace/Chrome.tsx";
import { SettingsCard, SettingsForm, Field, StatusBadge } from "./SettingsKit.tsx";
import { SettingRow } from "./SettingRow.tsx";
import { PlugIcon } from "./settingsNavIcons.tsx";

/** The box that stores a second account: a name, then the token. */
function ConnectAnother({ provider, stored, onDone, onCancel }: { provider: string; stored: AccountRow[]; onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  // Jira signs in with a site and an email as well as the token.
  const jira = provider === "jira";
  const [site, setSite] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const problem = name ? accountNameProblem(name, stored) : null;
  const go = async () => {
    const p = accountNameProblem(name, stored);
    if (p) { setErr(p); return; }
    if (!token.trim() || busy || (jira && !site.trim())) return;
    setBusy(true); setErr(null);
    const r = await (jira ? api.jiraConnect(email.trim(), site.trim(), token.trim(), name.trim()) : api.providerConnect(provider, token.trim(), name.trim())).catch(() => ({ ok: false, error: "Could not reach the server" }));
    setBusy(false);
    if (!r.ok) { setErr(r.error ?? "That token was refused"); return; }
    onDone();
  };
  const shown = err ?? problem;
  return (
    <SettingsForm label="Connect another account" onSubmit={() => void go()}>
      <Field label="Account name" htmlFor="acct-name" help="A short name you will pick from, like work or personal.">
        <input id="acct-name" value={name} autoComplete="off" spellCheck={false} placeholder="work" onChange={(e) => { setName(e.target.value); setErr(null); }}
          aria-invalid={!!shown} className={`w-full ${INPUT}`} style={INPUT_STYLE} />
      </Field>
      {jira && (
        <>
          <Field label="Site" htmlFor="acct-site" help="Your Jira's address, without https://.">
            <input id="acct-site" value={site} autoComplete="off" spellCheck={false} placeholder="acme.atlassian.net" onChange={(e) => setSite(e.target.value)}
              className={`w-full ${INPUT}`} style={INPUT_STYLE} />
          </Field>
          <Field label="Email" htmlFor="acct-email" help="Leave empty for a Data Center personal access token.">
            <input id="acct-email" value={email} autoComplete="off" spellCheck={false} placeholder="you@example.com" onChange={(e) => setEmail(e.target.value)}
              className={`w-full ${INPUT}`} style={INPUT_STYLE} />
          </Field>
        </>
      )}
      <Field label={jira ? "API token" : "Personal API token"} htmlFor="acct-token">
        <input id="acct-token" type="password" value={token} autoComplete="off" spellCheck={false} placeholder={jira ? "" : "pk_…"} onChange={(e) => setToken(e.target.value)}
          className={`w-full ${INPUT}`} style={INPUT_STYLE} />
      </Field>
      <div className="agx-field">
        <div className="agx-sform-actions">
          <Button type="submit" tone="primary" size="regular" pending={busy} disabled={!token.trim() || !name.trim() || (jira && !site.trim())}>Connect</Button>
          <Button type="button" onClick={onCancel}>Cancel</Button>
        </div>
        {shown && (
          <div role="alert" className="flex gap-2 items-start text-[12px]" style={{ color: "var(--error-ink)" }}>
            <span className="shrink-0 mt-0.5"><WarningIcon size={ICON.sm} /></span><span>{shown}</span>
          </div>
        )}
      </div>
    </SettingsForm>
  );
}

export function AccountsSection({ provider, label, onChanged }: { provider: string; label: string; onChanged: () => void }) {
  const [accounts, setAccounts] = useState<AccountRow[] | null>(null);
  const [map, setMap] = useState<RepoAccounts>({});
  const [repos, setRepos] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(() => {
    void api.providerAccounts(provider).then((r) => setAccounts(r.ok ? r.accounts ?? [] : [])).catch(() => setAccounts([]));
    void api.trackerAccounts().then((r) => { if (r.ok && r.accounts) setMap(r.accounts); }).catch(() => undefined);
    void api.trackerProjects(true).then((r) => { if (r.ok && r.repos) setRepos(r.repos); }).catch(() => undefined);
  }, [provider]);
  useEffect(load, [load]);

  if (!accounts) return null;
  const changed = () => { setAdding(false); load(); onChanged(); };
  const act = async (key: string, run: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(key); setNote(null);
    const r = await run().catch(() => ({ ok: false, error: "Could not reach the server" }));
    setBusy(null);
    if (!r.ok) setNote(r.error ?? "That did not save"); else changed();
  };
  const connect = adding
    ? <ConnectAnother provider={provider} stored={accounts} onDone={changed} onCancel={() => setAdding(false)} />
    : <button type="button" className="agx-textlink text-[12px]" onClick={() => setAdding(true)}>Connect another account</button>;

  if (!hasChoice(accounts)) {
    // Nothing to add a second to when nothing is connected: that is the connect card's job.
    return accounts.length === 1 ? <div className="px-1 pb-4">{connect}</div> : null;
  }
  const rows = repoRows(repos, map, provider, accounts);
  return (
    <>
      <SettingsCard title="Accounts" icon={<PlugIcon size={ICON.sm} />} desc="One account is the default. A repo with no choice below uses it.">
        {accounts.map((a) => (
          <SettingRow key={a.accountKey} agentExempt label={<span className="flex gap-2 items-center"><span className="t-mono">{a.accountKey}</span>{a.isDefault && <StatusBadge tone="info">Default</StatusBadge>}</span>}
            hint={<span className="t-mono">{identityLine(a)}</span>}
            actions={<span className="flex gap-2 items-center">
              {!a.isDefault && <Button pending={busy === `d:${a.accountKey}`} onClick={() => void act(`d:${a.accountKey}`, () => api.providerSetDefault(provider, a.accountKey))}>Make default</Button>}
              <Button tone="danger" pending={busy === `x:${a.accountKey}`} onClick={() => void act(`x:${a.accountKey}`, () => api.providerDisconnect(provider, { accountKey: a.accountKey }))}>Disconnect</Button>
            </span>} />
        ))}
        {note && <div role="alert" className="agx-settings-x py-2 text-[12px]" style={{ color: "var(--error-ink)" }}>{note}</div>}
        <div className="agx-settings-x py-3">{connect}</div>
      </SettingsCard>

      <SettingsCard title="Which account each repo uses" desc={`Pick an account per repo. Leave it on Default to follow the default ${label} account.`}>
        {rows.length === 0 && <div className="agx-settings-x py-3 text-[12px]" style={{ color: "var(--text3)" }}>No repos known yet.</div>}
        {rows.map((r) => (
          <SettingRow key={r.repo} agentExempt label={<span className="t-mono">{r.repo}</span>}
            hint={r.note ? <span className="flex gap-2 items-start" style={{ color: "var(--error-ink)" }}><span className="shrink-0 mt-0.5"><WarningIcon size={ICON.sm} /></span>{r.note}</span> : undefined}
            control={
              <select aria-label={`${label} account for ${r.repo}`} value={r.value} disabled={busy === `r:${r.repo}`} className={INPUT} style={r.removed ? { ...INPUT_STYLE, borderColor: "var(--error)" } : INPUT_STYLE}
                onChange={(e) => void act(`r:${r.repo}`, () => api.setTrackerAccount(r.repo, provider, e.target.value || null))}>
                {repoOptions(r, accounts).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>} />
        ))}
      </SettingsCard>
    </>
  );
}
