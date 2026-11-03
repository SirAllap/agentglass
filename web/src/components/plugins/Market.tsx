/*
 * The market: the one list of plugins this project publishes.
 *
 * What was here before was a collection of *catalogues*. A catalogue was a
 * URL somebody added, it arrived collapsed behind its own address, and the
 * list it held opened only after a click on that address — so the first
 * thing the screen said about plugins was a JSON URL with a Remove button
 * next to it, and the plugins themselves were two clicks behind it. Removing
 * that row, on the only list there is, left a settings page whose entire
 * plugin story was "Add by URL…".
 *
 * So: one list, named, read on sight and not addable or removable. Adding a
 * stranger's list is a distribution model this project does not have, and a
 * button that offers one is a promise the app does not keep. Publishing a
 * plugin is opening a pull request against the list — see docs/PLUGINS.md —
 * and the URL below is where that list ends up.
 *
 * It is still fetched fresh every time and never cached: the document is on
 * GitHub Pages, and a stale shelf read as live is the one thing this must
 * not do.
 *
 * WHAT IS NOT HERE: an installed plugin. The market is what you can take,
 * and a card offering to install what is on the shelf already was the thing
 * that made this page unreadable with one plugin published. They are counted
 * in a line under the grid rather than dropped silently, so a market that
 * looks empty says why.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../../lib/api.ts";
import { ICON } from "../../lib/iconSize.ts";
import { externalUrl } from "../../lib/externalUrl.ts";
import { ExternalIcon } from "../browser/icons.tsx";
import { Portal } from "../Portal.tsx";
import { CloseButton } from "../CloseButton.tsx";
import { LAYER } from "../../lib/layers.ts";
import { Badge, Button, EDGE, tintEdge, INPUT, INPUT_STYLE, LINE, RefreshButton, Segmented } from "../workspace/Chrome.tsx";
import { PluginPreview } from "./PluginPreview.tsx";
import { PLUGIN_CTRL_H } from "../../lib/pluginCard.ts";
import { EmptyState, FIELD_SELECT, StatusBadge } from "../SettingsKit.tsx";
import { Select } from "../Select.tsx";
import { InfoIcon, SearchIcon } from "../../lib/glyphIcons.tsx";
import { PageHead } from "./PageHead.tsx";
import type { Catalogue, DeviceScope, InstallSource, PublicPlugin } from "../../../../shared/types.ts";

/** The list this project publishes, on its own site, and the same document
 *  its plugins page is drawn from. */
export const MARKET_URL = "https://sirallap.github.io/agentglass-plugins/plugins.json";
const MARKET_HOST = new URL(MARKET_URL).host;
/** The same list as a page a person can read, with the prose the JSON has no
 *  room for. There is no per-plugin page on it yet, so a row's own link goes
 *  to the repository instead — see `Offer`. */
const MARKET_PAGE = "https://sirallap.github.io/agentglass-plugins/#/plugins";

/** The manifest's own words for where a plugin draws. A card says what
 *  installing gets you before it is installed. */
const DRAWS_WORD: Record<string, string> = {
  panel: "adds a panel", panels: "adds a panel",
  settings: "settings page",
  "pr-notes": "notes in pull requests", prNotes: "notes in pull requests",
  "pr-button": "a button in pull requests", prActions: "a button in pull requests",
  inbox: "badges the Inbox", inboxAnnotations: "badges the Inbox",
};

/** Cards drawn at once. The list is short today and the server keeps the
 *  first five hundred entries of whatever the document holds — a market that
 *  grew to that is two dozen cards and a pager, not five hundred cards with
 *  their own state laid out on the thread the settings page scrolls on. */
const PAGE = 24;
/** Types drawn in the bar itself; the rest are in the select beside it. */
const BAR_TYPES = 3;

type Entry = Catalogue["plugins"][number];
type State =
  | { kind: "loading" }
  | { kind: "error"; error: string }
  | { kind: "ok"; catalogue: Catalogue };

