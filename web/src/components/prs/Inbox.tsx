/*
 * GitHub's notification inbox, in the pull-request panel.
 *
 * The board answers a question about STATE — what is blocked, what is green,
 * what can land. This answers "what happened while I was away", which is the
 * only question that can be about a mention in a comment, a review somebody
 * asked for an hour ago, or an issue that is not a pull request at all. Both
 * are needed and neither replaces the other.
 *
 * Laid out like GitHub's own because it is a list people already know how to
 * read: shelves on the left, named filters under them, All / Unread and a
 * search across the top, and a row per thread with a checkbox for the bulk
 * actions. Two differences, both deliberate:
 *
 *   * It opens filtered to the repository the panel is showing. This app is one
 *     repository at a time; an inbox that starts with four repositories in it
 *     asks you to narrow before you can read.
 *   * Saved and Done are OURS. GitHub's REST API has read, unread, unsubscribe
 *     and mark-a-repository-read; the two shelves are the new web inbox's own
 *     state with nothing published to reach them (measured). So they are kept
 *     on this machine — see inboxMarks.ts — rather than left out and sending
 *     somebody to a browser for them.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { InboxItem } from "../../../../shared/types.ts";
import { api } from "../../lib/api.ts";
import { byDay, facetCounts, facetOrder, FACETS, filterInbox, inFacet, reasonLabel, searchInbox } from "../../lib/ghInbox.ts";
import { doneIds, isDone, isSaved, onShelf, savedIds, setDone, setSaved, subscribeMarks, type Shelf } from "../../lib/inboxMarks.ts";
import { fmtAgo } from "../../lib/format.ts";
import { openPr } from "../../lib/openPrs.ts";
import { useDialogs } from "../ConfirmDialog.tsx";
import { openIssue } from "../../lib/openIssue.ts";
import { Spinner } from "../Spinner.tsx";
import { ICON } from "../../lib/iconSize.ts";

const edge = (pct: number) => `1px solid color-mix(in srgb, var(--text) ${pct}%, transparent)`;

/** A pull request, an issue, or something with no page of its own here. */
function Kind({ type }: { type: string }) {
  const pr = type === "PullRequest";
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden
      style={{ color: pr ? "var(--primary)" : "var(--success, #98c379)" }}>
      {pr
        ? <><circle cx="6" cy="6" r="2.4" /><circle cx="6" cy="18" r="2.4" /><circle cx="18" cy="18" r="2.4" /><path d="M6 8.4v7.2M8.4 6H14a4 4 0 0 1 4 4v5.6" /></>
        : <><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></>}
    </svg>
  );
}

function Tick({ on }: { on: boolean }) {
  return (
    <span className="grid place-items-center rounded shrink-0"
      style={{ width: 16, height: 16, border: `1px solid color-mix(in srgb, var(--text) ${on ? 0 : 26}%, transparent)`, background: on ? "var(--primary)" : "transparent" }}>
      {on && (
        /* ICON.xs is the floor for a stroked glyph, tick included. */
        <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 24 24" fill="none" stroke="var(--bg)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M4 12l5 5L20 6" />
        </svg>
      )}
    </span>
  );
}

/** One control in the shelf rail or the filter list. */
function Rail({ mark, label, n, on, hint, onClick }: {
  mark: string; label: string; n?: number; on: boolean; hint: string; onClick: () => void;
}) {
  return (
    <button onClick={onClick} title={hint} aria-pressed={on}
      className="agx-btn w-full flex items-center gap-2 rounded-md px-2 py-1 text-[11px]"
      style={{
        color: on ? "var(--text)" : "var(--text2)",
        background: on ? "color-mix(in srgb, var(--text) 8%, transparent)" : "transparent",
        boxShadow: on ? "inset 2px 0 0 var(--primary)" : undefined,
      }}>
      <span aria-hidden className="shrink-0 text-[12px] leading-none" style={{ width: 14 }}>{mark}</span>
      <span className="truncate flex-1 text-left">{label}</span>
      {n != null && n > 0 && (
        <span className="tabular-nums text-[10px] px-1.5 rounded-full shrink-0"
          style={{ color: "var(--text3)", background: "color-mix(in srgb, var(--text) 10%, transparent)" }}>{n}</span>
      )}
    </button>
  );
}

