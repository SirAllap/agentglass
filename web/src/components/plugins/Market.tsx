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
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../../lib/api.ts";
import { ICON } from "../../lib/iconSize.ts";
import { externalUrl } from "../../lib/externalUrl.ts";
import { ExternalIcon } from "../browser/icons.tsx";
import { Portal } from "../Portal.tsx";
import { CloseButton } from "../CloseButton.tsx";
import { LAYER } from "../../lib/layers.ts";
import type { Catalogue } from "../../../../shared/types.ts";

/** The list this project publishes, on its own site, and the same document
 *  its plugins page is drawn from. */
export const MARKET_URL = "https://sirallap.github.io/agentglass/plugins.json";
const MARKET_HOST = new URL(MARKET_URL).host;
/** The same list as a page a person can read, with the prose the JSON has no
 *  room for. There is no per-plugin page on it yet, so a row's own link goes
 *  to the repository instead — see `Offer`. */
const MARKET_PAGE = "https://sirallap.github.io/agentglass/#/plugins";

/** The manifest's own words for where a plugin draws. A card says what
 *  installing gets you before it is installed. */
const DRAWS_WORD: Record<string, string> = {
  panel: "adds a panel", panels: "adds a panel",
  settings: "settings page",
  "pr-notes": "notes in pull requests", prNotes: "notes in pull requests",
  "pr-button": "a button in pull requests", prActions: "a button in pull requests",
};

/** Cards drawn at once. The list is short today and the server keeps the
 *  first five hundred entries of whatever the document holds — a market that
 *  grew to that is two dozen cards and a pager, not five hundred cards with
 *  their own state laid out on the thread the settings page scrolls on. */
const PAGE = 24;

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