/**
 * The entries a search box leaves on the shelf.
 *
 * Out here rather than inline, so the rule can be asserted without a browser:
 * the market matches on everything a person might remember about a plugin —
 * what it is called, who publishes it, what it says it does — and not only on
 * its title. "the one that reviews pull requests" is as likely a thing to
 * type as "Local Review".
 */
export function matching(entries: Entry[], q: string): Entry[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter((e) => [e.id, e.title, e.publisher, e.description, ...(e.categories ?? [])]
    .some((f) => (f ?? "").toLowerCase().includes(needle)));
}

export type Sort = "recent" | "name";

/** The shelf in the order asked for. "Recently added" is the listing's own
 *  `added` date, newest first; an entry without one goes last, so a listing
 *  that omits it is still in a stable order (by name). */
export function sorted(entries: Entry[], how: Sort): Entry[] {
  const name = (e: Entry) => (e.title || e.id).toLowerCase();
  return [...entries].sort((a, b) => (how === "recent" ? (b.added ?? "").localeCompare(a.added ?? "") : 0) || name(a).localeCompare(name(b)));
}

/**
 * The types on offer, commonest first, with how many carry each.
 *
 * A plugin's `categories` are the words its own author filed it under —
 * "review", "pull requests", "sandbox" — and they are what somebody looking
 * for a kind of plugin has in mind. `draws` is a different question (where it
 * appears) and it is in the search text instead, so typing "panel" finds one
 * without a second row of buttons for it.
 *
 * Counted over what is ON the shelf rather than over the whole document: a
 * filter offering "review (1)" that returns nothing because that one is
 * installed already is a filter that lies.
 */
