// The screen for docs/PLUGINS.md's six routes.
//
// The mechanism renders nothing of its own — see the note at the top of
// server/src/plugins.ts. This page is OUR screen, showing OUR data about
// what somebody installed: install copies a folder and runs nothing,
// enabling is the one moment a human grants a scope, and disabling stops
// the process that scope was minted for. Reviewing that from a terminal is
// not review, which is the whole reason this file exists.
import { PluginMark } from "./plugins/PluginMark.tsx";
import { emitControl } from "../lib/controlBus.ts";
import { clearPluginInstall, pluginInstallRequest, subscribePluginInstall } from "../lib/installPlugin.ts";
import { PluginSettingsPane } from "./plugins/PluginSettingsPane.tsx";
import { Market } from "./plugins/Market.tsx";
import { PluginDeclaration } from "./plugins/PluginDeclaration.tsx";
import { ICON } from "../lib/iconSize.ts";
import { useDialogs } from "./ConfirmDialog.tsx";
import { useCallback, useEffect, useState, useMemo, useSyncExternalStore } from "react";
import { Fold, SettingRow, Switch } from "./SettingRow.tsx";
import { api } from "../lib/api.ts";
import { fmtAgo } from "../lib/format.ts";
import { usePoll } from "../lib/usePoll.ts";
import type { DeviceScope, InstallSource, PublicPlugin } from "../../../shared/types.ts";

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

/** The house card shape (see TriageBoard.tsx's `CardView`, SkillsModal.tsx's
 *  `SkillCard`): a bordered tile on `--bg2`, not a row. A plugin is a thing
 *  somebody else made — name, publisher, description, a state, a decision —
 *  and that is what this shape is for everywhere else it appears. */
const CARD_STYLE: React.CSSProperties = {
  border: "1px solid var(--surface-line)",
  background: "var(--surface-card)",
  boxShadow: "var(--surface-lift)",
};

