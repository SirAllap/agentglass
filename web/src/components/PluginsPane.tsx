// The screen for docs/PLUGINS.md's six routes.
//
// The mechanism renders nothing of its own — see the note at the top of
// server/src/plugins.ts. This page is OUR screen, showing OUR data about
// what somebody installed: install copies a folder and runs nothing,
// enabling is the one moment a human grants a scope, and disabling stops
// the process that scope was minted for. Reviewing that from a terminal is
// not review, which is the whole reason this file exists.
import { useCallback, useEffect, useState } from "react";
import { Fold, SettingRow, Switch } from "./SettingRow.tsx";
import { api } from "../lib/api.ts";
import { fmtAgo } from "../lib/format.ts";
import { usePoll } from "../lib/usePoll.ts";
import type { Catalogue, DeviceScope, InstallSource, PublicPlugin } from "../../../shared/types.ts";

/** The one-line "From …" a reviewer reads — a local path plainly, a git
 *  source with its ref if one was pinned, a marketplace install naming the
 *  catalogue it came from. */
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
const SCOPE_SENTENCE: Record<DeviceScope, string> = {
  read: "Sees everything this app can read: every session's live output as it streams — the same prompts and replies you watch on screen — plus costs, diffs and pull requests. Cannot approve a gate, send a reply, or write anything.",
  answer: "Everything read gets, plus approving gates and replying to a session that is already running.",
  full: "Everything this machine can do: a terminal, git write access, docker control, merging pull requests.",
};
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
 * Two letters standing in for an icon nobody shipped.
 *
 * A board of cards needs something to aim at before the words are read, and
 * plugins have no artwork — the manifest carries a name and a publisher and
 * that is all. Initials off the name are the same answer an avatar is: a
 * shape, in a stable colour, that tells one card from another at a glance.
 *
 * Hue from the name's own bytes, so the same plugin is the same colour on
 * every machine and no two adjacent cards are alike unless their names are.
 */
function Initials({ name }: { name: string }) {
  const letters = name.replace(/[^a-zA-Z0-9]+/g, " ").trim().split(/\s+/)
    .slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return (
    <span aria-hidden className="shrink-0 grid place-items-center rounded-xl text-[13px] font-semibold"
      style={{
        width: 40, height: 40,
        color: `oklch(0.86 0.09 ${h})`,
        background: `oklch(0.34 0.06 ${h} / 0.45)`,
        border: `1px solid oklch(0.55 0.08 ${h} / 0.4)`,
      }}>
      {letters}
    </span>
  );
}

/**
 * A tile the same size and shape as a plugin card, not a text field wedged
 * into a settings row — this page is a board of things, and adding one is
 * an action on that board. Closed, it reads as the "+" every other add
 * affordance in this app is; opened, it is the one field installing a
 * plugin actually needs. Install accepts an absolute local path or a git
 * URL — installPlugin on the server tells them apart by `isAbsolute`, so
 * this asks for one field rather than a toggle nobody needs to set.
 */
