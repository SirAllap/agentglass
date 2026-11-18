// The screen for docs/PLUGINS.md's six routes.
//
// The mechanism renders nothing of its own — see the note at the top of
// server/src/plugins.ts. This page is OUR screen, showing OUR data about
// what somebody installed: install copies a folder and runs nothing,
// enabling is the one moment a human grants a scope, and disabling stops
// the process that scope was minted for. Reviewing that from a terminal is
// not review, which is the whole reason this file exists.
import { PluginMark } from "./plugins/PluginMark.tsx";
import { PluginPreview } from "./plugins/PluginPreview.tsx";
import { BackIcon } from "./browser/icons.tsx";
import { emitControl } from "../lib/controlBus.ts";
import { closeSettings } from "../lib/openSettings.ts";
import { clearPluginInstall, pluginInstallRequest, subscribePluginInstall } from "../lib/installPlugin.ts";
import { PluginSettingsPane } from "./plugins/PluginSettingsPane.tsx";
import { Market, offerFor } from "./plugins/Market.tsx";
import { PluginDeclaration } from "./plugins/PluginDeclaration.tsx";
import { UnboxedConsent } from "./plugins/UnboxedConsent.tsx";
import { envHatchNotice } from "../lib/pluginBoxState.ts";
import { PluginWhyStopped } from "./plugins/PluginWhyStopped.tsx";
import { PluginModal } from "./plugins/PluginModal.tsx";
import { groupInstalled, pluginHeadChips, pluginState, pluginTallyStore, systemHeadline, tallyInstalled, type PluginTally } from "../lib/pluginList.ts";
import { cardBand, pageSummary, permissionChips, primaryAction, versionChip, type CardBand } from "../lib/pluginCard.ts";
import { useReportHead } from "./SettingsPageState.tsx";
import { BlockedIcon, PlusIcon, SearchIcon, WarningIcon } from "../lib/glyphIcons.tsx";
import { rowId } from "../lib/settingsIndex.ts";
import { UpIcon } from "./browser/icons.tsx";
import { PuzzleIcon, ShieldIcon } from "./settingsNavIcons.tsx";
import { ICON } from "../lib/iconSize.ts";
import { useDialogs } from "./ConfirmDialog.tsx";
import { useCallback, useEffect, useRef, useState, useMemo, useSyncExternalStore } from "react";
import { Switch } from "./SettingRow.tsx";
import { StatusBadge, type StatusTone } from "./SettingsKit.tsx";
import { FormInput } from "./settings/shell/FormInput.tsx";
import { Section } from "./settings/shell/Section.tsx";
import { api } from "../lib/api.ts";
import { fmtAgo } from "../lib/format.ts";
import { usePoll } from "../lib/usePoll.ts";
import type { Catalogue, DeviceScope, InstallSource, PublicPlugin } from "../../../shared/types.ts";
import { Badge, Button, EDGE, INPUT, INPUT_STYLE, LINE, RefreshButton } from "./workspace/Chrome.tsx";

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
    <>
      {/* The mockup's inset form under the install row: one wide field, its hint, Install and Cancel. */}
      <div className="agx-plug-form" data-row={rowId("Folder path or git URL")}>
        <FormInput id="plugin-source" aria-label="Folder path or git URL" value={source} onChange={(e) => setSource(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void install(); } if (e.key === "Escape") setOpen(false); }}
          placeholder="/path/to/plugin or https://…" disabled={busy} autoFocus className={`t-mono ${INPUT}`} style={{ ...INPUT_STYLE, width: "100%" }} />
        <span className="agx-plug-hint">A local folder's absolute path, or a git URL. Nothing in it runs yet.</span>
        {error && <div role="alert" className="text-[12px]" style={{ color: "var(--error-ink)" }}>{error}</div>}
        <div className="flex items-center gap-2">
          <Button tone="primary" pending={busy} className="agx-plug-w" disabled={!source.trim()} onClick={() => void install()}>{busy ? "Installing…" : "Install"}</Button>
          <Button className="agx-plug-w" disabled={busy} onClick={() => { setOpen(false); setError(null); }}>Cancel</Button>
        </div>
      </div>
    </>
  );
}

/** The commit a market install is pinned to, or null for anything else.
 *  Such an install updates only by installing the version the market lists;
 *  re-fetching its own source fetches the same commit again. */
export function pinnedByMarket(source: InstallSource): string | null {
  return source.kind === "marketplace" && source.plugin.ref && /^[0-9a-f]{40}$/.test(source.plugin.ref) ? source.plugin.ref : null;
}

