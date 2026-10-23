// The screen for docs/PLUGINS.md's six routes.
//
// The mechanism renders nothing of its own — see the note at the top of
// server/src/plugins.ts. This page is OUR screen, showing OUR data about
// what somebody installed: install copies a folder and runs nothing,
// enabling is the one moment a human grants a scope, and disabling stops
// the process that scope was minted for. Reviewing that from a terminal is
// not review, which is the whole reason this file exists.
import { PluginMark } from "./plugins/PluginMark.tsx";
import { BackIcon } from "./browser/icons.tsx";
import { emitControl } from "../lib/controlBus.ts";
import { closeSettings } from "../lib/openSettings.ts";
import { clearPluginInstall, pluginInstallRequest, subscribePluginInstall } from "../lib/installPlugin.ts";
import { PluginSettingsPane } from "./plugins/PluginSettingsPane.tsx";
import { Market } from "./plugins/Market.tsx";
import { PluginDeclaration } from "./plugins/PluginDeclaration.tsx";
import { UnboxedConsent } from "./plugins/UnboxedConsent.tsx";
import { envHatchNotice } from "../lib/pluginBoxState.ts";
import { PluginWhyStopped } from "./plugins/PluginWhyStopped.tsx";
import { ICON } from "../lib/iconSize.ts";
import { useDialogs } from "./ConfirmDialog.tsx";
import { useCallback, useEffect, useState, useMemo, useSyncExternalStore } from "react";
import { SettingRow, Switch } from "./SettingRow.tsx";
import { Disclosure, EmptyState, Field, SettingsCard, SettingsForm, StatusBadge, type StatusTone } from "./SettingsKit.tsx";
import { api } from "../lib/api.ts";
import { fmtAgo } from "../lib/format.ts";
import { usePoll } from "../lib/usePoll.ts";
import type { DeviceScope, InstallSource, PublicPlugin } from "../../../shared/types.ts";
import { Button, INPUT, INPUT_STYLE, RefreshButton } from "./workspace/Chrome.tsx";

/** The one-line "From …" a reviewer reads — a local path plainly, a git
 *  source with its ref if one was pinned, a market install naming the list
 *  it came from. */
function formatSource(source: InstallSource): string {
  if (source.kind === "local-path") return source.path;
  if (source.kind === "git") return source.ref ? `${source.url}@${source.ref}` : source.url;
  return `${source.plugin.url}${source.plugin.ref ? `@${source.plugin.ref}` : ""} (via ${source.marketplace.url})`;
}

/**
 * What each scope actually permits, in the words a reviewer needs rather
 * than the field's name.
 *
 * `read` is the one that reads as harmless and is not: it is a GET on every
 * route this server has bar the terminal, which includes `/stream` — the
 * live event socket that carries a session's prompts and output as they
 * happen, the same feed server/src/index.ts calls "the whole fleet's
 * prompts, paths and errors as they stream". A plugin holding it is not
 * "read-only" the way a spreadsheet is; it is standing where you can see
 * yourself work. Say that here, once, so nobody approves it thinking it
 * only sees a list of pull requests.
 */
const SCOPE_WORD: Record<DeviceScope, string> = { read: "Read", answer: "Answer", full: "Full" };

/**
 * Adding one is an action on the list, so the form opens as a row of the
 * Installed card and nowhere else. Install accepts an absolute local path or a
 * git URL — installPlugin on the server tells them apart by `isAbsolute`, so
 * this asks for one field rather than a toggle nobody needs to set.
 */