export function Market({ installed, onInstalled }: {
  /** Is this git source already on disk? Passed in rather than imported, so
   *  this file and the page that renders it do not import each other. */
  installed: (gitUrl: string) => boolean;
  onInstalled: () => void;
}) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [q, setQ] = useState("");
  const [type, setType] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const r = await api.pluginCatalogueFetch(MARKET_URL);
    setState(r.ok ? { kind: "ok", catalogue: r.catalogue } : { kind: "error", error: r.error });
  }, []);

  useEffect(() => { void load(); }, [load]);

  const all = state.kind === "ok" ? state.catalogue.plugins : [];
  const offered = useMemo(() => all.filter((e) => !installed(e.source.url)), [all, installed]);
  const kinds = useMemo(() => types(offered), [offered]);
  const found = useMemo(() => {
    const byType = type ? offered.filter((e) => (e.categories ?? []).includes(type)) : offered;
    return matching(byType, q);
  }, [offered, q, type]);
  const pages = Math.max(1, Math.ceil(found.length / PAGE));
  const here = Math.min(page, pages - 1);
  const shown = found.slice(here * PAGE, here * PAGE + PAGE);

  const have = all.length - offered.length;

  return (
    /*
     * A settings GROUP, drawn the way every other group on this page is: the
     * card is the section, the heading sits inside it above a rule, and the
     * plugins are rows separated by hairlines.
     *
     * The first version put bordered cards inside the bordered section, which
     * index.css names as the thing that makes a settings page look amateur —
     * "two borders between the eye and the text" — and with one plugin
     * published it also left a 460px card floating in a 1900px box.
     */
    <div className="agx-settings-section agx-market">
      <div className="panel-eyebrow flex items-center gap-2.5 flex-wrap">
        Market
        {state.kind === "ok" && <span className="chip tabular-nums t-dim">{offered.length}</span>}
        <div className="ml-auto flex items-center gap-2">
          {/* Always here, never conditional on how long the list is: a search
              box that appears once a market grows past some number is a search
              box nobody learns is there. */}
          <input value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }}
            placeholder="Search the market" spellCheck={false}
            className="w-[190px] px-2.5 py-1.5 rounded-lg text-[12.5px] outline-none"
            style={{ background: "var(--bg)", border: "1px solid var(--surface-line)", color: "var(--text)" }} />
          <button onClick={() => void load()} disabled={state.kind === "loading"}
            className="text-[12px] font-normal px-2.5 py-1.5 rounded-lg whitespace-nowrap hover:opacity-80 disabled:opacity-50"
            style={{ color: "var(--text2)", border: "1px solid var(--surface-line)" }}>
            {state.kind === "loading" ? "Reading…" : "Refresh"}
          </button>
        </div>
      </div>

      <div className="agx-settings-rows">
        {/* The types, as a row of their own above the list — the second half
            of "how do I find one": the box answers "the one that…", these
            answer "what is there for…". Counted, so a row of them says how
            big the market is per kind before anything is pressed. */}
        {state.kind === "ok" && kinds.length > 1 && (
          <div className="agx-settings-gutter py-3 flex items-center gap-1.5 flex-wrap">
            <TypeChip on={type === null} onClick={() => { setType(null); setPage(0); }}
              label="All" count={offered.length} />
            {kinds.map((k) => (
              <TypeChip key={k.name} on={type === k.name}
                onClick={() => { setType(type === k.name ? null : k.name); setPage(0); }}
                label={k.name} count={k.count} />
            ))}
          </div>
        )}

        {state.kind === "loading" && (
          <div className="agx-settings-gutter py-5 text-[12px] t-dim">Reading the market…</div>
        )}

        {state.kind === "error" && (
          <div className="agx-settings-gutter py-4 text-[12px] flex items-center gap-3 flex-wrap">
            <span style={{ color: "var(--text2)" }}>The market did not answer: {state.error}</span>
            <button onClick={() => void load()}
              className="ml-auto text-[12px] px-2.5 py-1 rounded-lg hover:opacity-80"
              style={{ color: "var(--text)", border: "1px solid var(--surface-line)" }}>Try again</button>
          </div>
        )}

        {state.kind === "ok" && shown.map((entry) => (
          <Offer key={entry.id} entry={entry} owner={state.catalogue.owner} onInstalled={onInstalled} />
        ))}

        {state.kind === "ok" && found.length === 0 && (
          <div className="agx-settings-gutter py-5 text-[12px] t-dim">
            {q.trim() || type
              ? `Nothing in the market matches ${[q.trim() && `“${q.trim()}”`, type && `“${type}”`].filter(Boolean).join(" and ")}.`
              : all.length === 0 ? "The market lists nothing yet."
                : "Everything in the market is installed."}
          </div>
        )}

        {state.kind === "ok" && pages > 1 && (
          <div className="agx-settings-gutter py-3 flex items-center justify-center gap-2 text-[11.5px]">
            <button onClick={() => setPage(here - 1)} disabled={here === 0}
              className="px-2 py-0.5 rounded-lg disabled:opacity-40 hover:opacity-80"
              style={{ color: "var(--text2)", border: "1px solid var(--surface-line)" }}>Previous</button>
            <span className="t-dim tabular-nums">{here + 1} of {pages}</span>
            <button onClick={() => setPage(here + 1)} disabled={here >= pages - 1}
              className="px-2 py-0.5 rounded-lg disabled:opacity-40 hover:opacity-80"
              style={{ color: "var(--text2)", border: "1px solid var(--surface-line)" }}>Next</button>
          </div>
        )}

        {/* Where the list comes from and what it costs to look at it — the
            footnote of the group rather than a heading above it, because it
            is the answer to a question asked once. */}
        {state.kind === "ok" && (
          <div className="agx-settings-gutter py-3 text-[11.5px] t-dim">
            Read fresh from{" "}
            <a href={MARKET_PAGE} target="_blank" rel="noopener noreferrer"
              className="underline underline-offset-2 hover:opacity-80" style={{ color: "var(--text3)" }}>
              this project's plugin page
            </a>{" "}on <span className="t-mono">{MARKET_HOST}</span>.
            Nothing installs until you choose it{have > 0 ? `, and ${have} already installed ${have === 1 ? "is" : "are"} left out of this list` : ""}.
            {/* What the server kept back has to be said, or a market past the
                cap quietly becomes a shorter market. */}
            {state.catalogue.total > all.length && ` That page lists ${state.catalogue.total}; the first ${all.length} were read.`}
          </div>
        )}
      </div>
    </div>
  );
}

/** One type on the filter row. A button, not a label: the whole thing is the
 *  hit area, and the count is inside it so the pair never wraps apart. */