function AddPluginCard({ onInstalled }: { onInstalled: () => void }) {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState("");
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

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        className="w-full rounded-xl p-2.5 text-[12.5px] hover:opacity-80 flex items-center gap-1.5"
        style={{ color: "var(--text3)", border: "1px dashed color-mix(in srgb, var(--border) 55%, transparent)", background: "transparent" }}>
        <span aria-hidden>+</span> Install a plugin
      </button>
    );
  }

  return (
    <div className="rounded-xl p-3" style={CARD_STYLE}>
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

/** Is this catalogue entry already on disk — installed from this exact
 *  catalogue entry, or from its git source directly. Matched on the git
 *  source, not the catalogue's own `id`: a plugin pasted in by URL and one
 *  found later in a catalogue are the same install either way, and an
 *  already-installed entry must read as installed, not as a fresh offer. */
function isInstalled(entry: Catalogue["plugins"][number], plugins: PublicPlugin[]): boolean {
  return plugins.some((p) => {
    if (p.source.kind === "git") return p.source.url === entry.source.url;
    if (p.source.kind === "marketplace") return p.source.plugin.url === entry.source.url;
    return false;
  });
}

/** One entry inside a browsed catalogue, drawn as the same tile a plugin
 *  card is — this is a thing on the shelf too, just not taken yet. The
 *  border is the dashed one `AddPluginCard` uses for its own closed state:
 *  a plugin already installed is claimed (solid), one still in the
 *  catalogue is offered (dashed) — the two states of one shelf, not a card
 *  next to a row. Installing runs the same review-then-enable path as any
 *  other install — installFromCatalogue on the server still only copies a
 *  folder and reads its manifest. */
function CatalogueEntryRow({
  entry, owner, catalogueUrl, installed, onInstalled,
}: { entry: Catalogue["plugins"][number]; owner: string; catalogueUrl: string; installed: boolean; onInstalled: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const install = async () => {
    setBusy(true);
    setError(null);
    const r = await api.pluginInstallFromCatalogue(catalogueUrl, entry.id);
    setBusy(false);
    if (r.ok) onInstalled();
    else setError(r.error);
  };

  return (
    <div className="rounded-xl p-3 flex flex-col" style={installed ? CARD_STYLE : {
      border: "1px dashed color-mix(in srgb, var(--border) 55%, transparent)",
      background: "transparent",
    }}>
      <div className="flex items-start gap-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-[13.5px]" style={{ color: "var(--text)" }}>{entry.id}</span>
            <span className="text-[11.5px] t-dim">by {owner}</span>
          </div>
          <div className="flex items-center gap-1 flex-wrap mt-1">
            {entry.categories.map((c) => (
              <span key={c} className="chip text-[9.5px]" style={{
                color: "var(--text3)",
                background: "color-mix(in srgb, var(--border) 16%, transparent)",
                borderColor: "color-mix(in srgb, var(--border) 40%, transparent)",
              }}>{c}</span>
            ))}
          </div>
        </div>
      </div>
      <div className="text-[12px] mt-1.5" style={{ color: "var(--text2)" }}>{entry.description}</div>
      {error && <Alert tone="error">{error}</Alert>}
      <div className="mt-auto pt-2.5 flex items-center justify-end">
        {installed ? (
          <span className="text-[11px] t-dim">On the shelf</span>
        ) : (
          <button onClick={install} disabled={busy}
            className="text-[12px] px-2.5 py-1 rounded-lg whitespace-nowrap hover:opacity-80 disabled:opacity-50 font-medium"
            style={{ color: "var(--bg)", background: "var(--primary)" }}>
            {busy ? "Installing…" : "Install"}
          </button>
        )}
      </div>
    </div>
  );
}

/** One catalogue he has added: collapsed by default, fetched fresh (never
 *  cached) the moment it is opened — a catalogue is a stranger's document,
 *  not a registry, so there is nothing here worth trusting between reads.
 *  Unreachable or malformed reads as exactly that, not as an empty list. */
function CatalogueRow({
  url, plugins, onInstalled, onRemoved,
}: { url: string; plugins: PublicPlugin[]; onInstalled: () => void; onRemoved: () => void }) {
  const [openState, setOpenState] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ ok: true; catalogue: Catalogue } | { ok: false; error: string } | null>(null);

  const toggle = async () => {
    const next = !openState;
    setOpenState(next);
    if (next && !result) {
      setLoading(true);
      const r = await api.pluginCatalogueFetch(url);
      setLoading(false);
      setResult(r);
    }
  };

  const refetch = async () => {
    const r = await api.pluginCatalogueFetch(url);
    setResult(r);
    onInstalled();
  };

  return (
    <div className="py-2.5" style={{ borderTop: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}>
      <div className="flex items-center gap-2.5">
        <button onClick={toggle} className="min-w-0 flex-1 flex items-baseline gap-2 text-left hover:opacity-80">
          <span className="t-mono text-[12.5px] truncate" style={{ color: "var(--text)" }}>{url}</span>
          {result?.ok && <span className="text-[11px] t-dim shrink-0">{result.catalogue.plugins.length} plugins</span>}
        </button>
        <button onClick={onRemoved}
          className="text-[11px] px-2 py-0.5 rounded-lg whitespace-nowrap hover:opacity-80 shrink-0"
          style={{ color: "var(--error)", border: "1px solid color-mix(in srgb, var(--error) 30%, transparent)" }}>
          Remove
        </button>
      </div>
      {openState && (
        loading ? (
          <div className="py-2 text-[11.5px] t-dim">Fetching…</div>
        ) : result && !result.ok ? (
          <Alert tone="error">Catalogue unreachable: {result.error}</Alert>
        ) : result?.ok ? (
          result.catalogue.plugins.length === 0 ? (
            <div className="py-2 text-[11.5px] t-dim">This catalogue lists no plugins.</div>
          ) : (
            <div className="grid gap-3 mt-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}>
              {result.catalogue.plugins.map((entry) => (
                <CatalogueEntryRow key={entry.id} entry={entry} owner={result.catalogue.owner} catalogueUrl={url}
                  installed={isInstalled(entry, plugins)} onInstalled={refetch} />
              ))}
            </div>
          )
        ) : null
      )}
    </div>
  );
}

/** Add a catalogue by URL and keep the ones already added — a catalogue is
 *  somebody else's list; he collects the ones he trusts, the way he
 *  collects anything else. Adding never installs anything on its own. */
function CataloguesSection({ plugins, onInstalled }: { plugins: PublicPlugin[]; onInstalled: () => void }) {
  const [catalogues, setCatalogues] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.pluginCatalogues().then((r) => setCatalogues(r.catalogues)).catch(() => { /* left as last known */ });
  }, []);

  useEffect(() => { load(); }, [load]);

  const add = async () => {
    if (!url.trim() || busy) return;
    setBusy(true);
    setError(null);
    const r = await api.pluginCatalogueAdd(url.trim());
    setBusy(false);
    if (r.ok) { setUrl(""); setOpen(false); load(); }
    else setError(r.error ?? "Could not add that catalogue");
  };

  const remove = async (u: string) => {
    await api.pluginCatalogueRemove(u);
    load();
  };

  return (
    <div className="agx-settings-section">
      <div className="panel-eyebrow pb-1">Catalogues</div>
      <div className="agx-settings-rows">
        {open ? (
          <div className="rounded-xl p-3" style={CARD_STYLE}>
            <div className="text-[12.5px] font-medium" style={{ color: "var(--text)" }}>Add a catalogue</div>
            <div className="text-[11px] t-dim mt-0.5">
              A URL to a JSON catalogue somebody else publishes — a list of plugins by their git source. Nothing installs until you pick one from it.
            </div>
            <div className="flex items-center gap-2 mt-2">
              <input value={url} onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") add(); if (e.key === "Escape") setOpen(false); }}
                placeholder="https://…/catalogue.json"
                disabled={busy}
                autoFocus
                className="t-mono text-[11.5px] px-2.5 py-1.5 rounded-lg min-w-0 flex-1"
                style={{ color: "var(--text)", background: "color-mix(in srgb, var(--bg) 70%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 50%, transparent)" }} />
              <button onClick={add} disabled={busy || !url.trim()}
                className="text-[12px] px-2.5 py-1 rounded-lg whitespace-nowrap hover:opacity-80 disabled:opacity-50"
                style={{ color: "var(--text)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}>
                {busy ? "Adding…" : "Add"}
              </button>
              <button onClick={() => { setOpen(false); setError(null); }} disabled={busy}
                className="text-[12px] px-2 py-1 rounded-lg whitespace-nowrap hover:opacity-80"
                style={{ color: "var(--text3)" }}>
                Cancel
              </button>
            </div>
            {error && <Alert tone="error">{error}</Alert>}
          </div>
        ) : (
          <button onClick={() => setOpen(true)}
            className="rounded-xl p-2.5 text-[12.5px] hover:opacity-80 flex items-center gap-1.5"
            style={{ color: "var(--text3)", border: "1px dashed color-mix(in srgb, var(--border) 55%, transparent)", background: "transparent" }}>
            <span aria-hidden>+</span> Add a catalogue
          </button>
        )}
        {catalogues.length === 0 ? (
          <div className="py-2 text-[12px] t-dim">No catalogues added yet.</div>
        ) : (
          catalogues.map((u) => (
            <CatalogueRow key={u} url={u} plugins={plugins} onInstalled={onInstalled} onRemoved={() => remove(u)} />
          ))
        )}
      </div>
    </div>
  );
}

export function PluginsPane({ open }: { open: boolean }) {
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
     its name — and with a catalogue attached this list is not always short. */
  const [q, setQ] = useState("");
  const ql = q.trim().toLowerCase();
  const shown = ql
    ? plugins.filter((p) => `${p.name} ${p.publisher} ${p.description}`.toLowerCase().includes(ql))
    : plugins;

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
        </div>
      </div>

      {/* auto-fill, not a fixed column count: one plugin on a narrow window
          should be one full-width card rather than a half-width card with a
          hole beside it, and the same grid has to survive the sidebar being
          open on a laptop. 360 is the floor a card of this density needs —
          below it the description wraps to five lines and the footer buttons
          stack, which is the letterbox again. */}
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))" }}>
        {shown.map((p) => <PluginCard key={p.name} plugin={p} masterOn={!!master} onChanged={load} />)}
        <AddPluginCard onInstalled={load} />
      </div>
      {plugins.length > 0 && shown.length === 0 && (
        <div className="pt-3 text-[12px] t-dim">Nothing installed matches “{q.trim()}”.</div>
      )}

      <CataloguesSection plugins={plugins} onInstalled={load} />
    </div>
  );
}