export function Inbox({ repo, onFlash, onUnread }: {
  /** The repository the panel is showing, which is what this opens filtered to. */
  repo: string;
  onFlash?: (ok: boolean, text: string) => void;
  /** How many are unread in THIS repository, for the pill that opened this —
   *  the only number the panel shows before the inbox is on screen. */
  onUnread?: (n: number) => void;
}) {
  /* The app's own dialog, not the browser's — see no-native-dialogs.test.ts.
     This one had a `window.confirm` and the lint could not see it: its
     lookbehind skipped every receiver including `window`. */
  const { ask, dialog } = useDialogs();
  const [raw, setRaw] = useState<InboxItem[] | null>(null);
  const [err, setErr] = useState("");
  const [at, setAt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [shelf, setShelf] = useState<Shelf>("inbox");
  const [facet, setFacet] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [q, setQ] = useState("");
  const [newest, setNewest] = useState(true);
  const [allRepos, setAllRepos] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  /* The local shelves are a store outside React — two other windows can move
     them — so the list subscribes rather than copying them into state. */
  const marksTick = useSyncExternalStore(subscribeMarks, () => `${savedIds().length}:${doneIds().length}`, () => "0:0");

  const load = useCallback((force = false) => {
    setBusy(true);
    void api.prsInbox(force)
      .then((r) => {
        setRaw(r.items ?? []);
        setAt(r.at ?? Date.now());
        setErr(r.ok ? (r.error ?? "") : (r.error ?? "GitHub did not answer"));
      })
      .catch(() => setErr("Could not reach the server"))
      .finally(() => setBusy(false));
  }, []);

  useEffect(() => { load(); }, [load]);
  /* Polled while it is on screen, at GitHub's own asking distance for this
     endpoint. The server caches under it, so several windows cost one call. */
  useEffect(() => {
    const timer = setInterval(() => load(), 60_000);
    return () => clearInterval(timer);
  }, [load]);

  const all = raw ?? [];
  /** Everything on this shelf, in this repository unless asked otherwise. Every
   *  count below is computed from here, so a chip says what pressing it does. */
  const shelved = useMemo(
    () => onShelf(all, shelf).filter((n) => allRepos || !repo || n.repo === repo),
    // marksTick: the shelves are outside React and this is what says they moved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [all, shelf, allRepos, repo, marksTick],
  );
  const facetCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of FACETS) m.set(f.id, shelved.filter((n) => (unreadOnly ? n.unread : true) && inFacet(n, f.id)).length);
    return m;
  }, [shelved, unreadOnly]);

  const rows = useMemo(() => {
    const list = searchInbox(
      filterInbox(shelved, { unread: unreadOnly }).filter((n) => !facet || inFacet(n, facet)),
      q,
    );
    return [...list].sort((a, b) => (newest ? b.at - a.at : a.at - b.at));
  }, [shelved, unreadOnly, facet, q, newest]);

  const repoCounts = useMemo(() => facetOrder(facetCounts(onShelf(all, shelf), {}, "repo")), [all, shelf, marksTick]);
  const unread = shelved.filter((n) => n.unread).length;
  useEffect(() => { onUnread?.(unread); }, [unread, onUnread]);
  const allPicked = rows.length > 0 && rows.every((n) => picked.has(n.id));

  const act = async (ids: string[], what: "read" | "unsubscribe") => {
    if (!ids.length) return;
    setBusy(true);
    for (const id of ids) {
      const r = await api.prsInboxAct(what === "read" ? { act: "read", id } : { act: "unsubscribe", id });
      if (!r.ok) onFlash?.(false, r.error ?? "GitHub refused that");
    }
    setPicked(new Set());
    load(true);
  };

  const open = (n: InboxItem) => {
    if (n.number == null) return;
    // Reading it here is reading it: GitHub marks a thread read when you open
    // the page, and a row that stays bold after you have dealt with it is how
    // an inbox stops meaning anything.
    if (n.unread) void api.prsInboxAct({ act: "read", id: n.id }).then(() => load(true));
    /* An issue opens in Tasks, which is where this app keeps them; a pull
       request in this very panel. `openIssue` takes the number alone — issues
       are addressed by the checkout on screen, not by `owner/name`. */
    if (n.type === "Issue") openIssue(n.number);
    /* A mention row goes to the mention. GitHub's notification says THAT you
       were named and nothing about where, so opening the pull request landed
       you at the top of a conversation with forty entries in it, hunting for
       the part about you. The panel finds it and flashes it — see prMention.ts. */
    else openPr(n.repo, n.number, { mention: n.reason === "mention" || n.reason === "team_mention" });
  };

  return (
    <div className="flex flex-1 min-h-0">
      {/* The rail: shelves, then the named filters, then the repositories. */}
      <div className="shrink-0 flex flex-col gap-3 px-2 py-2 overflow-y-auto agx-scroll"
        style={{ width: 190, borderRight: edge(11) }}>
        <div className="flex flex-col gap-0.5">
          <Rail mark="⌸" label="Inbox" n={unread} on={shelf === "inbox"} hint="Everything not finished" onClick={() => { setShelf("inbox"); setPicked(new Set()); }} />
          <Rail mark="⚑" label="Saved" n={onShelf(all, "saved").length} on={shelf === "saved"} hint="Kept by you, on this machine — GitHub's API has no shelf for it" onClick={() => { setShelf("saved"); setPicked(new Set()); }} />
          <Rail mark="✓" label="Done" n={undefined} on={shelf === "done"} hint="Finished by you, on this machine" onClick={() => { setShelf("done"); setPicked(new Set()); }} />
        </div>

        <div className="flex flex-col gap-0.5">
          <div className="text-[9.5px] uppercase tracking-wider px-2 pb-1" style={{ color: "var(--text4)" }}>Filters</div>
          {FACETS.map((f) => (
            <Rail key={f.id} mark={f.mark} label={f.label} n={facetCount.get(f.id)} hint={f.hint}
              on={facet === f.id} onClick={() => { setFacet(facet === f.id ? "" : f.id); setPicked(new Set()); }} />
          ))}
        </div>

        <div className="flex flex-col gap-0.5">
          <div className="text-[9.5px] uppercase tracking-wider px-2 pb-1" style={{ color: "var(--text4)" }}>Repositories</div>
          {/* This panel is one repository at a time, so its own is the default
              and the rest are one press away rather than mixed in. */}
          <Rail mark="◆" label={repo || "This repository"} n={onShelf(all, shelf).filter((n) => n.repo === repo).length}
            on={!allRepos} hint="Only what is in the repository this panel is showing" onClick={() => setAllRepos(false)} />
          <Rail mark="◇" label="Everywhere" n={onShelf(all, shelf).length}
            on={allRepos} hint="Every repository you get notifications from" onClick={() => setAllRepos(true)} />
          {allRepos && repoCounts.filter((r) => r.value && r.value !== repo).slice(0, 8).map((r) => (
            <div key={r.value} className="flex items-center gap-1 pl-2 pr-1 py-0.5 text-[10.5px]" style={{ color: "var(--text3)" }}>
              <span className="truncate flex-1" title={r.value}>{r.value}</span>
              <span className="tabular-nums">{r.n}</span>
            </div>
          ))}
        </div>

        {/* The one bulk verb GitHub gives that is not per-thread. Per repository
            rather than global, because "all of them everywhere" is a press
            nobody can take back. */}
        <button className="agx-btn rounded-md px-2 py-1 text-[10.5px] mt-auto" style={{ color: "var(--text3)", border: edge(14) }}
          disabled={busy || !repo}
          title={`Mark everything in ${repo} as read on GitHub`}
          onClick={async () => {
            if (!(await ask({
              title: `Mark every notification in ${repo} as read?`,
              body: "They stay in GitHub — this only clears the unread marks for this repository.",
              confirmLabel: "Mark all read",
              danger: true,
            }))) return;
            setBusy(true);
            void api.prsInboxAct({ act: "repo-read", repo }).then((r) => {
              if (!r.ok) onFlash?.(false, r.error ?? "GitHub refused that");
              load(true);
            });
          }}>
          Mark this repository read
        </button>
      </div>

      {/* The list. */}
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        <div className="flex items-center gap-2 px-2.5 py-1.5 shrink-0 flex-wrap" style={{ borderBottom: edge(11) }}>
          <div className="flex rounded-md overflow-hidden shrink-0" style={{ border: edge(14) }}>
            {[["All", false], ["Unread", true]].map(([label, on]) => (
              <button key={String(label)} onClick={() => setUnreadOnly(on as boolean)}
                className="agx-btn text-[10.5px] px-2 py-0.5"
                style={{
                  color: unreadOnly === on ? "var(--bg)" : "var(--text2)",
                  background: unreadOnly === on ? "var(--primary)" : "transparent",
                }}>{label}</button>
            ))}
          </div>
          <input value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false}
            placeholder="Filter these — title, repo, or #number"
            className="text-[11px] px-2 py-1 rounded-md outline-none flex-1 min-w-[160px]"
            style={{ background: "var(--bg2)", color: "var(--text)", border: `1px solid ${q ? "var(--primary)" : "color-mix(in srgb, var(--text) 14%, transparent)"}` }} />
          <button onClick={() => setNewest((v) => !v)} className="agx-btn rounded-md px-2 py-1 text-[10.5px] shrink-0"
            style={{ color: "var(--text3)", border: edge(14) }}
            title="Turn the order round">
            {newest ? "Newest first" : "Oldest first"}
          </button>
          <button onClick={() => load(true)} disabled={busy} className="agx-btn rounded-md px-2 py-1 text-[10.5px] shrink-0"
            style={{ color: "var(--text3)", border: edge(14) }} title={at ? `Read ${fmtAgo(at)}` : "Read the inbox again"}>
            {busy ? "Reading…" : "Refresh"}
          </button>
        </div>

        {/* Select all, and what you can do to what is selected. */}
        <div className="flex items-center gap-2 px-2.5 py-1.5 shrink-0" style={{ borderBottom: edge(11) }}>
          <button className="agx-btn flex items-center gap-2 text-[10.5px] rounded px-1 py-0.5"
            style={{ color: "var(--text2)" }}
            onClick={() => setPicked(allPicked ? new Set() : new Set(rows.map((n) => n.id)))}>
            <Tick on={allPicked} /> Select all
          </button>
          {picked.size > 0 && (
            <>
              <span className="text-[10.5px] tabular-nums" style={{ color: "var(--text3)" }}>{picked.size} chosen</span>
              <span aria-hidden style={{ width: 1, height: 14, background: "color-mix(in srgb, var(--text) 14%, transparent)" }} />
              <button className="agx-btn rounded px-2 py-0.5 text-[10.5px]" style={{ color: "var(--text2)", border: edge(14) }}
                disabled={busy} onClick={() => void act([...picked], "read")}>Mark read</button>
              <button className="agx-btn rounded px-2 py-0.5 text-[10.5px]" style={{ color: "var(--text2)", border: edge(14) }}
                onClick={() => { for (const id of picked) setSaved(id, true); setPicked(new Set()); }}>Save</button>
              <button className="agx-btn rounded px-2 py-0.5 text-[10.5px]" style={{ color: "var(--text2)", border: edge(14) }}
                disabled={busy}
                onClick={() => { for (const id of picked) setDone(id, true); void act([...picked], "read"); }}>Done</button>
              <button className="agx-btn rounded px-2 py-0.5 text-[10.5px]" style={{ color: "var(--warning)", border: "1px solid color-mix(in srgb, var(--warning) 35%, transparent)" }}
                disabled={busy} onClick={() => void act([...picked], "unsubscribe")}>Unsubscribe</button>
            </>
          )}
          <span className="flex-1" />
          {err && <span className="text-[10.5px]" style={{ color: "var(--warning)" }} title={err}>GitHub: {err.slice(0, 60)}</span>}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto agx-scroll">
          {raw === null && <div className="p-3"><Spinner label="Reading your notifications…" className="" /></div>}
          {raw !== null && !rows.length && (
            <div className="p-6 text-center text-[11.5px]" style={{ color: "var(--text3)" }}>
              {shelf === "done" ? "Nothing finished yet." : shelf === "saved" ? "Nothing saved yet." : unreadOnly ? "Nothing unread. Good." : "Nothing here."}
            </div>
          )}
          {byDay(rows).map((group) => (
            <div key={group.label}>
              <div className="px-2.5 py-1 text-[9.5px] uppercase tracking-wider sticky top-0 z-10"
                style={{ color: "var(--text4)", background: "var(--bg)", borderBottom: edge(8) }}>{group.label}</div>
              {group.items.map((n) => (
                <div key={n.id} className="group flex items-start gap-2 px-2.5 py-2"
                  style={{ borderBottom: edge(8), background: n.unread ? "color-mix(in srgb, var(--primary) 5%, transparent)" : "transparent" }}>
                  <button className="agx-btn mt-0.5 shrink-0" title={picked.has(n.id) ? "Unpick" : "Pick"}
                    onClick={() => setPicked((s) => { const next = new Set(s); if (next.has(n.id)) next.delete(n.id); else next.add(n.id); return next; })}>
                    <Tick on={picked.has(n.id)} />
                  </button>
                  <span className="mt-0.5 shrink-0" title={n.type}><Kind type={n.type} /></span>
                  <button className="agx-btn min-w-0 flex-1 text-left" onClick={() => open(n)}
                    disabled={n.number == null}
                    title={n.number == null ? `${n.type} — no page for this in the app` : `Open ${n.repo} #${n.number}`}>
                    <div className="flex items-baseline gap-1.5 text-[10px]" style={{ color: "var(--text4)" }}>
                      <span className="truncate">{n.repo}</span>
                      {n.number != null && <span className="tabular-nums" style={{ color: "var(--text3)" }}>#{n.number}</span>}
                    </div>
                    <div className="text-[11.5px] leading-snug break-words"
                      style={{ color: n.unread ? "var(--text)" : "var(--text2)", fontWeight: n.unread ? 600 : 400 }}>
                      {n.title}
                    </div>
                  </button>
                  <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-md whitespace-nowrap"
                    style={{ color: "var(--text3)", border: edge(12) }}>{reasonLabel(n.reason)}</span>
                  <span className="shrink-0 text-[10px] tabular-nums w-[52px] text-right" style={{ color: "var(--text4)" }}
                    title={new Date(n.at).toLocaleString()}>{fmtAgo(n.at)}</span>
                  {/* Per-row verbs, quiet until the row is pointed at. */}
                  <span className="agx-hover-show flex items-center gap-1 shrink-0">
                    <button className="agx-btn rounded px-1.5 py-0.5 text-[10px]" style={{ color: isSaved(n.id) ? "var(--warning)" : "var(--text3)" }}
                      title={isSaved(n.id) ? "Take it off the saved shelf" : "Save it (kept on this machine)"}
                      onClick={() => setSaved(n.id, !isSaved(n.id))}>{isSaved(n.id) ? "Saved" : "Save"}</button>
                    <button className="agx-btn rounded px-1.5 py-0.5 text-[10px]" style={{ color: "var(--text3)" }}
                      title={isDone(n.id) ? "Put it back in the inbox" : "Finish with it — hides it here and marks it read on GitHub"}
                      onClick={() => {
                        const on = !isDone(n.id);
                        setDone(n.id, on);
                        if (on && n.unread) void act([n.id], "read");
                      }}>{isDone(n.id) ? "Undone" : "Done"}</button>
                    {n.unread && (
                      <button className="agx-btn rounded px-1.5 py-0.5 text-[10px]" style={{ color: "var(--text3)" }}
                        title="Mark it read on GitHub" disabled={busy}
                        onClick={() => void act([n.id], "read")}>Read</button>
                    )}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
      {dialog}
    </div>
  );
}