function AddPluginCard({ onInstalled, open, setOpen, prefill }: {
  onInstalled: () => void; open: boolean; setOpen: (v: boolean) => void;
  /** Put there by a link from the plugin's page on the site — see
   *  lib/installPlugin.ts.
   *  It fills the box and nothing else: the press is still the person's. */
  prefill?: string;
}) {
  const [source, setSource] = useState("");
  useEffect(() => { if (prefill) setSource(prefill); }, [prefill]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const install = async () => {
    if (!source.trim() || busy) return;
    setBusy(true);
    setError(null);
    const r = await api.pluginInstall(source.trim());
    setBusy(false);
    if (r.ok) { setSource(""); setOpen(false); onInstalled(); }
    else setError(r.error);
  };

  if (!open) return null;

  return (
    <SettingRow
      label="Install a plugin"
      hint="A local folder's absolute path, or a git URL. Copies the folder and reads its manifest — nothing in it runs yet."
      below={
        <SettingsForm label="Install a plugin" onSubmit={() => void install()}>
          <Field label="Folder path or git URL" htmlFor="plugin-source" error={error}>
            <input id="plugin-source" value={source} onChange={(e) => setSource(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}
              placeholder="/path/to/plugin or https://…"
              disabled={busy}
              autoFocus
              className={`t-mono ${INPUT}`}
              style={INPUT_STYLE} />
          </Field>
          <div className="flex items-center gap-2">
            <Button type="submit" pending={busy} disabled={!source.trim()}>
              {busy ? "Installing…" : "Install"}
            </Button>
            <Button disabled={busy} onClick={() => { setOpen(false); setError(null); }}>Cancel</Button>
          </div>
        </SettingsForm>
      }
    />
  );
}

/** The commit a market install is pinned to, or null for anything else.
 *  Such an install updates only by installing the version the market lists;
 *  re-fetching its own source fetches the same commit again. */
export function pinnedByMarket(source: InstallSource): string | null {
  return source.kind === "marketplace" && source.plugin.ref && /^[0-9a-f]{40}$/.test(source.plugin.ref) ? source.plugin.ref : null;
}

/** The installed plugin that came from this git URL, if any. A trailing slash
 *  or a `.git` is the same repository to git and a different string here, so
 *  they are taken off both sides before comparing — a card that offers to
 *  install what is already installed is a card that lies. */
export function installedFrom(url: string, plugins: PublicPlugin[]): PublicPlugin | null {
  const same = (a: string, b: string) => tidy(a) === tidy(b);
  const tidy = (u: string) => u.trim().replace(/\.git$/i, "").replace(/\/+$/, "").toLowerCase();
  return plugins.find((p) => {
    if (p.source.kind === "git") return same(p.source.url, url);
    if (p.source.kind === "marketplace") return same(p.source.plugin.url, url);
    return false;
  }) ?? null;
}

export function PluginsPane({ open, focus }: {
  open: boolean;
  /** One plugin's settings, opened inside this page rather than as a page of
   *  its own in the nav. A hundred plugins are a hundred entries there, and a
   *  removed one lingered until Settings was closed — this page already knows
   *  what is installed and redraws when that changes. */
  focus?: string;
}) {
  const [master, setMasterState] = useState<boolean | null>(null);
  const [plugins, setPlugins] = useState<PublicPlugin[]>([]);
  const [busyMaster, setBusyMaster] = useState(false);
  const [masterError, setMasterError] = useState<string | null>(null);
  const [envAllowsUnboxed, setEnvAllowsUnboxed] = useState(false);

  const load = useCallback(() => {
    api.plugins().then((r) => { setMasterState(r.master); setPlugins(r.plugins); setEnvAllowsUnboxed(r.envAllowsUnboxed === true); }).catch(() => { /* left as last known */ });
  }, []);

  useEffect(() => { if (open) load(); }, [open, load]);
  // A plugin's own state (pid, running) changes on its own — a crash, a
  // restart — so this pane watches rather than only reacting to clicks.
  usePoll(open, load, 3000);

  const toggleMaster = async () => {
    if (master === null || busyMaster) return;
    setBusyMaster(true);
    setMasterError(null);
    const r = await api.pluginMaster(!master);
    setBusyMaster(false);
    if (r.ok) setMasterState(r.master ?? !master);
    else setMasterError(r.error ?? "the master switch was not changed");
    load();
  };

  /* The board narrows by name, publisher and description at once, because
     "the one that watches the cockpit" is as likely a thing to remember as
     its name, and this list is not always short. */
  const [q, setQ] = useState("");
  const [installing, setInstalling] = useState(false);
  /** Which plugin's own settings are open on top of this page. Kept here, so
   *  removing that plugin takes its page with it. */
  const [showing, setShowing] = useState<string | null>(focus ?? null);
  useEffect(() => { setShowing(focus ?? null); }, [focus]);
  /* "Install this plugin", from the web page. The box opens with the URL in
     it and waits: a link may ask, the person answers. */
  const askedFor = useSyncExternalStore(subscribePluginInstall, pluginInstallRequest, () => null);
  const [prefill, setPrefill] = useState("");
  /** What a link from the web asked for, once the list has loaded: either
   *  "here it is, you already have it" or the install box with the URL in it.
   *  The page cannot know which — it cannot reach this app — so the answer is
   *  given here, where it is known. */
  const [already, setAlready] = useState<string | null>(null);
  useEffect(() => {
    if (!askedFor) return;
    const have = installedFrom(askedFor.url, plugins);
    clearPluginInstall();
    if (have) {
      setAlready(have.name);
      setInstalling(false);
      setQ(have.name);
      return;
    }
    setAlready(null);
    setPrefill(askedFor.url);
    setInstalling(true);
  }, [askedFor, plugins]);
  const ql = q.trim().toLowerCase();
  const shown = ql
    ? plugins.filter((p) => `${p.name} ${p.publisher} ${p.description}`.toLowerCase().includes(ql))
    : plugins;

  /* A plugin removed while its own page is open takes the page with it, which
     is the bug that started this: a page for something that is gone used to
     sit in the nav until Settings was closed and opened again. */
  const here = showing ? plugins.find((p) => p.name === showing) : undefined;
  useEffect(() => {
    if (showing && plugins.length && !plugins.some((p) => p.name === showing)) setShowing(null);
  }, [plugins, showing]);

  if (showing && here) {
    return (
      <div className="pb-5">
        <Button size="compact" className="mb-3" onClick={() => setShowing(null)}>
          <BackIcon size={ICON.sm} /> All plugins
        </Button>
        <div className="flex items-center gap-2.5 mb-3">
          <PluginMark name={here.name} icon={here.icon} color={here.color} size={ICON.lg} stamp={here.contentHash} />
          <div className="min-w-0">
            <div className="text-[14px]" style={{ color: "var(--text)" }}>{here.name}</div>
            <div className="text-[11.5px] t-dim">by {here.publisher}</div>
          </div>
        </div>
        <PluginSettingsPane key={here.name} name={here.name} open={open} />
      </div>
    );
  }

  return (
    <div className="pb-5">
      {/* The one thing on this page that IS a setting keeps the settings
          idiom — a titled card with a row and a switch. Everything about one
          plugin is a row of the Installed card below, and the market is a card
          of its own: one idiom for the whole page, where there used to be a
          board of bordered tiles between two cards. */}
      <SettingsCard title="Plugin system" desc="Nothing runs until you have read what it declares and switched it on.">
        <SettingRow
          onClick={busyMaster ? undefined : toggleMaster}
          role="switch"
          ariaChecked={!!master}
          label={master ? "Plugins are switched on" : "Plugins are switched off"}
          hint={master
            ? "Enabled plugins may run. Turning this off stops every one of them immediately."
            : "Nothing installed runs, no matter what it is enabled to do. Install and review still work."}
          control={<Switch on={!!master} busy={busyMaster || master === null} />}
        />
        {masterError && <SettingRow label="The master switch was not changed" status={<StatusBadge tone="err">Failed</StatusBadge>} hint={masterError} />}
        {envHatchNotice(envAllowsUnboxed) && (
          <SettingRow label="Unboxed plugins are allowed here" status={<StatusBadge tone="warn">Environment override</StatusBadge>}
            hint={envHatchNotice(envAllowsUnboxed)} />
        )}
      </SettingsCard>

      {/* One card for everything installed, a row per plugin. It used to be a
          grid of bordered tiles: a box holding boxes, and the tiles' own
          dividers, chips and buttons drawn a third way. */}
      <SettingsCard title="Installed"
        status={<StatusBadge tone="off">{plugins.length} installed</StatusBadge>}
        actions={<>
          {/* The house refresh, the same icon control as the Market's just
              below: a text "Refresh" here and an icon there was one pane with
              two idioms for the same verb. */}
          <RefreshButton onRefresh={() => void load()} title="Refresh the installed plugins" />
          <Button tone="primary" disabled={installing} onClick={() => setInstalling(true)}>Install a plugin</Button>
        </>}>
        {/* The list narrows by name, publisher and description at once, because
            "the one that watches the cockpit" is as likely a thing to remember
            as its name, and this list is not always short. */}
        {plugins.length > 0 && (
          <SettingRow label="Search installed plugins"
            below={<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search plugins"
              aria-label="Search installed plugins" className={`max-w-[360px] ${INPUT}`} style={INPUT_STYLE} />} />
        )}
        {already && (
          <SettingRow label={`${already} is already installed`} status={<StatusBadge tone="ok">Installed</StatusBadge>}
            hint="The link you followed asked for this one. It is in the list below; Update re-clones it at the source it came from." />
        )}
        <AddPluginCard onInstalled={load} open={installing} setOpen={setInstalling} prefill={prefill} />
        {plugins.length === 0 ? (
          <EmptyState>Nothing installed yet. Install one from a folder or a git URL, or take one from the market below.</EmptyState>
        ) : (
          shown.map((p) => (
            <PluginCard key={p.name} plugin={p} masterOn={!!master} envAllowsUnboxed={envAllowsUnboxed} onChanged={load} onSettings={() => setShowing(p.name)} />
          ))
        )}
        {plugins.length > 0 && shown.length === 0 && (
          <SettingRow label={`Nothing installed matches “${q.trim()}”`} />
        )}
      </SettingsCard>

      <Market installed={(url) => installedFrom(url, plugins)?.source ?? null} onInstalled={load} />
    </div>
  );
}

function PluginCard({ plugin, masterOn, envAllowsUnboxed, onChanged, onSettings }: {
  plugin: PublicPlugin; masterOn: boolean; envAllowsUnboxed: boolean; onChanged: () => void;
  /** Opens this plugin's own settings inside the Plugins page. */
  onSettings: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateNote, setUpdateNote] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [dropSettings, setDropSettings] = useState(false);

  // The one fact the whole trust model rests on: is what is on disk right
  // now the thing a human last looked at, or has it started asking for
  // something else since. `hadApproval` is what tells "never reviewed" (a
  // fresh install) apart from "reviewed once, then changed" — see
  // server/src/plugins.ts, PluginRecord.hadApproval.
  // fingerprint, not manifestHash — enablePlugin gates on the fingerprint,
  // which also catches an update that rewrites the entrypoint's code
  // without touching the manifest at all. See consentFingerprint.
  const needsReview = plugin.approvedFingerprint !== plugin.fingerprint;
  const reconsent = needsReview && plugin.hadApproval;
  // fingerprint (above) folds in every byte on disk, on purpose — see
  // consentFingerprint in server/src/plugins.ts. That means an update that
  // only touches a README or fixes a typo in the code re-asks too, with
  // nothing different in the declaration below to review. manifestHash is
  // the coarser, capability-only half of the same record: comparing it to
  // approvedHash is the one way to tell "the declaration itself changed"
  // from "the code changed but what it asks for is what you already saw".
  const manifestChanged = plugin.approvedHash !== null && plugin.approvedHash !== plugin.manifestHash;
  // A switch reading "on" while nothing runs is the exact failure this page
  // exists to catch, so the toggle reflects the PROCESS, not the intent —
  // `enabled` can be true with `running` false for one tick after a crash.
  const running = plugin.running;
  // Only a git-backed source has an upstream — see server/src/plugins.ts,
  // updatePlugin. A market install pinned to a commit asks the catalogue what
  // it lists now, so Update is honest for it too: it installs the newer entry
  // or says the listing has not moved.
  const pinned = pinnedByMarket(plugin.source);
  const updatable = plugin.source.kind !== "local-path";

  const { ask, dialog } = useDialogs();
  const setEnabled = async (next: boolean) => {
    // Switching it on IS the approval (enablePlugin records it), so the
    // switch cannot be locked until something is approved — it was, and a
    // plugin nobody had approved could never be turned on. It asks once,
    // with what is being approved in front of it.
    if (next && needsReview) {
      const ok = await ask({
        title: `Switch on ${plugin.name}?`,
        node: <PluginDeclaration plugin={plugin} />,
        confirmLabel: "Approve and switch on",
      });
      if (!ok) return;
    }
    setBusy(true);
    setUpdateError(null);
    const r = next ? await api.pluginEnable(plugin.name) : await api.pluginDisable(plugin.name);
    setBusy(false);
    if (!r.ok) setUpdateError(r.error ?? "the change was not made");
    onChanged();
  };

  const update = async () => {
    setUpdating(true);
    setUpdateError(null);
    setUpdateNote(null);
    const r = await api.pluginUpdate(plugin.name);
    setUpdating(false);
    if (r.ok) { setUpdateNote(r.update.message); onChanged(); }
    else setUpdateError(r.error);
  };

  const remove = async () => {
    setBusy(true);
    await api.pluginRemove(plugin.name, dropSettings);
    setBusy(false);
    setConfirmRemove(false);
    setDropSettings(false);
    onChanged();
  };

  const tint = plugin.color ?? "var(--primary)";
  const hasPanel = (plugin.contributes?.panels?.length ?? 0) > 0;
  const hasSettings = (plugin.contributes?.settings?.length ?? 0) > 0;
  return (
    <>
    {/* Outside the row: a dialog drawn inside it would sit in the row's grid. */}
    {dialog}
    <SettingRow
      /* Name, then who made it, stacked: a list is scanned down its left edge,
         and what gets scanned is a shape, then a name, then who wrote it. */
      label={<span className="flex items-center gap-2.5">
        <PluginMark name={plugin.name} icon={plugin.icon} color={plugin.color} stamp={plugin.contentHash} />
        <span className="min-w-0">
          <span className="block">{plugin.name}</span>
          <span className="block text-[11.5px] t-dim">by {plugin.publisher}</span>
        </span>
      </span>}
      hint={<>
        <span className="block">{plugin.description}</span>
        <span className="block mt-1">installed {fmtAgo(plugin.installedAt)}</span>
      </>}
      status={<StatePill enabled={plugin.enabled} running={running} reconsent={reconsent} needsReview={needsReview} pid={plugin.pid} />}
      control={
        <button onClick={() => setEnabled(!plugin.enabled)}
          disabled={busy || (!plugin.enabled && !masterOn)}
          role="switch" aria-checked={plugin.enabled} aria-label={`${plugin.name} on or off`}
          title={!plugin.enabled && needsReview ? "Switching it on approves what it declares below" : !plugin.enabled && !masterOn ? "Plugins are switched off" : undefined}
          className="disabled:cursor-not-allowed">
          <Switch on={plugin.enabled} busy={busy} />
        </button>
      }
      below={<div className="flex flex-col gap-2.5 min-w-0">
        {/* Chips, because a plugin is read by its badges before its prose —
            the scope is the one fact worth knowing before installing anything,
            and buried mid-sentence it was not being read. */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="chip text-[10px]" style={{
            color: "var(--text2)",
            background: "color-mix(in srgb, var(--border) 20%, transparent)",
            borderColor: "color-mix(in srgb, var(--border) 45%, transparent)",
          }}>
            {SCOPE_WORD[plugin.scope]}
          </span>
          {/* Where it shows up, before any prose: a panel, a settings page, notes
              in pull requests. The same facts the review below spells out. */}
          {(plugin.contributes?.panels ?? []).map((p) => (
            <DrawChip key={p.id} tint={tint} label={`panel · ${p.title}`} />
          ))}
          {hasSettings && <DrawChip tint={tint} label="settings" />}
          {plugin.contributes?.prNotes && <DrawChip tint={tint} label="notes in PRs" />}
        </div>
        <div className="text-[11.5px] t-dim break-all">
          From <span className="t-mono">{formatSource(plugin.source)}</span>
        </div>
        {pinned && (
          <div className="text-[11.5px] t-dim">
            Pinned to <span className="t-mono" title={pinned}>{pinned.slice(0, 7)}</span> by the market. Update reads the market
            again and installs the version it lists now; the market tab offers the same when the listing moves on.
          </div>
        )}

        {/* Switched on, nothing running, and the host kept how it ended. */}
        {plugin.enabled && !running && <PluginWhyStopped plugin={plugin} />}

        {/* The re-consent case, drawn so it cannot be mistaken for an ordinary
            disabled plugin: its own colour and its own sentence, above the
            disclosure that holds what it declares. */}
        {reconsent && manifestChanged && (
          <Note tone="warn">
            <strong>This plugin is asking for something different now.</strong> What is installed no
            longer matches what you last approved — the manifest changed since then. It was turned off
            automatically and stays off until you review the current declaration below and enable it again.
          </Note>
        )}
        {reconsent && !manifestChanged && (
          <Note tone="warn">
            <strong>This plugin's code changed since you approved it.</strong> What it declares below is
            the same as what you approved — same scope, same drawing, same sandbox — but an update can
            rewrite what the code actually does without touching the manifest at all, so it was turned off
            automatically anyway. Review it below and enable it again.
          </Note>
        )}
        {!plugin.hadApproval && needsReview && (
          <div className="text-[12px]" style={{ color: "var(--text2)" }}>
            Not reviewed yet. Read what it declares before enabling it.
          </div>
        )}

        {/* Open by default only while there is a decision to make — a fresh
            install or a changed manifest. The sentence has to be legible at the
            moment somebody is approving it; once approved, showing it every
            visit is the noise a four-line paragraph on every plugin would be.
            Where it draws is part of what is being approved: a plugin that
            starts drawing somewhere new has a new manifest hash, and is asked
            about again. Drawn by this app, never run in it. */}
        <Disclosure summary="What it can do" wide>
          <PluginDeclaration plugin={plugin} flat />
        </Disclosure>

        {/* Only for a plugin the server refuses to start for lack of a box, or
            one running on this plugin's own consent — see unboxedControl. */}
        <UnboxedConsent plugin={plugin} envAllowsAll={envAllowsUnboxed} onChanged={onChanged} />

        {updateError && <Note tone="err">{updateError}</Note>}
        {updateNote && !updateError && <Note tone="warn">{updateNote}</Note>}

        {/* Kept by default: what was typed into the settings page belongs to
            the person, and a reinstall picks it back up. */}
        {confirmRemove && hasSettings && (
          <label className="flex items-center gap-2 text-[11.5px] cursor-pointer select-none" style={{ color: "var(--text2)" }}>
            <input type="checkbox" checked={dropSettings} onChange={(e) => setDropSettings(e.target.checked)} disabled={busy} />
            <span>Also remove its settings <span className="t-dim">— otherwise they are kept on this machine for a reinstall</span></span>
          </label>
        )}
        <div className="flex items-center gap-2 flex-wrap">
          {confirmRemove ? (
            <>
              <Button tone="danger" pending={busy} onClick={remove}>{busy ? "Removing…" : "Remove"}</Button>
              <Button disabled={busy} onClick={() => { setConfirmRemove(false); setDropSettings(false); }}>Keep it</Button>
            </>
          ) : (
            <>
              {/* Straight to where it shows up — the answer to "I switched it on,
                  now what". */}
              {hasPanel && plugin.enabled && (
                <Button tint={tint} onClick={() => { emitControl({ cmd: "view", to: "plugins" }); emitControl({ cmd: "esc" }); closeSettings(); }}>Open</Button>
              )}
              {hasSettings && (
                <Button onClick={onSettings}>Settings</Button>
              )}
              {/* A re-fetch that changes the declaration lands on the same
                  re-consent path as a fresh install — see updatePlugin on the
                  server — so this never claims to have "updated" anything
                  itself, only to have gone and looked. */}
              {updatable && (
                <Button pending={updating} disabled={busy} onClick={update}
                  title="Re-fetch this plugin at its recorded source. A changed declaration will need review again before it can run.">
                  {updating ? "Updating…" : "Update"}
                </Button>
              )}
              <Button tone="danger" disabled={busy} onClick={() => setConfirmRemove(true)}>Remove</Button>
            </>
          )}
        </div>
      </div>}
    />
    </>
  );
}

/** A sentence about this plugin that the person has to act on, in the ink of
 *  its tone and with no box around it: the row it sits in is the frame. */
function Note({ tone, children }: { tone: "warn" | "err"; children: React.ReactNode }) {
  return (
    <p className="m-0 text-[12px] leading-relaxed" style={{ color: tone === "err" ? "var(--error-ink)" : "var(--text2)" }}>
      {children}
    </p>
  );
}

/** Running, off, or waiting on you — a word, not only a dot, because the dot
 *  alone had to be learned and it is the first thing asked of a row. */
function StatePill({ enabled, running, reconsent, needsReview, pid }: { enabled: boolean; running: boolean; reconsent: boolean; needsReview: boolean; pid: number | null }) {
  const [label, tone]: [string, StatusTone] = reconsent ? ["Asks again", "warn"]
    : needsReview && !enabled ? ["Not approved", "warn"]
    : enabled && running ? ["Running", "ok"]
    // Switched on and nothing running: the failure a plugin screen exists to
    // show, and the one an `enabled` flag alone cannot.
    : enabled ? ["Enabled, not running", "warn"]
    : ["Off", "off"];
  return (
    <span title={running && pid ? `pid ${pid}` : undefined}>
      <StatusBadge tone={tone}>{label}</StatusBadge>
    </span>
  );
}

function DrawChip({ tint, label }: { tint: string; label: string }) {
  return (
    <span className="chip text-[10px]" style={{
      color: `color-mix(in srgb, ${tint} 75%, var(--text))`,
      background: `color-mix(in srgb, ${tint} 10%, transparent)`,
      borderColor: `color-mix(in srgb, ${tint} 35%, transparent)`,
    }}>{label}</span>
  );
}