/** A trailing slash or a `.git` is the same repository to git and a different
 *  string here, so they are taken off both sides before comparing. */
function sameRepo(a: string, b: string): boolean {
  const tidy = (u: string) => u.trim().replace(/\.git$/i, "").replace(/\/+$/, "").toLowerCase();
  return tidy(a) === tidy(b);
}

/** The installed plugin that came from this git URL, if any — a card that
 *  offers to install what is already installed is a card that lies. */
export function installedFrom(url: string, plugins: PublicPlugin[]): PublicPlugin | null {
  return plugins.find((p) => {
    if (p.source.kind === "git") return sameRepo(p.source.url, url);
    if (p.source.kind === "marketplace") return sameRepo(p.source.plugin.url, url);
    return false;
  }) ?? null;
}

/** The market entry for the repository a market install came from, or null. */
export function marketEntry(plugin: PublicPlugin, catalogue: Catalogue | null): Catalogue["plugins"][number] | null {
  if (!catalogue || plugin.source.kind !== "marketplace") return null;
  const have = plugin.source.plugin.url;
  return catalogue.plugins.find((e) => sameRepo(e.source.url, have)) ?? null;
}

/** The market entry that would replace what a market install has on disk, or null. */
export function marketUpdate(plugin: PublicPlugin, catalogue: Catalogue | null): Catalogue["plugins"][number] | null {
  const entry = marketEntry(plugin, catalogue);
  return entry && offerFor(entry, plugin.source) === "update" ? entry : null;
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
  /** What the Market below read, so a card can say the listing has moved on. */
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);

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
  /* One tally for the whole page: the header chips, the status card, the
     Installed line and the nav mark all read it, so they cannot disagree. */
  const hasUpdate = (p: PublicPlugin) => marketUpdate(p, catalogue) !== null;
  const tally = tallyInstalled(plugins, hasUpdate);
  useReportHead("plugins", master === null ? null : { chips: pluginHeadChips(tally) });
  /* The nav mark reads the store, not a page report: a report is withdrawn when
     the page closes, and the mark then fell back to an approval-only count. */
  useEffect(() => { if (master !== null) pluginTallyStore.set(tally); });
  /* Nothing installed: the install box is open on the first read, so the
     empty page starts at its one next step. Once, so Cancel stays cancelled. */
  const firstRead = useRef(true);
  useEffect(() => {
    if (master === null || !firstRead.current) return;
    firstRead.current = false;
    if (plugins.length === 0) setInstalling(true);
  }, [master, plugins.length]);
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
      <Section id="plugin-system" title="Plugin system" intro="The one switch that decides whether any plugin may run.">
        {/* The switch sits in the card's head, beside the headline it changes: one card, not a status card and a row under it. */}
        <SystemStatus tally={tally} known={master !== null}
          help={master ? "Enabled plugins may run. Turning this off stops every one of them immediately." : "Nothing installed runs. Install and review still work."}
          control={<Toggle settingId="plugins.master" label="Plugins may run" on={!!master} busy={busyMaster || master === null} onToggle={() => void toggleMaster()} />}>
          {masterError && <div className="agx-plug-note-row" data-tone="err" role="alert"><WarningIcon size={ICON.xs} /><span><b>The master switch was not changed.</b> {masterError}</span></div>}
          {envHatchNotice(envAllowsUnboxed) && (
            <div className="agx-plug-note-row" data-tone="warn"><ShieldIcon size={ICON.xs} /><span><b>Unboxed plugins are allowed here · environment override.</b> {envHatchNotice(envAllowsUnboxed)}</span></div>
          )}
        </SystemStatus>
      </Section>

      <Section id="plugins-installed" title="Installed" count={master === null ? undefined : String(tally.total)}
        intro={plugins.length ? pageSummary(tally.total, tally.update, tally.needsYou) : "Nothing here runs until you switch it on."}>
        {/* At every count: the search index points here, and Refresh lives in this row. Drawn as the mockup's tool row: one wide field, Refresh beside it. */}
        <SearchRow agentExempt label="Find a plugin" help="Search by name, publisher or description" value={q} onChange={setQ} onRefresh={() => void load()} />
        {already && (
          <div className="px-3 py-2 text-[12px]" style={{ color: "var(--text2)" }}>
            <strong>{already} is already installed.</strong> The link you followed asked for this one. Update re-clones it at the source it came from.
          </div>
        )}
        {plugins.length === 0 && (
          <div className="agx-plug-empty">
            <span className="agx-plug-empty-pic" aria-hidden><PuzzleIcon size={ICON.rail} /></span>
            <div className="min-w-0">
              <b>No plugins yet</b>
              <p>A plugin adds a panel, a settings page, notes on pull requests or badges in the Inbox. Installing copies its files and runs nothing.</p>
              <ol className="agx-plug-steps"><li>Install</li><li>Read what it declares</li><li>Switch it on</li></ol>
            </div>
          </div>
        )}
        {groupInstalled(shown, hasUpdate).map((g) => (
          <div key={g.id} data-plugin-group={g.id}>
            {plugins.length > 1 && <div className="agx-plug-group"><span>{g.label}</span><span className="tabular-nums">{g.items.length}</span></div>}
            {g.items.map((p) => (
              <PluginRows key={p.name} plugin={p} masterOn={!!master} envAllowsUnboxed={envAllowsUnboxed} onChanged={load}
                update={marketUpdate(p, catalogue)} preview={marketEntry(p, catalogue)?.preview} onSettings={() => setShowing(p.name)} />
            ))}
          </div>
        ))}
        {plugins.length > 0 && shown.length === 0 && <div className="px-3 py-2 text-[12px]" style={{ color: "var(--text2)" }}>Nothing installed matches "{q.trim()}".</div>}
        {/* The install row stays while the form is open under it, as in the mockup; only its button goes. */}
        <div className="agx-plug-add" data-row={rowId(plugins.length && !installing ? "Install another plugin" : "Install a plugin")}>
          <span className="agx-plug-plus" aria-hidden><PlusIcon size={ICON.xs} /></span>
          <div className="min-w-0">
            <div className="agx-plug-add-t">{plugins.length && !installing ? "Install another plugin" : "Install a plugin"}</div>
            <div className="agx-plug-add-s">From the market below, a folder, or a git address.</div>
          </div>
          {!installing ? <Button className="agx-plug-w" onClick={() => setInstalling(true)}>Install…</Button> : <span />}
        </div>
        {installing && <AddPluginCard onInstalled={load} open={installing} setOpen={setInstalling} prefill={prefill} />}
      </Section>

      <Market installed={(url) => installedFrom(url, plugins)} onInstalled={load} onLoaded={setCatalogue} onSettings={setShowing} />
    </div>
  );
}