export function types(entries: Entry[]): { name: string; count: number }[] {
  const n = new Map<string, number>();
  for (const e of entries) for (const c of e.categories ?? []) n.set(c, (n.get(c) ?? 0) + 1);
  return [...n].map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** The words a scope filter and a card use for what a plugin may do. */
export const SCOPE_LABEL: Record<DeviceScope, string> = { read: "reads only", answer: "can answer", full: "full access" };

/**
 * The shelf narrowed to one scope. An entry whose listing does not say what it asks for is left out when a
 * scope is picked: guessing "reads only" for it is the one mistake this filter must not make.
 */
export function byScope(entries: Entry[], scope: "any" | DeviceScope): Entry[] {
  return scope === "any" ? entries : entries.filter((e) => e.scope === scope);
}

/**
 * Keep the entries whose listing states this licence. An entry that states none is left out once a
 * licence is picked, for the same reason as a scope: never guessing "MIT" for a listing that is silent.
 */
export function byLicence(entries: Entry[], licence: string): Entry[] {
  return licence === "" ? entries : entries.filter((e) => e.license === licence);
}

/** The licences the shelf states, commonest first, so the filter offers only what could match. */
export function licencesOn(entries: Entry[]): string[] {
  const n = new Map<string, number>();
  for (const e of entries) if (e.license) n.set(e.license, (n.get(e.license) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([l]) => l);
}

/** The scopes the shelf states, so the filter offers only what could match. */
export function scopesOn(entries: Entry[]): DeviceScope[] {
  const have = new Set(entries.map((e) => e.scope));
  return (["read", "answer", "full"] as const).filter((s) => have.has(s));
}

/**
 * What a card says before anything is installed: the scope first, then where it draws, at most `max`
 * of them and the number left over, so a plugin that does six things has a card as tall as one that
 * does one.
 */
export function capabilityChips(entry: Pick<Entry, "scope" | "draws">, max = 3): { chips: { text: string; ok?: boolean }[]; more: number } {
  const all = [
    ...(entry.scope ? [{ text: SCOPE_LABEL[entry.scope], ok: entry.scope === "read" }] : []),
    ...(entry.draws ?? []).map((d) => ({ text: DRAWS_WORD[d] ?? d })),
  ];
  return { chips: all.slice(0, max), more: Math.max(0, all.length - max) };
}

/**
 * A plugin's own colour, stable across reads.
 *
 * The graph ramp, because it is the one set of hues in this palette that
 * means nothing — a plugin is not good, broken or careful, so `--success` and
 * the rest would be saying something untrue. Keyed on the id rather than on
 * position, so a market that gains an entry does not repaint every row under
 * it.
 */
export function tintOf(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `var(--graph-${(h % 8) + 1})`;
}

const COMMIT = /^[0-9a-f]{40}$/;

/**
 * What the market offers for one entry, given how the plugin from the same
 * repository is installed, if it is.
 *
 * Not installed is an install. Installed from the market at a commit other
 * than the one listed — or at no commit, from before listings were pinned — is
 * an update: a pinned install moves only by installing the listed version
 * again, and this is the one place that version is offered. Installed at the
 * listed commit is nothing. A plugin somebody installed from its own URL or a
 * folder is theirs; the market does not offer to replace it.
 */
export function offerFor(entry: Entry, have: InstallSource | null): "install" | "update" | null {
  if (!have) return "install";
  if (have.kind !== "marketplace") return null;
  const listed = entry.source.ref;
  if (!listed || !COMMIT.test(listed)) return null;
  // The same commit under another hash is a listing that changed its mind.
  if (have.plugin.ref !== listed) return "update";
  return entry.sha256 && have.plugin.sha256 && entry.sha256 !== have.plugin.sha256 ? "update" : null;
}

export function Market({ installed, onInstalled, onLoaded, onSettings }: {
  /** Told what the market listed, so the installed cards can say an update exists. */
  onLoaded?: (catalogue: Catalogue | null) => void;
  /** The installed plugin that came from this git source, or null. Passed in
   *  rather than imported, so this file and the page that renders it do not
   *  import each other. */
  installed: (gitUrl: string) => PublicPlugin | null;
  onInstalled: () => void;
  /** Opens that plugin's own settings inside the Plugins page. */
  onSettings?: (name: string) => void;
}) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [q, setQ] = useState("");
  const [type, setType] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>("recent");
  const [scope, setScope] = useState<"any" | DeviceScope>("any");
  const [licence, setLicence] = useState("");
  const [page, setPage] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  /* "/" jumps to the search, the way it does in the pull request list. Not Ctrl K: that is the palette, everywhere. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      e.preventDefault();
      search.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const r = await api.pluginCatalogueFetch(MARKET_URL);
    setState(r.ok ? { kind: "ok", catalogue: r.catalogue } : { kind: "error", error: r.error });
    onLoaded?.(r.ok ? r.catalogue : null);
  }, [onLoaded]);

  useEffect(() => { void load(); }, [load]);

  const all = state.kind === "ok" ? state.catalogue.plugins : [];
  const kinds = useMemo(() => types(all), [all]);
  const found = useMemo(() => {
    const byType = type ? all.filter((e) => (e.categories ?? []).includes(type)) : all;
    return sorted(matching(byLicence(byScope(byType, scope), licence), q), sort);
  }, [all, q, type, sort, scope, licence]);
  const scopes = useMemo(() => scopesOn(all), [all]);
  const licences = useMemo(() => licencesOn(all), [all]);
  // The four commonest types sit in the bar; the rest are one pick away, so no tag the listing has is out of reach.
  const bar = kinds.slice(0, BAR_TYPES);
  const rest = kinds.slice(BAR_TYPES);
  const pages = Math.max(1, Math.ceil(found.length / PAGE));
  const here = Math.min(page, pages - 1);
  const shown = found.slice(here * PAGE, here * PAGE + PAGE);

  const free = all.filter((e) => installed(e.source.url) === null).length;

  return (
    /* A section of the page like Installed above it, not a card holding cards:
       two borders between the eye and the text. Its listings are the same
       tiles, with what installing gets you read before it is installed. */
    <section aria-label="Market" className="mb-8">
      <PageHead title="Market" summary={state.kind === "ok" ? `${all.length} ${all.length === 1 ? "plugin" : "plugins"} · ${free} not installed` : undefined}>
        <RefreshButton onRefresh={() => void load()} busy={state.kind === "loading"} title="Refresh the market" />
      </PageHead>

      {/* Always here, never conditional on how long the list is: a search box
          that appears once a market grows past some number is a search box
          nobody learns is there. One row: the search, what the plugin may do,
          the order, and the types — the second half of "how do I find one": the
          box answers "the one that…", these answer "what is there for…". */}
      <div className="agx-mbar">
        <label className="agx-msearch">
          <SearchIcon size={ICON.sm} />
          <input ref={search} value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }}
            placeholder="Search plugins, words, publishers" aria-label="Search the market" spellCheck={false} className={INPUT} style={INPUT_STYLE} />
          <kbd aria-hidden>/</kbd>
        </label>
        <Select title="Scope" className={`${FIELD_SELECT} agx-mselect`} value={scope} onChange={(v) => { setScope(v as typeof scope); setPage(0); }}
          options={[
            { value: "any", label: "Any scope" },
            ...scopes.map((s) => ({ value: s, label: SCOPE_LABEL[s] })),
          ]} />
        <Select title="Licence" className={`${FIELD_SELECT} agx-mselect`} value={licence} onChange={(v) => { setLicence(v); setPage(0); }}
          options={[{ value: "", label: "Any licence" }, ...licences.map((l) => ({ value: l, label: l }))]} />
        <Select title="Sort the market" className={`${FIELD_SELECT} agx-mselect`} value={sort} onChange={(v) => { setSort(v as Sort); setPage(0); }}
          options={[{ value: "recent", label: "Recently added" }, { value: "name", label: "Name" }]} />
        <span className="flex-1" />
        {state.kind === "ok" && kinds.length > 1 && (
          <>
            <Segmented<string> track label="Filter by type" value={type ?? ""} onChange={(v) => { setType(v || null); setPage(0); }}
              options={[{ id: "", label: `All ${all.length}` }, ...bar.map((k) => ({ id: k.name, label: `${k.name} ${k.count}` }))]} />
            {rest.length > 0 && (
              <Select title="More types" className={`${FIELD_SELECT} agx-mselect`} value={rest.some((k) => k.name === type) ? type! : ""} placeholder={`${rest.length} more types`}
                onChange={(v) => { setType(v || null); setPage(0); }}
                options={rest.map((k) => ({ value: k.name, label: `${k.name} ${k.count}` }))} />
            )}
          </>
        )}
      </div>

      {state.kind === "loading" && <EmptyState><StatusBadge tone="checking">Checking</StatusBadge> Reading the market…</EmptyState>}

      {state.kind === "error" && (
        <EmptyState>
          <StatusBadge tone="err">Unreachable</StatusBadge> The market did not answer: {state.error}{" "}
          <Button onClick={() => void load()}>Try again</Button>
        </EmptyState>
      )}

      {state.kind === "ok" && shown.length > 0 && (
        <div className="agx-plugin-grid">
          {shown.map((entry) => {
            const have = installed(entry.source.url);
            const offer = offerFor(entry, have?.source ?? null);
            return (
              <Offer key={entry.id} entry={entry} owner={state.catalogue.owner} onInstalled={onInstalled}
                mode={offer ?? "installed"}
                was={have?.source.kind === "marketplace" ? have.source.plugin.ref : null}
                onSettings={have && (have.contributes?.settings?.length ?? 0) > 0 && onSettings ? () => onSettings(have.name) : undefined} />
            );
          })}
        </div>
      )}

      {state.kind === "ok" && found.length === 0 && (
        <EmptyState>{q.trim() || type || scope !== "any"
          ? `Nothing in the market matches ${[q.trim() && `“${q.trim()}”`, type && `“${type}”`, scope !== "any" && SCOPE_LABEL[scope]].filter(Boolean).join(" and ")}.`
          : "The market lists nothing yet."}</EmptyState>
      )}

      {state.kind === "ok" && pages > 1 && (
        <div className="flex items-center gap-2 mt-3">
          <span className="tabular-nums text-[12px] t-dim">{here + 1} of {pages}</span>
          <Button onClick={() => setPage(here - 1)} disabled={here === 0}>Previous</Button>
          <Button onClick={() => setPage(here + 1)} disabled={here >= pages - 1}>Next</Button>
        </div>
      )}

      {/* Where the list comes from and what it costs to look at it — the
          footnote of the section rather than a heading above it. */}
      {state.kind === "ok" && (
        <p className="agx-pnote">
          <InfoIcon size={ICON.sm} />
          <span>Read fresh from{" "}
          <a href={MARKET_PAGE} target="_blank" rel="noopener noreferrer"
            className="underline underline-offset-2 hover:opacity-80" style={{ color: "var(--text3)" }}>
            this project's plugin page
          </a>{" "}on <span className="t-mono">{MARKET_HOST}</span>.
          Nothing installs until you choose it, and a plugin you already have is marked, not hidden.
          {/* What the server kept back has to be said, or a market past the
              cap quietly becomes a shorter market. */}
          {state.catalogue.skipped > 0 && ` That page lists ${state.catalogue.total}; ${state.catalogue.skipped} could not be read.`}
          </span>
        </p>
      )}
    </section>
  );
}