/**
 * A tile the same size and shape as a plugin card, not a text field wedged
 * into a settings row — this page is a board of things, and adding one is
 * an action on that board. Closed, it reads as the "+" every other add
 * affordance in this app is; opened, it is the one field installing a
 * plugin actually needs. Install accepts an absolute local path or a git
 * URL — installPlugin on the server tells them apart by `isAbsolute`, so
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
    <div className="rounded-xl p-3 mb-3" style={CARD_STYLE}>
      <div className="text-[12.5px] font-medium" style={{ color: "var(--text)" }}>Install a plugin</div>
      <div className="text-[11px] t-dim mt-0.5">
        A local folder's absolute path, or a git URL. Copies the folder and reads its manifest — nothing in it runs yet.
      </div>
      <div className="flex items-center gap-2 mt-2">
        <input value={source} onChange={(e) => setSource(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") install(); if (e.key === "Escape") setOpen(false); }}
          placeholder="/path/to/plugin or https://…"
          disabled={busy}
          autoFocus
          className="t-mono text-[11.5px] px-2.5 py-1.5 rounded-lg min-w-0 flex-1"
          style={{ color: "var(--text)", background: "color-mix(in srgb, var(--bg) 70%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 50%, transparent)" }} />
        <button onClick={install} disabled={busy || !source.trim()}
          className="text-[12px] px-2.5 py-1 rounded-lg whitespace-nowrap hover:opacity-80 disabled:opacity-50"
          style={{ color: "var(--text)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}>
          {busy ? "Installing…" : "Install"}
        </button>
        <button onClick={() => { setOpen(false); setError(null); }} disabled={busy}
          className="text-[12px] px-2 py-1 rounded-lg whitespace-nowrap hover:opacity-80"
          style={{ color: "var(--text3)" }}>
          Cancel
        </button>
      </div>
      {error && <Alert tone="error">{error}</Alert>}
    </div>
  );
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

  const load = useCallback(() => {
    api.plugins().then((r) => { setMasterState(r.master); setPlugins(r.plugins); }).catch(() => { /* left as last known */ });
  }, []);

  useEffect(() => { if (open) load(); }, [open, load]);
  // A plugin's own state (pid, running) changes on its own — a crash, a
  // restart — so this pane watches rather than only reacting to clicks.
  usePoll(open, load, 3000);

  const toggleMaster = async () => {
    if (master === null || busyMaster) return;
    setBusyMaster(true);
    const r = await api.pluginMaster(!master);
    setBusyMaster(false);
    if (r.ok) setMasterState(r.master ?? !master);
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
        <button onClick={() => setShowing(null)}
          className="mb-3 inline-flex items-center gap-1.5 text-[12px] hover:opacity-80"
          style={{ color: "var(--text3)", background: "transparent", border: 0 }}>
          ← All plugins
        </button>
        <div className="flex items-center gap-2.5 mb-3">
          <PluginMark name={here.name} icon={here.icon} color={here.color} size={ICON.lg} stamp={here.contentHash} />
          <div className="min-w-0">
            <div className="text-[14px]" style={{ color: "var(--text)" }}>{here.name}</div>
            <div className="text-[11.5px] t-dim truncate">by {here.publisher}</div>
          </div>
        </div>
        <PluginSettingsPane key={here.name} name={here.name} open={open} />
      </div>
    );
  }

  return (
    <div className="pb-5">
      {/* The one thing on this page that IS a setting keeps the settings
          idiom — a titled card with a row and a switch — so that everything
          below, which is not a setting, is free to stop looking like one. */}
      <div className="agx-settings-section">
          <div className="agx-settings-head">
            <div className="agx-settings-head-t">Plugin system</div>
            <div className="agx-settings-head-d">Nothing runs until you have read what it declares and switched it on.</div>
          </div>
          <div className="agx-settings-rows">
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
          </div>
      </div>

      {/* THE BOARD, and it used to be a shelf: a tinted, bordered zone with
          every card stacked one-per-row inside it. That zone was doing the
          job the cards should do — one box holding boxes reads as a single
          object with a wall of text in it, which is what "so blended with
          settings that it confuses" was describing. The cards are the shape
          now; there is nothing behind them but the page. */}
      <div className="flex items-center gap-2.5 pb-3 flex-wrap">
        <span className="text-[13.5px] font-semibold" style={{ color: "var(--text)" }}>Installed</span>
        <span className="chip tabular-nums t-dim">{plugins.length}</span>
        <div className="ml-auto flex items-center gap-2">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search plugins"
            className="w-[190px] px-2.5 py-1.5 rounded-lg text-[12.5px] outline-none"
            style={{ background: "var(--bg)", border: "1px solid var(--surface-line)", color: "var(--text)" }} />
          <button onClick={load}
            className="text-[12px] px-2.5 py-1.5 rounded-lg whitespace-nowrap hover:opacity-80"
            style={{ color: "var(--text2)", border: "1px solid var(--surface-line)" }}>
            Refresh
          </button>
          {/* In the header, with the other things you do to this list. It was
              a dashed half-width tile at the end of the grid, which on an
              empty list was the only thing there and read as a stray box. */}
          <button onClick={() => setInstalling(true)} disabled={installing}
            className="text-[12px] px-2.5 py-1.5 rounded-lg whitespace-nowrap hover:opacity-80 disabled:opacity-50"
            style={{ color: "var(--primary)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)" }}>
            Install a plugin
          </button>
        </div>
      </div>

      {/* auto-fill, not a fixed column count: one plugin on a narrow window
          should be one full-width card rather than a half-width card with a
          hole beside it, and the same grid has to survive the sidebar being
          open on a laptop. 360 is the floor a card of this density needs —
          below it the description wraps to five lines and the footer buttons
          stack, which is the letterbox again. */}
      {already && (
        <Alert tone="ok">
          <span>
            <b>{already}</b> is already installed — the link you followed asked for this one. It is in the list below;
            <span className="t-dim"> Update re-clones it at the source it came from.</span>
          </span>
        </Alert>
      )}
      <AddPluginCard onInstalled={load} open={installing} setOpen={setInstalling} prefill={prefill} />
      {plugins.length === 0 ? (
        <div className="rounded-xl px-4 py-5 text-[12px] t-dim" style={{ border: "1px dashed var(--surface-line)" }}>
          Nothing installed yet. Install one from a folder or a git URL, or take one from the market below.
        </div>
      ) : (
        /* `items-start`, because a card in here can grow: opening one card's
           "What it can do" made the card BESIDE it grow with it, into a tall
           box with nothing in the bottom two thirds of it. A grid item
           stretches to its row by default, and the row is as tall as whatever
           is open in it. Each card owns its own height now. */
        <div className="grid gap-3 items-start" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))" }}>
          {shown.map((p) => (
            <PluginCard key={p.name} plugin={p} masterOn={!!master} onChanged={load} onSettings={() => setShowing(p.name)} />
          ))}
        </div>
      )}
      {plugins.length > 0 && shown.length === 0 && (
        <div className="pt-3 text-[12px] t-dim">Nothing installed matches “{q.trim()}”.</div>
      )}

      {/* The same 24px every settings card keeps from the next one. The grid
          sat directly on the card below it, with nothing between them. */}
      <div className="h-6" aria-hidden />
      <Market installed={(url) => !!installedFrom(url, plugins)} onInstalled={load} />
    </div>
  );
}