function TypeChip({ label, count, on, onClick }: { label: string; count: number; on: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} aria-pressed={on}
      className="text-[11.5px] px-2.5 py-1 rounded-full whitespace-nowrap hover:opacity-80 flex items-center gap-1.5"
      style={on
        ? { color: "var(--primary)", background: "color-mix(in srgb, var(--primary) 14%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 40%, transparent)" }
        : { color: "var(--text2)", background: "transparent", border: "1px solid var(--surface-line)" }}>
      {label}
      <span className="tabular-nums" style={{ color: on ? "var(--primary)" : "var(--text4)" }}>{count}</span>
    </button>
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
export function Offer({ entry, owner, onInstalled }: { entry: Entry; owner: string; onInstalled: () => void }) {
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

  const draws = (entry.draws ?? []).map((d) => DRAWS_WORD[d] ?? d);
  const repo = externalUrl(entry.source.url);
  const tint = tintOf(entry.id);

  return (
    <div className="agx-market-row agx-settings-gutter py-4 flex items-center gap-4">
      {/* Its initial, not the same puzzle eight times: a list of things to
          pick from needs its rows to be told apart at a glance, and the one
          piece of identity a catalogue entry carries is its name. */}
      <span className="agx-market-tile shrink-0 grid place-items-center rounded-[10px] text-[15px] font-semibold" style={{
        width: 36, height: 36, color: tint,
        background: `color-mix(in srgb, ${tint} 15%, transparent)`,
        border: `1px solid color-mix(in srgb, ${tint} 32%, transparent)`,
      }}>{(entry.title || entry.id).trim().charAt(0).toUpperCase()}</span>

      {/* A measure, like the rest of the settings column has: a description
          set to the full width of a 1500px window is one line of eleven words
          and one of ninety, and the eye loses the start of the next line. */}
      <div className="min-w-0 flex-1" style={{ maxWidth: "88ch" }}>
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-[13.5px] font-medium" style={{ color: "var(--text)" }}>{entry.title || entry.id}</span>
          <span className="text-[11.5px] t-dim">by {entry.publisher || owner}</span>
        </div>
        {/* Two lines of the plugin's own sentence. The whole of it is on its
            page once it is installed, and a market row that runs to eight
            lines is a market you scroll rather than read. */}
        <p className="m-0 mt-1.5 text-[12px] leading-relaxed" style={{
          color: "var(--text2)", display: "-webkit-box", WebkitBoxOrient: "vertical",
          WebkitLineClamp: 2, overflow: "hidden",
        }}>{entry.description}</p>
        {draws.length > 0 && (
          /* Plain dim text with middots, not seven chips on two rows: every
             one of those chips was the same weight as the plugin's name. */
          <div className="mt-2 text-[11.5px] t-dim">{draws.join(" · ")}</div>
        )}
        {error && <div className="mt-2 text-[11.5px]" style={{ color: "var(--error)" }}>{error}</div>}
      </div>

      <div className="shrink-0 flex items-center gap-2">
        <button onClick={() => setOpen(true)}
          className="text-[12px] px-3 py-1.5 rounded-lg whitespace-nowrap hover:opacity-80"
          style={{ color: "var(--text2)", border: "1px solid var(--surface-line)" }}>
          Details
        </button>
        <button onClick={install} disabled={busy}
          className="text-[12px] px-3 py-1.5 rounded-lg whitespace-nowrap hover:opacity-80 disabled:opacity-50 font-medium"
          style={{ color: "var(--bg)", background: "var(--primary)" }}>
          {busy ? "Installing…" : "Install"}
        </button>
      </div>

      <Details entry={entry} owner={owner} tint={tint} repo={repo} open={open} busy={busy}
        onClose={() => setOpen(false)} onInstall={install} />
    </div>
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
  open: boolean; busy: boolean; onClose: () => void; onInstall: () => void;
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
          className="w-[620px] max-w-[95vw] rounded-2xl flex flex-col pointer-events-auto overflow-hidden"
          style={{ maxHeight: "min(78vh, 620px)", background: "var(--bg2)", border: "1px solid var(--surface-line)", boxShadow: "0 30px 80px -20px rgba(0,0,0,0.8)" }}>

          <div className="flex items-center gap-3 px-5 py-4 border-b shrink-0" style={{ borderColor: "var(--surface-line)" }}>
            <span className="shrink-0 grid place-items-center rounded-[10px] text-[15px] font-semibold" style={{
              width: 36, height: 36, color: tint,
              background: `color-mix(in srgb, ${tint} 15%, transparent)`,
              border: `1px solid color-mix(in srgb, ${tint} 32%, transparent)`,
            }}>{(entry.title || entry.id).trim().charAt(0).toUpperCase()}</span>
            <span className="min-w-0">
              <span className="block text-[14px] font-semibold truncate" style={{ color: "var(--text)" }}>{entry.title || entry.id}</span>
              <span className="block text-[11.5px] t-dim">by {entry.publisher || owner}</span>
            </span>
            <CloseButton onClick={onClose} title="Close" className="ml-auto" />
          </div>

          <div className="px-5 py-4 overflow-y-auto agx-scroll flex flex-col gap-4">
            <p className="m-0 text-[12.5px] leading-relaxed" style={{ color: "var(--text2)" }}>{entry.description}</p>

            {draws.length > 0 && (
              <Field label="Where it draws">
                <div className="flex flex-col gap-1">
                  {draws.map((d) => <span key={d} className="text-[12px]" style={{ color: "var(--text2)" }}>{d}</span>)}
                </div>
              </Field>
            )}

            {(entry.categories ?? []).length > 0 && (
              <Field label="Filed under">
                <div className="flex items-center gap-1 flex-wrap">
                  {(entry.categories ?? []).map((c) => (
                    <span key={c} className="chip text-[10px]" style={{
                      color: "var(--text3)",
                      background: "color-mix(in srgb, var(--border) 16%, transparent)",
                      borderColor: "color-mix(in srgb, var(--border) 40%, transparent)",
                    }}>{c}</span>
                  ))}
                </div>
              </Field>
            )}

            <WhatIsCloned entry={entry} />

            {(entry.added || entry.minApp) && (
              <Field label="Listed">
                <span className="text-[12px]" style={{ color: "var(--text2)" }}>
                  {entry.added ?? "date not given"}
                  {entry.minApp ? ` · needs agentglass ${entry.minApp} or newer` : ""}
                </span>
              </Field>
            )}
          </div>

          <div className="px-5 py-3 border-t shrink-0 flex items-center gap-2" style={{ borderColor: "var(--surface-line)" }}>
            {repo && (
              <a href={repo} target="_blank" rel="noopener noreferrer" title={repo}
                className="text-[12px] px-3 py-1.5 rounded-lg whitespace-nowrap hover:opacity-80 inline-flex items-center gap-1.5"
                style={{ color: "var(--text2)", border: "1px solid var(--surface-line)" }}>
                Repository <ExternalIcon size={ICON.xs} />
              </a>
            )}
            <button onClick={onInstall} disabled={busy}
              className="ml-auto text-[12px] px-3 py-1.5 rounded-lg whitespace-nowrap hover:opacity-80 disabled:opacity-50 font-medium"
              style={{ color: "var(--bg)", background: "var(--primary)" }}>
              {busy ? "Installing…" : "Install"}
            </button>
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
    <Field label="What is cloned">
      <span className="t-mono text-[11.5px] break-all" style={{ color: "var(--text2)" }}>
        {entry.source.url}
        {commit ? <> at <span title={ref}>{ref.slice(0, 7)}</span></> : ref ? `@${ref}` : ""}
      </span>
      <span className="block text-[11px] t-dim mt-1">
        {commit
          ? entry.sha256
            ? "Pinned to that commit. The install refuses any files that do not hash to what this list says, so a push after the listing does not reach you."
            : "Pinned to that commit."
          : ref
            ? "A branch or a tag, which its author can move: you get whatever it points to when you press Install."
            : "Its default branch, at whatever it points to when you press Install."}
      </span>
    </Field>
  );
}

/** A labelled block inside the dialog. The label is the eyebrow this page uses
 *  everywhere else, at the size a sub-label has rather than a heading. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[.12em] mb-1.5" style={{ color: "var(--text4)" }}>{label}</div>
      {children}
    </div>
  );
}