/**
 * One plugin, as a row.
 *
 * A row and not a card, because the group it is in is already the card. It
 * reads across rather than down: what it is called and who publishes it,
 * where it will draw, then the sentence it describes itself with, with the
 * one button that does anything at the end of the line.
 */
export function Offer({ entry, owner, onInstalled, mode, was = null, onSettings }: {
  entry: Entry; owner: string; onInstalled: () => void;
  /** An update installs the listed version over the one on disk; settings
   *  are kept and a changed declaration asks again, as any install does.
   *  `installed` is a plugin that has this one already: marked, not hidden. */
  mode: "install" | "update" | "installed";
  /** The commit installed now, for an update. */
  was?: string | null;
  /** Opens its settings, for an installed plugin that has a page of them. */
  onSettings?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const install = async () => {
    setBusy(true);
    setError(null);
    const r = await api.pluginInstallFromCatalogue(MARKET_URL, entry.id);
    setBusy(false);
    if (r.ok) { setOpen(false); onInstalled(); }
    else setError(r.error);
  };

  const caps = capabilityChips(entry);
  const repo = externalUrl(entry.source.url);
  const tint = tintOf(entry.id);
  const ref = entry.source.ref;
  const commit = ref && COMMIT.test(ref) ? ref : null;
  const title = entry.title || entry.id;
  const initial = title.trim().charAt(0).toUpperCase();
  // A link to the tree at that commit only where the host's URL shape is known.
  const at = repo && commit && /^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(repo.replace(/\.git$/, "")) ? `${repo.replace(/\.git$/, "")}/tree/${commit}` : repo;

  return (
    <>
    {/* A tile, the same tokens as an installed card: its picture, who and what
        it is, where it draws, what it is pinned to, and one filled button at
        the bottom of every card. */}
    <article className="flex flex-col min-w-0 rounded-xl overflow-hidden"
      style={{ background: "var(--surface-card)", border: LINE, boxShadow: "var(--surface-lift)" }}>
      <PluginPreview src={entry.preview} name={title} tint={tint}>
        <span aria-hidden className="grid place-items-center rounded-xl text-[28px] font-semibold" style={{
          width: 72, height: 72, color: tint,
          background: `color-mix(in srgb, ${tint} 15%, transparent)`,
          border: `1px solid color-mix(in srgb, ${tint} 32%, transparent)`,
        }}>{initial}</span>
      </PluginPreview>
      <div className="flex flex-col gap-3 p-4 flex-1 min-w-0">
      <div className="flex items-center gap-3 min-w-0">
        <span aria-hidden className="agx-market-tile shrink-0 grid place-items-center rounded-lg text-[15px] font-semibold" style={{
          width: 36, height: 36, color: tint,
          background: `color-mix(in srgb, ${tint} 15%, transparent)`,
          border: `1px solid color-mix(in srgb, ${tint} 32%, transparent)`,
        }}>{initial}</span>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold break-words" style={{ color: "var(--text)" }}>{title}</div>
          <div className="text-[11.5px] t-dim break-words">by {entry.publisher || owner}</div>
        </div>
        {mode === "installed" && <StatusBadge tone="ok">Installed</StatusBadge>}
        {mode === "update" && <StatusBadge tone="warn">Update available</StatusBadge>}
      </div>
      <p className="m-0 text-[12.5px] leading-snug" style={{ color: "var(--text2)", display: "-webkit-box", WebkitLineClamp: 4, WebkitBoxOrient: "vertical", overflow: "hidden" }}
        title={entry.description}>{entry.description}</p>
      {/* Plain tags, not seven chips on two rows: every one of those chips
          was the same weight as the plugin's name. Three at most, then "+N more". */}
      {(caps.chips.length > 0) && (
        <div className="flex flex-wrap gap-1.5">
          {caps.chips.map((c) => (
            <span key={c.text} className="text-[10.5px] px-1.5 rounded-md inline-flex items-center whitespace-nowrap"
              style={{ height: 20, color: c.ok ? "var(--success-ink)" : "var(--text2)", border: c.ok ? tintEdge("var(--success)", 45) : EDGE,
                background: c.ok ? "color-mix(in srgb, var(--success) 10%, transparent)" : undefined }}>{c.text}</span>
          ))}
          {caps.more > 0 && <span className="text-[10.5px] inline-flex items-center t-dim" style={{ height: 20 }} title={[...(entry.scope ? [SCOPE_LABEL[entry.scope]] : []), ...(entry.draws ?? []).map((d) => DRAWS_WORD[d] ?? d)].join(", ")}>+{caps.more} more</span>}
        </div>
      )}
      {(ref || entry.sha256) && (
        <div className="flex items-center gap-2 px-3 rounded-lg min-w-0 text-[11px]" style={{ minHeight: 30, background: "var(--surface-inset)", border: EDGE, color: "var(--text2)" }}>
          {/* Filled when the listing names bytes (a hash the install holds the tree to), hollow when it names only a pointer. */}
          <span aria-hidden className="agx-pin-dot shrink-0" data-pinned={entry.sha256 ? "true" : undefined}
            title={entry.sha256 ? "The install refuses files that do not hash to this listing" : "Not pinned to a content hash"} />
          {ref && <span className="t-mono shrink-0" style={{ color: "var(--text)" }} title={ref}>{commit ? commit.slice(0, 7) : ref}</span>}
          {entry.sha256 && <span className="t-mono truncate" title={entry.sha256}>sha256 {entry.sha256.slice(0, 12)}…</span>}
          <span className="flex-1" />
          {entry.license && <span className="shrink-0" title="Licence, as the listing states it">{entry.license}</span>}
        </div>
      )}
      <div className="flex items-center gap-x-3 gap-y-1 flex-wrap text-[11.5px] t-dim">
        {at && <a href={at} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:opacity-80 inline-flex items-center gap-1" style={{ color: "var(--primary-ink)" }}>
          {commit ? "Source at this commit" : "Source"} <ExternalIcon size={ICON.xs} />
        </a>}
        {entry.added && <span>listed {entry.added}</span>}
      </div>
      {mode === "update" && (
        <p className="m-0 text-[11.5px] leading-snug t-dim">
          Installed at <span className="t-mono">{was ? was.slice(0, 7) : "its default branch"}</span>; the market lists{" "}
          <span className="t-mono">{(entry.source.ref ?? "").slice(0, 7)}</span>. Updating installs the listed version,
          and asks again if what it declares has changed.
        </p>
      )}
      {error && <p className="m-0 text-[11.5px]" style={{ color: "var(--error-ink)" }}>{error}</p>}
      <div className="flex items-center gap-2 mt-auto pt-0.5">
        <span className="flex-1" />
        <button type="button" className="agx-linkbtn" onClick={() => setOpen(true)}>Read the listing</button>
        {mode !== "installed" && (
          <Button tone="primary" style={{ height: PLUGIN_CTRL_H }} pending={busy} onClick={install}>
            {busy ? (mode === "update" ? "Updating…" : "Installing…") : (mode === "update" ? "Update" : "Install")}
          </Button>
        )}
        {onSettings && <Button style={{ height: PLUGIN_CTRL_H }} onClick={onSettings}>Settings</Button>}
      </div>
      </div>
    </article>
    <Details entry={entry} owner={owner} tint={tint} repo={repo} open={open} busy={busy}
      onClose={() => setOpen(false)} onInstall={mode === "installed" ? null : install} />
    </>
  );
}

/**
 * Everything the list had to leave out, without leaving the page.
 *
 * The row can hold two lines of a description and the words for where a
 * plugin draws; a catalogue entry carries more than that — the whole
 * sentence, its categories, the exact git source and the ref it is pinned to,
 * and whether it needs a newer app than this one. Sending somebody to GitHub
 * to read what is already in hand is a page giving up.
 *
 * The repository link lives here rather than on the row: it is the one thing
 * that leaves the app, and a row with three buttons on it makes the one that
 * installs harder to find.
 */
function Details({ entry, owner, tint, repo, open, busy, onClose, onInstall }: {
  entry: Entry; owner: string; tint: string; repo: string | undefined;
  open: boolean; busy: boolean; onClose: () => void;
  /** Null for a plugin that is installed already: reading it is all the dialog offers. */
  onInstall: (() => void) | null;
}) {
  // Captured, so Escape closes this and not the settings sheet underneath —
  // which listens on the same window in the bubble phase.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!open) return null;
  const draws = (entry.draws ?? []).map((d) => DRAWS_WORD[d] ?? d);

  return (
    <Portal z={LAYER.settingsDialog}>
      <div className="fixed inset-0 agx-scrim" onClick={onClose} />
      <div className="fixed inset-0 flex items-center justify-center p-4 pointer-events-none">
        <div role="dialog" aria-modal="true" aria-label={entry.title || entry.id}
          className="w-[620px] max-w-[95vw] rounded-xl flex flex-col pointer-events-auto overflow-hidden"
          style={{ maxHeight: "min(78vh, 620px)", background: "var(--surface-card)", border: EDGE, boxShadow: "0 30px 80px -20px rgba(0,0,0,0.8)" }}>

          <div className="flex items-center gap-3 px-5 py-4 border-b shrink-0" style={{ borderColor: "var(--surface-line)" }}>
            <span className="shrink-0 grid place-items-center rounded-lg text-[15px] font-semibold" style={{
              width: 36, height: 36, color: tint,
              background: `color-mix(in srgb, ${tint} 15%, transparent)`,
              border: `1px solid color-mix(in srgb, ${tint} 32%, transparent)`,
            }}>{(entry.title || entry.id).trim().charAt(0).toUpperCase()}</span>
            <span className="min-w-0">
              <span className="block text-[14px] font-semibold" style={{ color: "var(--text)", overflowWrap: "anywhere" }}>{entry.title || entry.id}</span>
              <span className="block text-[11.5px] t-dim">by {entry.publisher || owner}</span>
            </span>
            <CloseButton onClick={onClose} title="Close" className="ml-auto" />
          </div>

          <div className="px-5 py-4 overflow-y-auto agx-scroll flex flex-col gap-4">
            <p className="m-0 text-[12.5px] leading-relaxed" style={{ color: "var(--text2)" }}>{entry.description}</p>

            {draws.length > 0 && (
              <Fact label="Where it draws">
                <div className="flex flex-col gap-1">
                  {draws.map((d) => <span key={d} className="text-[12px]" style={{ color: "var(--text2)" }}>{d}</span>)}
                </div>
              </Fact>
            )}

            {(entry.categories ?? []).length > 0 && (
              <Fact label="Filed under">
                <div className="flex items-center gap-1 flex-wrap">
                  {(entry.categories ?? []).map((c) => (
                    <Badge key={c} tint="var(--text3)" fill="var(--border)" wash={16} outlined>{c}</Badge>
                  ))}
                </div>
              </Fact>
            )}

            {(entry.scope || entry.license) && (
              <Fact label="Scope and licence">
                <span className="text-[12px]" style={{ color: "var(--text2)" }}>
                  {[entry.scope && `${SCOPE_LABEL[entry.scope]}, as its listing says`, entry.license && `licence ${entry.license}`].filter(Boolean).join(" · ")}
                </span>
              </Fact>
            )}

            <WhatIsCloned entry={entry} />

            {(entry.added || entry.minApp) && (
              <Fact label="Listed">
                <span className="text-[12px]" style={{ color: "var(--text2)" }}>
                  {entry.added ?? "date not given"}
                  {entry.minApp ? ` · needs agentglass ${entry.minApp} or newer` : ""}
                </span>
              </Fact>
            )}
          </div>

          <div className="px-5 py-3 border-t shrink-0 flex items-center gap-2" style={{ borderColor: "var(--surface-line)" }}>
            {repo && (
              <Button href={repo} title={repo}>
                Repository <ExternalIcon size={ICON.xs} />
              </Button>
            )}
            {onInstall && <Button tone="primary" style={{ height: PLUGIN_CTRL_H }} className="ml-auto" pending={busy} onClick={onInstall}>
              {busy ? "Installing…" : "Install"}
            </Button>}
          </div>
        </div>
      </div>
    </Portal>
  );
}

/**
 * The sentence the install acts on: a name in a list is not what lands on the
 * disk, the repository at a ref is.
 *
 * A commit is printed short, as git prints one, with all forty characters in
 * the title — the short form is what a person compares against a repository
 * page, and the full one is there for the person who wants to be sure. It is
 * the only kind of ref that names bytes; a branch or a tag is a pointer its
 * author can move, and the line under it says which of the two this is. When
 * the entry also carries a content hash, the install refuses a tree that does
 * not match it, and that is said too — only then, because a promise the
 * server does not keep is worse than none.
 *
 * Exported for the test, which renders it: there is no renderer in this
 * project, and the dialog it sits in is a portal that draws nothing without
 * a document.
 */
export function WhatIsCloned({ entry }: { entry: Entry }) {
  const ref = entry.source.ref;
  const commit = ref !== null && /^[0-9a-f]{40}$/.test(ref);
  return (
    <Fact label="What is cloned">
      <span className="t-mono text-[11.5px] break-all" style={{ color: "var(--text2)" }}>
        {entry.source.url}
        {commit ? <> at <span title={ref}>{ref.slice(0, 7)}</span></> : ref ? `@${ref}` : ""}
      </span>
      <span className="block text-[11px] t-dim mt-1">
        {commit
          ? entry.sha256
            ? "Pinned to that commit. The install refuses any files that do not hash to what this list says, so a push after the listing does not reach you. A newer version arrives the same way: the market lists it, and you install it again from here."
            : "Pinned to that commit."
          : ref
            ? "A branch or a tag, which its author can move: you get whatever it points to when you press Install."
            : "Its default branch, at whatever it points to when you press Install."}
      </span>
    </Fact>
  );
}

/** A labelled read-only block inside the dialog (no control, so not the kit's `Field`, whose label names one). The label is the eyebrow this page uses
 *  everywhere else, at the size a sub-label has rather than a heading. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[.12em] mb-1.5" style={{ color: "var(--text4)" }}>{label}</div>
      {children}
    </div>
  );
}