function PluginRows({ plugin, masterOn, envAllowsUnboxed, onChanged, onSettings, update: listed, preview }: {
  plugin: PublicPlugin; masterOn: boolean; envAllowsUnboxed: boolean; onChanged: () => void;
  /** The picture its market listing carries; a plugin not from the market has none. */
  preview?: string;
  /** The market entry that would replace what is installed, if the listing has moved on. */
  update: Catalogue["plugins"][number] | null;
  /** Opens this plugin's own settings inside the Plugins page. */
  onSettings: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateNote, setUpdateNote] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [dropSettings, setDropSettings] = useState(false);
  const [viewing, setViewing] = useState(false);

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
      // The approval dialog is its own layer; it cannot open under this one.
      setViewing(false);
      const ok = await ask({
        title: `Switch on ${plugin.name}?`,
        node: <PluginDeclaration plugin={plugin} />,
        confirmLabel: "Approve and switch on",
        wide: { subtitle: [`by ${plugin.publisher}`, plugin.resolvedCommit?.slice(0, 7), SOURCE_WORD[plugin.source.kind]].filter(Boolean).join(" · ") },
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
  const band = cardBand(plugin, listed !== null);
  const lead = primaryAction(band, { enabled: plugin.enabled && running, hasPanel, hasSettings });
  const openIt = () => { emitControl({ cmd: "view", to: "plugins" }); emitControl({ cmd: "esc" }); closeSettings(); };
  const open = hasPanel && plugin.enabled && running;
  return (
    <div data-plugin={plugin.name}>
      {/* Outside the rows: a dialog drawn inside them would sit in the section's column. */}
      {dialog}
      {/* Mark, name, then one fixed column each for the state, the switch and View more: no button moves between rows. */}
      <div className="agx-plug-row" data-off={plugin.enabled ? undefined : "true"}>
        <PluginMark name={plugin.name} icon={plugin.icon} color={plugin.color} size={40} stamp={plugin.contentHash} />
        <div className="min-w-0">
          <div className="agx-plug-top">
            <span className="agx-plug-name">{plugin.name}</span>
            <span className="agx-plug-ver t-mono">{versionChip(plugin)}</span>
            <span className="agx-plug-by">by {plugin.publisher}</span>
          </div>
          {plugin.description && <div className="agx-plug-desc">{plugin.description}</div>}
        </div>
        <div className="min-w-0">
          <StatePill enabled={plugin.enabled} running={running} pid={plugin.pid} hadApproval={plugin.hadApproval} fingerprint={plugin.fingerprint} approvedFingerprint={plugin.approvedFingerprint} />
        </div>
        <button type="button" onClick={() => setEnabled(!plugin.enabled)}
          disabled={busy || (!plugin.enabled && !masterOn)}
          role="switch" aria-checked={plugin.enabled} aria-label={`${plugin.name} on or off`}
          data-tip={!plugin.enabled && !masterOn ? "Plugins are switched off" : !plugin.enabled && needsReview ? "Switching it on approves what it declares" : undefined}
          className="disabled:cursor-not-allowed inline-flex items-center shrink-0">
          <Switch on={plugin.enabled} busy={busy} />
        </button>
        <Button className="agx-plug-more" onClick={() => setViewing(true)} aria-label={`View more about ${plugin.name}`}>View more</Button>
      </div>
      {/* On the list, not in the modal: why it stopped or asks again, and the fix, must show without View more. */}
      {band && (
        <div className="agx-plug-bandrow">
          <Band band={band} action={
            band === "approval" ? <Button tone="primary" disabled={busy} onClick={() => (masterOn ? void setEnabled(true) : setViewing(true))}>Review and switch on…</Button>
            : band === "stopped" ? <Button onClick={() => setViewing(true)}>View more</Button>
            : <Button tone="primary" pending={updating} disabled={busy} onClick={update}>{updating ? "Updating…" : "Update"}</Button>
          }>
            {band === "approval" && (<>
              <strong>Needs your approval</strong>
              {reconsent && manifestChanged && (
                <span>This plugin is asking for something different now: the manifest changed since you approved it. It was turned off and stays off until you review what it declares.</span>
              )}
              {reconsent && !manifestChanged && (
                <span>This plugin's code changed since you approved it. What it declares is the same, but an update can change what the code does, so it was turned off until you review it.</span>
              )}
              {!plugin.hadApproval && <span>Not reviewed yet. Read what it declares before you switch it on.</span>}
            </>)}
            {band === "stopped" && (<><strong>Stopped</strong><span>Switched on, and nothing runs.</span><PluginWhyStopped plugin={plugin} /></>)}
            {band === "update" && listed && (<>
              <strong>Update available</strong>
              <span>
                The market lists <span className="t-mono">{(listed.source.ref ?? "").slice(0, 7)}</span>; this is{" "}
                <span className="t-mono">{(pinned ?? plugin.resolvedCommit ?? "").slice(0, 7) || "unpinned"}</span>.
                A changed declaration asks again before it runs.
              </span>
            </>)}
          </Band>
        </div>
      )}
      {/* An update started from the band answers on the list; the modal says it again when open. */}
      {!viewing && (updateError || updateNote) && (
        <div className="agx-plug-bandrow"><div className="agx-plug-note">{updateError ? <Note tone="err">{updateError}</Note> : <Note tone="warn">{updateNote}</Note>}</div></div>
      )}
      {viewing && (
        <PluginModal title={plugin.name} subtitle={[`by ${plugin.publisher}`, versionChip(plugin), SOURCE_WORD[plugin.source.kind], `installed ${fmtAgo(plugin.installedAt)}`].join(" · ")}
          onClose={() => setViewing(false)}
          picture={<PluginPreview src={preview} name={plugin.name} tint={tint}><PluginMark name={plugin.name} icon={plugin.icon} color={plugin.color} size={ICON.lg * 2} stamp={plugin.contentHash} /></PluginPreview>}>
      <div className="px-3 pt-2 pb-1 text-[12px]" style={{ color: "var(--text2)" }}>{plugin.description}</div>
      <div className="px-3 pb-1 text-[11px] t-mono break-all" style={{ color: "var(--text2)" }}>{formatSource(plugin.source)}</div>
      <div className="px-3 pb-2.5 flex items-center gap-1.5 flex-wrap">
        <span className="chip text-[10px]" style={{ color: "var(--text2)", background: "color-mix(in srgb, var(--border) 20%, transparent)", borderColor: "color-mix(in srgb, var(--border) 45%, transparent)" }}>{SCOPE_WORD[plugin.scope]}</span>
        {(plugin.contributes?.panels ?? []).map((p) => <DrawChip key={p.id} tint={tint} label={`panel · ${p.title}`} />)}
        {hasSettings && <DrawChip tint={tint} label="settings" />}
        {plugin.contributes?.prNotes && <DrawChip tint={tint} label="notes in PRs" />}
      </div>
      {pinned && (
        <div className="px-3 pb-2 text-[12px]" style={{ color: "var(--text2)" }}>
          Pinned to <span className="t-mono" title={pinned}>{pinned.slice(0, 7)}</span> by the market. Update reads the market again and installs the version it lists now.
        </div>
      )}
      <details className="agx-perm px-3 pb-2.5">
        <summary className="flex items-center gap-2 cursor-pointer select-none list-none" style={{ minHeight: 28 }}>
          <span aria-hidden className="agx-perm-caret t-dim">▸</span>
          <span className="text-[12px] font-medium" style={{ color: "var(--text)" }}>Permissions</span>
          <span className="flex flex-wrap items-center gap-1.5 min-w-0">
            {permissionChips(plugin).map((c) => (
              <span key={c} className="text-[11px] px-1.5 rounded-md inline-flex items-center whitespace-nowrap" style={{ height: 20, color: "var(--text2)", border: EDGE }}>{c}</span>
            ))}
          </span>
        </summary>
        <div className="pt-2"><PluginDeclaration plugin={plugin} flat /></div>
      </details>
      {/* Only for a plugin the server refuses to start for lack of a box, or one running on this plugin's own consent. */}
      <div className="px-3"><UnboxedConsent plugin={plugin} envAllowsAll={envAllowsUnboxed} onChanged={onChanged} /></div>
      {updateError && <div className="px-3 pb-2"><Note tone="err">{updateError}</Note></div>}
      {updateNote && !updateError && <div className="px-3 pb-2"><Note tone="warn">{updateNote}</Note></div>}
      {confirmRemove && hasSettings && (
        <label className="px-3 pb-2 flex items-center gap-2 text-[12px] cursor-pointer select-none" style={{ color: "var(--text2)" }}>
          <FormInput type="checkbox" checked={dropSettings} onChange={(e) => setDropSettings(e.target.checked)} disabled={busy} />
          <span>Also remove its settings. Otherwise they are kept on this machine for a reinstall.</span>
        </label>
      )}
      <div className="px-3 pb-3 flex items-center gap-2 flex-wrap">
        {confirmRemove ? (
          <>
            <Button tone="danger" pending={busy} onClick={remove}>{busy ? "Removing…" : "Remove"}</Button>
            <Button disabled={busy} onClick={() => { setConfirmRemove(false); setDropSettings(false); }}>Keep it</Button>
          </>
        ) : (
          <>
            {lead === "review" && <Button tone="primary" disabled={busy || !masterOn} onClick={() => void setEnabled(true)}>Review and switch on…</Button>}
            {lead === "review" && !masterOn && <span role="note" className="text-[11.5px] t-dim">Plugins are switched off — turn the plugin system on first</span>}
            {lead === "update" && <Button tone="primary" pending={updating} disabled={busy} onClick={update}>{updating ? "Updating…" : "Update"}</Button>}
            {lead === "open" && <Button tone="primary" onClick={openIt}>Open</Button>}
            {lead === "settings" && <Button tone="primary" onClick={onSettings}>Settings</Button>}
            {lead !== "open" && open && <Button onClick={openIt}>Open</Button>}
            {lead !== "settings" && hasSettings && <Button onClick={onSettings}>Settings</Button>}
            {/* A re-fetch that changes the declaration lands on the same re-consent path as a fresh install. */}
            {updatable && lead !== "update" && (
              <Button pending={updating} disabled={busy} onClick={update} title="Re-fetch this plugin at its recorded source. A changed declaration will need review again before it can run.">
                {updating ? "Checking…" : "Check for update"}
              </Button>
            )}
            <Button tone="danger" className="ml-auto" disabled={busy} onClick={() => setConfirmRemove(true)}>Remove</Button>
          </>
        )}
      </div>
      </PluginModal>
      )}
    </div>
  );
}

/** The Installed card's tool row: search the list by name, publisher or description, and Refresh. Listed in gen-settings-index ROW_TAGS so the settings index keeps "Find a plugin"; not the kit's Row, so not named one. */
function SearchRow({ label, help, value, onChange, onRefresh }: { /** Not a setting: the settings index reads this flag. */ agentExempt?: boolean; label: string; help: string; value: string; onChange: (v: string) => void; onRefresh: () => void }) {
  return (
    <div className="agx-plug-tools" data-row={rowId(label)}>
      <label className="agx-msearch">
        <SearchIcon size={ICON.sm} />
        <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={help} aria-label={label} spellCheck={false} className={INPUT} style={INPUT_STYLE} />
      </label>
      <RefreshButton onRefresh={onRefresh} title="Refresh the installed plugins" />
    </div>
  );
}

const SOURCE_WORD: Record<InstallSource["kind"], string> = { "local-path": "local folder", git: "git", marketplace: "market" };

/** The box under a row for what matters now, with its one fix inside it. Its
 *  own colour per kind, never the ordinary card colour, so an ask cannot pass
 *  for a plain disabled plugin. */
function Band({ band, action, children }: { band: Exclude<CardBand, null>; action: React.ReactNode; children: React.ReactNode }) {
  const Icon = band === "stopped" ? BlockedIcon : band === "update" ? UpIcon : WarningIcon;
  return (
    <div className="agx-plug-band" data-band={band}>
      <span className="agx-plug-band-ic" aria-hidden><Icon size={ICON.xs} /></span>
      <div className="agx-plug-band-tx">{children}</div>
      <div className="agx-plug-band-act">{action}</div>
    </div>
  );
}

/** The master switch, labelled where it sits: in the head of the Plugin system card. Named Toggle so the settings index reads its label and setting (gen-settings-index ROW_TAGS). */
function Toggle({ settingId, label, on, busy, onToggle }: { settingId: string; label: string; on: boolean; busy: boolean; onToggle: () => void }) {
  return (
    <span className="agx-plug-swl" data-row={rowId(label)} data-setting-id={settingId}>
      <span aria-hidden>{label}</span>
      <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={busy} onClick={onToggle}><Switch on={on} busy={busy} /></button>
    </span>
  );
}

/** The Plugin system card: the worst thing first with the master switch beside
 *  it, what the switch does, then the counts and any machine-wide note.
 *  Running is every live process; the other four are the bins they name. */
function SystemStatus({ tally, known, help, control, children }: { tally: PluginTally; known: boolean; help: string; control: React.ReactNode; children?: React.ReactNode }) {
  const head = systemHeadline(tally);
  const cells: [number, string, "ok" | "off" | "warn" | "err" | "info"][] = [
    [tally.running, "Running", "ok"], [tally.off, "Off", "off"], [tally.approval, "Needs approval", "warn"],
    [tally.stopped, "Stopped", "err"], [tally.update, "Update", "info"],
  ];
  return (
    <>
    <div className="agx-plug-sys" aria-busy={!known || undefined}>
      <div className="agx-plug-sys-head"><span className="agx-plug-dot" data-tone={head.tone} aria-hidden />{known ? head.text : "Reading plugins…"}</div>
      {control}
      <div className="agx-plug-sys-sub">{help}</div>
      <div className="agx-plug-tally" role="list" aria-label="Plugins by state">
        {cells.map(([n, label, tone]) => (
          <div key={label} role="listitem" data-zero={n ? undefined : "true"}>
            <b><span className="agx-plug-dot" data-tone={n ? tone : "off"} aria-hidden /><span className="tabular-nums">{known ? n : "–"}</span></b>
            <small>{label}</small>
          </div>
        ))}
      </div>
    </div>
    {children}
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
function StatePill({ enabled, running, pid, hadApproval, fingerprint, approvedFingerprint }: { enabled: boolean; running: boolean; pid: number | null; hadApproval: boolean; fingerprint: string; approvedFingerprint: string | null }) {
  const [label, tone] = pluginState({ enabled, running, hadApproval, fingerprint, approvedFingerprint });
  return (
    <span data-tip={running && pid ? `pid ${pid}` : undefined} tabIndex={running && pid ? 0 : undefined}>
      <StatusBadge tone={tone satisfies StatusTone} icon={tone === "warn" ? <WarningIcon size={ICON.xs} /> : tone === "err" ? <BlockedIcon size={ICON.xs} /> : undefined}>{label}</StatusBadge>
    </span>
  );
}

function DrawChip({ tint, label }: { tint: string; label: string }) {
  return <Badge tint={`color-mix(in srgb, ${tint} 75%, var(--text))`} fill={tint} outlined>{label}</Badge>;
}