function PluginCard({ plugin, masterOn, onChanged }: { plugin: PublicPlugin; masterOn: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

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

  const setEnabled = async (next: boolean) => {
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
    await api.pluginRemove(plugin.name);
    setBusy(false);
    setConfirmRemove(false);
    onChanged();
  };

  return (
    <div className="rounded-xl p-3.5 flex flex-col" style={CARD_STYLE}>
      {/* Name and publisher stack against the mark rather than running along
          one line with the description under all three. A card is scanned in
          a grid, and what gets scanned is the top-left corner: a shape, then
          a name, then who wrote it. */}
      <div className="flex items-start gap-3">
        <Initials name={plugin.name} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[13.5px] font-medium" style={{ color: "var(--text)" }}>{plugin.name}</span>
            <StateDot enabled={plugin.enabled} running={running} reconsent={reconsent} />
          </div>
          <div className="text-[11.5px] t-dim mt-0.5">by {plugin.publisher}</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={() => setEnabled(!plugin.enabled)}
            disabled={busy || (!plugin.enabled && (needsReview || !masterOn))}
            title={!plugin.enabled && needsReview ? "Review what it declares before enabling" : !plugin.enabled && !masterOn ? "Plugins are switched off" : undefined}
            className="disabled:cursor-not-allowed">
            <Switch on={plugin.enabled} busy={busy} />
          </button>
        </div>
      </div>

      <div className="text-[12px] mt-2.5" style={{ color: "var(--text2)" }}>{plugin.description}</div>

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
        <span className="chip text-[10px]" style={{
          color: running ? "var(--success)" : plugin.enabled ? "var(--warning)" : "var(--text4)",
          borderColor: `color-mix(in srgb, ${running ? "var(--success)" : plugin.enabled ? "var(--warning)" : "var(--border)"} 45%, transparent)`,
        }}>
          {running ? `running · pid ${plugin.pid}` : plugin.enabled ? "enabled, not running" : "not running"}
        </span>
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
        <Fold label="What it can do" hint={SCOPE_WORD[plugin.scope]} defaultOpen={needsReview}>
          <p className="m-0">{SCOPE_SENTENCE[plugin.scope]}</p>
          <p className="m-0 mt-1.5 t-mono text-[11px]" style={{ color: "var(--text3)" }}>
            runs: {plugin.entrypoint}
          </p>
        </Fold>
      </div>

      {updateError && <Alert tone="error">{updateError}</Alert>}

      <div className="mt-auto pt-1.5 flex items-center justify-between">
        <span className="text-[10.5px] t-dim">installed {fmtAgo(plugin.installedAt)}</span>
        {confirmRemove ? (
          <span className="flex items-center gap-1.5">
            <button onClick={remove} disabled={busy}
              className="text-[12px] px-2.5 py-1 rounded-lg whitespace-nowrap font-medium"
              style={{ color: "var(--error)", background: "color-mix(in srgb, var(--error) 16%, transparent)", border: "1px solid color-mix(in srgb, var(--error) 44%, transparent)", opacity: busy ? 0.5 : 1 }}>
              {busy ? "Removing…" : "Remove"}
            </button>
            <button onClick={() => setConfirmRemove(false)} disabled={busy}
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
  );
}

function Alert({ tone, children }: { tone: "warning" | "error"; children: React.ReactNode }) {
  const c = tone === "error" ? "var(--error)" : "var(--warning)";
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

/** enabled+running is green, enabled-but-not-running is the failure this page
 *  exists to catch (amber, not green — the switch is not the truth), asking
 *  for review is its own colour so it cannot read as a plain "off". */
function StateDot({ enabled, running, reconsent }: { enabled: boolean; running: boolean; reconsent: boolean }) {
  const tint = reconsent ? "var(--warning)" : enabled && running ? "var(--success)" : enabled ? "var(--warning)" : "var(--text4)";
  return (
    <span className="shrink-0 rounded-full mt-1" aria-hidden style={{
      width: 8, height: 8,
      background: enabled && running ? tint : "transparent",
      border: `1px solid ${tint}`,
    }} />
  );
}