function PluginCard({ plugin, masterOn, onChanged, onSettings }: {
  plugin: PublicPlugin; masterOn: boolean; onChanged: () => void;
  /** Opens this plugin's own settings inside the Plugins page. */
  onSettings: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
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
  // A switch reading "on" while nothing runs is the exact failure this page
  // exists to catch, so the toggle reflects the PROCESS, not the intent —
  // `enabled` can be true with `running` false for one tick after a crash.
  const running = plugin.running;
  // Only a git-backed source has an upstream to re-fetch — see
  // server/src/plugins.ts, updatePlugin.
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
    if (next) await api.pluginEnable(plugin.name);
    else await api.pluginDisable(plugin.name);
    setBusy(false);
    onChanged();
  };

  const update = async () => {
    setUpdating(true);
    setUpdateError(null);
    const r = await api.pluginUpdate(plugin.name);
    setUpdating(false);
    if (r.ok) onChanged();
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
    {/* Outside the card: the card clips what spills over its rounded edge,
        and a dialog drawn inside it was clipped away entirely. */}
    {dialog}
    <div className="rounded-xl p-4 flex flex-col relative overflow-hidden" style={{
      ...CARD_STYLE,
      // The plugin's own colour, as a wash in the corner its mark sits in:
      // enough to tell two cards apart at a glance, never enough to fight the
      // text. No colour declared, the app's accent.
      backgroundImage: `radial-gradient(120% 90% at 0% 0%, color-mix(in srgb, ${tint} 13%, transparent), transparent 55%)`,
    }}>
      {/* Name and publisher stack against the mark rather than running along
          one line with the description under all three. A card is scanned in
          a grid, and what gets scanned is the top-left corner: a shape, then
          a name, then who wrote it. */}
      <div className="flex items-start gap-3">
        <PluginMark name={plugin.name} icon={plugin.icon} color={plugin.color} stamp={plugin.contentHash} />
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[15px] font-semibold tracking-tight" style={{ color: "var(--text)" }}>{plugin.name}</span>
            <StatePill enabled={plugin.enabled} running={running} reconsent={reconsent} needsReview={needsReview} pid={plugin.pid} />
          </div>
          <div className="text-[11.5px] t-dim mt-0.5">by {plugin.publisher}</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={() => setEnabled(!plugin.enabled)}
            disabled={busy || (!plugin.enabled && !masterOn)}
            title={!plugin.enabled && needsReview ? "Switching it on approves what it declares below" : !plugin.enabled && !masterOn ? "Plugins are switched off" : undefined}
            className="disabled:cursor-not-allowed">
            <Switch on={plugin.enabled} busy={busy} />
          </button>
        </div>
      </div>

      <div className="text-[12.5px] leading-relaxed mt-3" style={{ color: "var(--text2)" }}>{plugin.description}</div>

      {/* Chips, because a card in a grid is read by its badges before its
          prose — the scope is the one fact worth knowing before installing
          anything, and buried mid-sentence it was not being read. */}
      <div className="flex items-center gap-1.5 flex-wrap mt-2">
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
      <div className="text-[11px] t-dim mt-1.5 truncate" title={formatSource(plugin.source)}>
        From <span className="t-mono">{formatSource(plugin.source)}</span>
      </div>

      {/* The re-consent case, drawn so it cannot be mistaken for an ordinary
          disabled card: its own colour, its own sentence, above the fold that
          holds the scope explanation everyone else gets. */}
      {reconsent && (
        <Alert tone="warning">
          <strong>This plugin is asking for something different now.</strong> What is installed no
          longer matches what you last approved — the manifest changed since then. It was turned off
          automatically and stays off until you review the current declaration below and enable it again.
        </Alert>
      )}
      {!plugin.hadApproval && needsReview && (
        <div className="text-[11.5px] mt-1.5" style={{ color: "var(--text2)" }}>
          Not reviewed yet. Read what it declares before enabling it.
        </div>
      )}

      <div className="mt-1.5">
        {/* Open by default only while there is a decision to make — the fold
            defaults open for a fresh install or a changed manifest, closed
            once it has been approved. The sentence has to be legible at the
            moment somebody is approving it; once approved, showing it every
            visit is the noise a four-line paragraph on every card would be. */}
        {/* Where it draws is part of what is being approved: a plugin that
            starts drawing somewhere new has a new manifest hash, and is asked
            about again. Drawn by this app, never run in it. */}
        <Fold label="What it can do" defaultOpen={needsReview}>
          <PluginDeclaration plugin={plugin} />
        </Fold>
      </div>

      {updateError && <Alert tone="error">{updateError}</Alert>}

      {/* Kept by default: what was typed into the settings page belongs to
          the person, and a reinstall picks it back up. */}
      {confirmRemove && hasSettings && (
        <label className="mt-auto pt-1.5 flex items-center gap-2 self-end text-[11px] cursor-pointer select-none" style={{ color: "var(--text2)" }}>
          <input type="checkbox" checked={dropSettings} onChange={(e) => setDropSettings(e.target.checked)} disabled={busy} />
          <span>Also remove its settings</span>
        </label>
      )}
      <div className={`${confirmRemove && hasSettings ? "" : "mt-auto "}pt-1.5 flex items-center justify-between`}>
        <span className="text-[10.5px] t-dim">installed {fmtAgo(plugin.installedAt)}</span>
        {confirmRemove ? (
          <span className="flex items-center gap-1.5">
            <button onClick={remove} disabled={busy}
              className="text-[12px] px-2.5 py-1 rounded-lg whitespace-nowrap font-medium"
              style={{ color: "var(--error)", background: "color-mix(in srgb, var(--error) 16%, transparent)", border: "1px solid color-mix(in srgb, var(--error) 44%, transparent)", opacity: busy ? 0.5 : 1 }}>
              {busy ? "Removing…" : "Remove"}
            </button>
            <button onClick={() => { setConfirmRemove(false); setDropSettings(false); }} disabled={busy}
              className="text-[12px] px-2.5 py-1 rounded-lg whitespace-nowrap hover:opacity-80"
              style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}>
              Keep it
            </button>
          </span>
        ) : (
          <span className="flex items-center gap-1.5">
            {/* A re-fetch that changes the declaration lands on the same
                re-consent path as a fresh install — see updatePlugin on the
                server — so this never claims to have "updated" anything
                itself, only to have gone and looked. */}
            {/* Straight to where it shows up — the answer to "I switched it on,
                now what". */}
            {hasPanel && plugin.enabled && (
              <button onClick={() => { emitControl({ cmd: "view", to: "plugins" }); emitControl({ cmd: "esc" }); }}
                className="text-[12px] px-2.5 py-1 rounded-lg whitespace-nowrap hover:opacity-80"
                style={{ color: tint, border: `1px solid color-mix(in srgb, ${tint} 45%, transparent)`, background: `color-mix(in srgb, ${tint} 10%, transparent)` }}>
                Open
              </button>
            )}
            {hasSettings && (
              <button onClick={onSettings}
                className="text-[12px] px-2.5 py-1 rounded-lg whitespace-nowrap hover:opacity-80"
                style={{ color: "var(--text)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}>
                Settings
              </button>
            )}
            {updatable && (
              <button onClick={update} disabled={busy || updating}
                title="Re-fetch this plugin at its recorded source. A changed declaration will need review again before it can run."
                className="text-[12px] px-2.5 py-1 rounded-lg whitespace-nowrap hover:opacity-80 disabled:opacity-50"
                style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}>
                {updating ? "Updating…" : "Update"}
              </button>
            )}
            <button onClick={() => setConfirmRemove(true)} disabled={busy}
              className="text-[12px] px-2.5 py-1 rounded-lg whitespace-nowrap hover:opacity-80"
              style={{ color: "var(--error)", border: "1px solid color-mix(in srgb, var(--error) 32%, transparent)", opacity: busy ? 0.5 : 1 }}>
              Remove
            </button>
          </span>
        )}
      </div>
    </div>
    </>
  );
}

function Alert({ tone, children }: { tone: "warning" | "error" | "ok"; children: React.ReactNode }) {
  const c = tone === "error" ? "var(--error)" : tone === "ok" ? "var(--success)" : "var(--warning)";
  return (
    <div className="mt-1.5 px-3 py-2 rounded-lg text-[12px] leading-relaxed" style={{
      color: "var(--text2)",
      background: `color-mix(in srgb, ${c} 9%, transparent)`,
      border: `1px solid color-mix(in srgb, ${c} 32%, transparent)`,
    }}>
      {children}
    </div>
  );
}


/** Running, off, or waiting on you — a word, not only a dot, because the dot
 *  alone had to be learned and it is the first thing asked of a card. */
function StatePill({ enabled, running, reconsent, needsReview, pid }: { enabled: boolean; running: boolean; reconsent: boolean; needsReview: boolean; pid: number | null }) {
  const [label, tint] = reconsent ? ["asks again", "var(--warning)"]
    : needsReview && !enabled ? ["not approved", "var(--warning)"]
    : enabled && running ? ["running", "var(--success)"]
    // Switched on and nothing running: the failure a plugin screen exists to
    // show, and the one an `enabled` flag alone cannot.
    : enabled ? ["enabled, not running", "var(--warning)"]
    : ["off", "var(--text3)"];
  return (
    <span className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wide px-1.5 py-px rounded-full"
      title={running && pid ? `pid ${pid}` : undefined}
      style={{ color: tint, background: `color-mix(in srgb, ${tint} 12%, transparent)` }}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: tint, boxShadow: enabled && running ? `0 0 6px ${tint}` : undefined }} />
      {label}
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
