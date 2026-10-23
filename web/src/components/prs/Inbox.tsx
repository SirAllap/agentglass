/*
 * GitHub's notification inbox, in the pull-request panel.
 *
 * The board answers a question about STATE — what is blocked, what is green,
 * what can land. This answers "what happened while I was away", which is the
 * only question that can be about a mention in a comment, a review somebody
 * asked for an hour ago, or an issue that is not a pull request at all. Both
 * are needed and neither replaces the other.
 *
 * The shelves are a segmented control across the top, the named filters are
 * reason chips under it and the repository is a dropdown, so the list takes the
 * whole width and a card per thread can say who, where, why and how long ago.
 * Ticking is for bulk work and only shows itself on hover or once something is
 * ticked. The filter text comes from outside (`filterText`): the bar at the top
 * of the panel owns the one search box, and a local state stands in until a bar
 * feeds it. Two differences from GitHub's own inbox, both deliberate:
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
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { usePoll } from "../../lib/usePoll.ts";
import type { InboxItem, PrSummary } from "../../../../shared/types.ts";
import { api } from "../../lib/api.ts";
import { botOnly, byDay, facetCounts, facetOrder, filterInbox, inFacet, orderByAnnotation, reasonChips, reasonLabel, searchInbox, sorters, TURN_CHIP, turnLine, yourTurn } from "../../lib/ghInbox.ts";
import { doneIds, isDone, isSaved, onShelf, savedIds, setDone, setSaved, subscribeMarks, type Shelf } from "../../lib/inboxMarks.ts";
import { fmtAgo } from "../../lib/format.ts";
import { inboxCiLine } from "../../lib/inboxCiText.ts";
import { jobIdOf } from "../../lib/prFailureHint.ts";
import { failureKey, loadCached, summaryOf, useFailureStore } from "../../lib/checkFailuresStore.ts";
import { openPr } from "../../lib/openPrs.ts";
import { useDialogs } from "../ConfirmDialog.tsx";
import { openIssue } from "../../lib/openIssue.ts";
import { Spinner } from "../Spinner.tsx";
import { HIT, ICON } from "../../lib/iconSize.ts";
import { CaretIcon, DoneIcon, MoreIcon } from "../../lib/glyphIcons.tsx";
import { RefreshButton, EDGE, LINE } from "../workspace/Chrome.tsx";
import { Menu, MenuItem } from "../PrPanel.tsx";
import { Optimistic } from "../../lib/prOptimistic.ts";
import { Chip } from "../git/ui.tsx";
import { TO_ROW_TONE } from "../../lib/pluginTones.ts";

/** The list with the given threads set read. A pure patch, kept outside the
 *  component so the layer it draws — see `Optimistic` — can be exercised
 *  without mounting anything: `unread` is the one field GitHub's "read" call
 *  changes, and setting it (never toggling it) is what makes a layer drawn
 *  twice over the same thread harmless. */
export const markReadPatch = (ids: string[]) => (items: InboxItem[]): InboxItem[] => {
  if (!ids.length) return items;
  const set = new Set(ids);
  let changed = false;
  const next = items.map((n) => {
    if (!set.has(n.id) || !n.unread) return n;
    changed = true;
    return { ...n, unread: false };
  });
  return changed ? next : items;
};


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
        <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 24 24" fill="none" stroke="var(--on-primary)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M4 12l5 5L20 6" />
        </svg>
      )}
    </span>
  );
}

/** A joined set of choices, one of them on. The two All / Unread halves and the four shelves are the same control. */
function Switch<T extends string>({ value, options, onChange, label }: {
  value: T; label: string; onChange: (v: T) => void;
  options: readonly { id: T; label: string; n?: number; title?: string }[];
}) {
  return (
    <div className="flex rounded-md overflow-hidden shrink-0" style={{ border: EDGE }} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" onClick={() => onChange(o.id)} title={o.title} aria-pressed={value === o.id}
          className="agx-btn text-[11px] px-2.5 flex items-center gap-1.5"
          style={{ minHeight: HIT, color: value === o.id ? "var(--text)" : "var(--text3)", fontWeight: value === o.id ? 600 : 400,
            background: value === o.id ? "color-mix(in srgb, var(--primary) 18%, transparent)" : "transparent" }}>
          {o.label}
          {o.n != null && o.n > 0 && <span className="tabular-nums text-[10px]" style={{ color: value === o.id ? "var(--text2)" : "var(--text4)" }}>{o.n}</span>}
        </button>
      ))}
    </div>
  );
}

export function Inbox({ repo, root, prs, onFlash, onUnread, active = true, filterText, onFilterText }: {
  /** The repository the panel is showing, which is what this opens filtered to. */
  repo: string;
  /** The checkout and the pull requests the panel has loaded: what a failed CI row is worded from. Neither asks GitHub. */
  root: string;
  prs: PrSummary[];
  onFlash?: (ok: boolean, text: string) => void;
  /** How many are unread in THIS repository, for the pill that opened this —
   *  the only number the panel shows before the inbox is on screen. */
  onUnread?: (n: number) => void;
  /** Whether the list can be seen. False while a pull request is open on top. */
  active?: boolean;
  /** The text the panel's one search box holds. This view draws no box of its own. */
  filterText?: string;
  onFilterText?: (v: string) => void;
}) {
  /* The app's own dialog, not the browser's — see no-native-dialogs.test.ts.
     This one had a `window.confirm` and the lint could not see it: its
     lookbehind skipped every receiver including `window`. */
  const { ask, dialog } = useDialogs();
  const [raw, setRaw] = useState<InboxItem[] | null>(null);
  /* The failing part of a failed CI row, from what the app already read: one request to this server's own cache. */
  useFailureStore();
  useEffect(() => {
    if (!root) return;
    const ids = new Set<string>();
    for (const p of prs) for (const c of p.checks?.failing ?? []) { const j = jobIdOf(c); if (j) ids.add(j); }
    if (ids.size) void loadCached(root, [...ids]);
  }, [root, prs]);
  const [err, setErr] = useState("");
  const [at, setAt] = useState(0);
  const [busy, setBusy] = useState(false);
  /** "turn" is a view of the inbox shelf, not a shelf: nothing is stored under it. */
  const [shelf, setShelf] = useState<Shelf | "turn">("inbox");
  const [facet, setFacet] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [localQ, setLocalQ] = useState("");
  const q = filterText ?? localQ;
  const setQ = onFilterText ?? setLocalQ;
  const [newest, setNewest] = useState(true);
  /** A plugin whose numbers order the list, or null for time. Only ever the person's pick. */
  const [sortBy, setSortBy] = useState<string | null>(null);
  const [allRepos, setAllRepos] = useState(false);
  /** Bot-only updates on the person's pull requests, listed instead of counted. */
  const [showBots, setShowBots] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  /* The local shelves are a store outside React — two other windows can move
     them — so the list subscribes rather than copying them into state. */
  const marksTick = useSyncExternalStore(subscribeMarks, () => `${savedIds().length}:${doneIds().length}`, () => "0:0");

  /* The "Read" tick is drawn at once and taken back only if GitHub refuses it —
     the same layer-over-the-last-answer pattern as the pull request panel's
     reactions (`prOptimistic.ts`). `onFlash` is read through a ref so the
     Optimistic instance, and the layers it is holding, survive a re-render
     that hands this component a new closure for it. */
  const onFlashRef = useRef(onFlash);
  onFlashRef.current = onFlash;
  const [, bumpOptimistic] = useState(0);
  const optimistic = useMemo(() => new Optimistic<InboxItem[]>({
    onChange: () => bumpOptimistic((t) => t + 1),
    onFail: (text) => onFlashRef.current?.(false, text),
  }), []);

  const load = useCallback((force = false) => {
    setBusy(true);
    const ticket = optimistic.readStarted();
    void api.prsInbox(force)
      .then((r) => {
        setRaw(r.items ?? []);
        setAt(r.at ?? Date.now());
        setErr(r.ok ? (r.error ?? "") : (r.error ?? "GitHub did not answer"));
        optimistic.readLanded(ticket);
      })
      .catch(() => setErr("Could not reach the server"))
      .finally(() => setBusy(false));
  }, [optimistic]);

  useEffect(() => { load(); }, [load]);
  /* Polled while it is on screen, at GitHub's own asking distance for this
     endpoint. The server caches under it, so several windows cost one call. */
  /* Through `usePoll`, and not while a pull request is open over it: the list
     stays mounted under the detail, and its interval went on asking for a list
     nobody could see, focused or not — 1 spawn a minute, 12 of 12 unchanged. */
  usePoll(active, () => load(), 60_000);

  const all = optimistic.view(raw ?? []);
  /** Everything on this shelf, in this repository unless asked otherwise. Every
   *  count below is computed from here, so a chip says what pressing it does. */
  const here = useCallback((n: InboxItem) => allRepos || !repo || n.repo === repo, [allRepos, repo]);
  /* marksTick: the shelves are outside React and this is what says they moved. */
  const onView = useCallback((which: Shelf | "turn"): InboxItem[] =>
    which === "turn" ? onShelf(all, "inbox").filter(yourTurn) : onShelf(all, which),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [all, marksTick]);
  const shelved = useMemo(() => onView(shelf).filter(here), [onView, shelf, here]);
  const chips = useMemo(() => reasonChips(unreadOnly ? shelved.filter((n) => n.unread) : shelved), [shelved, unreadOnly]);

  /** Plugins that gave rows a number to order by; each is a "Sort" choice. */
  const orderers = useMemo(() => sorters(all), [all]);
  /** The toggles, facet, search and order the person has set, applied to any list. */
  const applyView = useCallback((from: InboxItem[]) => {
    const list = searchInbox(
      filterInbox(from, { unread: unreadOnly }).filter((n) => !facet || inFacet(n, facet)),
      q,
    );
    return sortBy && orderers.includes(sortBy)
      ? orderByAnnotation(list, sortBy)
      : [...list].sort((a, b) => (newest ? b.at - a.at : a.at - b.at));
  }, [unreadOnly, facet, q, newest, sortBy, orderers]);
  const rows = useMemo(() => applyView(shelved), [applyView, shelved]);

  const repoCounts = useMemo(() => facetOrder(facetCounts(onView(shelf), {}, "repo")), [onView, shelf]);
  /* What each shelf's own count says, whichever is showing: the rail answers
     "what is on that shelf", and the pill on the tab is the inbox's. */
  const counts = useMemo(() => {
    const unreadIn = (which: Shelf | "turn") => onView(which).filter((n) => n.unread && here(n)).length;
    return { inbox: unreadIn("inbox"), turn: unreadIn("turn") };
  }, [onView, here]);
  useEffect(() => { onUnread?.(counts.inbox); }, [counts.inbox, onUnread]);
  /** News on the person's pull requests that only bots wrote: never a row of
   *  Your turn, and never dropped without saying so. It follows the same
   *  filters the rows do, so the line counts what "Show them" would list. */
  const botRows = useMemo(
    () => (shelf === "turn" ? applyView(onView("inbox").filter((n) => botOnly(n) && here(n))) : []),
    [shelf, applyView, onView, here],
  );
  const allPicked = rows.length > 0 && rows.every((n) => picked.has(n.id));

  const act = async (ids: string[], what: "read" | "unsubscribe") => {
    if (!ids.length) return;
    if (what === "read") {
      // Drawn on the press: a bold row goes plain at once, and a refusal takes
      // it back through onFail rather than a re-read of the whole inbox — see
      // markReadPatch and prOptimistic.ts. Each thread is its own lane so two
      // "Read" presses on the same row cannot land out of order.
      setPicked(new Set());
      await Promise.all(ids.map((id) => optimistic.run({
        patch: markReadPatch([id]),
        send: () => api.prsInboxAct({ act: "read", id }),
        failText: "Could not mark it read",
        lane: id,
      })));
      return;
    }
    setBusy(true);
    for (const id of ids) {
      const r = await api.prsInboxAct({ act: "unsubscribe", id });
      if (!r.ok) onFlash?.(false, r.error ?? "GitHub refused that");
    }
    setPicked(new Set());
    load(true);
  };

  const open = (n: InboxItem) => {
    if (n.number == null) return;
    // Reading it here is reading it: GitHub marks a thread read when you open
    // the page, and a row that stays bold after you have dealt with it is how
    // an inbox stops meaning anything. Goes through `act` so the tick is drawn
    // at once instead of waiting on this same call.
    if (n.unread) void act([n.id], "read");
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

  /** One thread, as a card. `ghost` is a bot-only update the person asked to
   *  see: same anatomy, quieter, and labelled for what it is. */
  const renderRow = (n: InboxItem, ghost: boolean) => {
    const turnView = n.turn && (shelf === "turn" || ghost);
    const chip = turnView ? TURN_CHIP[n.turn!.kind] : null;
    const line = turnView ? turnLine(n.turn!) : null;
    const ci = root ? inboxCiLine(n, prs, (job) => summaryOf(failureKey(root, job))) : null;
    const reason = chip ? chip.label : reasonLabel(n.reason);
    const picking = picked.size > 0;
    return (
      <div key={n.id} className="agx-row group flex flex-wrap items-start gap-x-2.5 gap-y-1 mx-2.5 my-1 pl-2.5 pr-2.5 py-2 rounded-xl"
        style={{
          border: LINE, opacity: ghost ? 0.62 : undefined,
          background: "var(--surface-card)",
          // The unread edge is an inset shadow, not a wider border: the card does not change size when it is read.
          boxShadow: n.unread && !ghost ? "inset 3px 0 0 var(--primary)" : undefined,
        }}>
        {/* Laid out in every state, drawn only on hover or while something is ticked, so pointing at a row moves nothing. */}
        <span className="agx-hover-show mt-1 shrink-0" style={picking ? { opacity: 1 } : undefined}>
          <button className="agx-btn" title={picked.has(n.id) ? "Unpick" : "Pick"} aria-pressed={picked.has(n.id)}
            onClick={() => setPicked((s) => { const next = new Set(s); if (next.has(n.id)) next.delete(n.id); else next.add(n.id); return next; })}>
            <Tick on={picked.has(n.id)} />
          </button>
        </span>
        <span className="mt-0.5 shrink-0 grid place-items-center rounded-full" title={n.type}
          style={{ width: 26, height: 26, background: "color-mix(in srgb, var(--text) 8%, transparent)" }}><Kind type={n.type} /></span>
        <button className="agx-btn min-w-[220px] flex-1 text-left" onClick={() => open(n)}
          disabled={n.number == null}
          title={n.number == null ? `${n.type} — no page for this in the app` : `Open ${n.repo} #${n.number}`}>
          <div className="text-[11.5px] leading-snug break-words"
            style={{ color: n.unread && !ghost ? "var(--text)" : "var(--text2)", fontWeight: n.unread && !ghost ? 600 : 400 }}>
            {n.title}
          </div>
          <div className="flex items-baseline gap-1.5 text-[10px] mt-0.5" style={{ color: "var(--text4)" }}>
            <span className="truncate">{n.repo}</span>
            {n.number != null && <span className="tabular-nums shrink-0" style={{ color: "var(--text3)" }}>#{n.number}</span>}
            <span aria-hidden>·</span><span className="shrink-0">{reason}</span>
            <span aria-hidden>·</span><span className="tabular-nums shrink-0" title={new Date(n.at).toLocaleString()}>{fmtAgo(n.at)}</span>
          </div>
          {ci && (
            <div className="mt-0.5 flex text-[10.5px]" style={{ color: "var(--text3)" }} title={ci.text + ci.tail}>
              <span className="truncate">{ci.text}</span><span className="shrink-0 whitespace-pre">{ci.tail}</span>
            </div>
          )}
          {line && (line.by || line.text) && (
            <div className="mt-0.5 text-[10.5px] truncate" style={{ color: "var(--text3)" }}>
              {line.by && <span style={{ color: "var(--text2)" }}>{line.by}</span>}{line.by && line.text ? " " : ""}{line.text}
            </div>
          )}
        </button>
        {/* Everything after the title travels together: beside it when it fits,
            under it, to the right, when it does not — never taking the title's
            width. Laid out the same in every state; hover only shows the verbs. */}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-x-2 gap-y-1 min-w-0">
        {n.annotations?.map((a) => a.badge && (
          <Chip key={a.plugin} tone={TO_ROW_TONE[a.badge.tone ?? "default"]} title={a.tip ? `${a.tip} — ${a.plugin}` : a.plugin}>{a.badge.text}</Chip>
        ))}
        {chip && chip.tone !== "neutral"
          /* The two that ask something of you wear the tinted chip; the rest are a quiet tint of their own. */
          ? <Chip tone={chip.tone}>{chip.label}</Chip>
          : <Chip tone="neutral">{reason}</Chip>}
        {/* Per-row verbs, quiet until the row is pointed at. */}
        <span className="agx-hover-show flex items-center gap-1 shrink-0">
          {n.unread && (
            <button className="agx-btn rounded px-1.5 py-0.5 text-[10px]" style={{ color: "var(--text3)", border: EDGE }}
              title="Mark it read on GitHub" disabled={busy}
              onClick={() => void act([n.id], "read")}>Mark read</button>
          )}
          <button className="agx-btn rounded px-1.5 py-0.5 text-[10px]" style={{ color: isSaved(n.id) ? "var(--warning)" : "var(--text3)", border: EDGE }}
            title={isSaved(n.id) ? "Take it off the saved shelf" : "Save it (kept on this machine)"}
            onClick={() => setSaved(n.id, !isSaved(n.id))}>{isSaved(n.id) ? "Saved" : "Save"}</button>
          <button className="agx-btn rounded px-1.5 py-0.5 text-[10px]" style={{ color: "var(--text3)", border: EDGE }}
            title={isDone(n.id) ? "Put it back in the inbox" : "Finish with it — hides it here and marks it read on GitHub"}
            onClick={() => {
              const on = !isDone(n.id);
              setDone(n.id, on);
              if (on && n.unread) void act([n.id], "read");
            }}>{isDone(n.id) ? "Undone" : "Done"}</button>
        </span>
        </div>
      </div>
    );
  };

  const unreadHere = rows.filter((n) => n.unread).map((n) => n.id);
  const markRepoRead = async () => {
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
  };
  const here_n = onView(shelf).filter((n) => n.repo === repo).length;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Shelves, repository, the two lists' switches and the ⋯ menu: one strip. Wraps rather than scrolls, so nothing is ever hidden at 1100 px. */}
      <div className="flex items-center gap-2 px-2.5 pt-2 pb-1.5 shrink-0 flex-wrap">
        <Switch<Shelf | "turn"> label="Shelf" value={shelf} onChange={(v) => { setShelf(v); setPicked(new Set()); }}
          options={[
            { id: "inbox", label: "Inbox", n: counts.inbox, title: "Everything not finished" },
            { id: "turn", label: "Your turn", n: counts.turn, title: "Review requests, mentions, changes requested, and people writing on your pull requests" },
            { id: "saved", label: "Saved", n: onShelf(all, "saved").length, title: "Kept by you, on this machine — GitHub's API has no shelf for it" },
            { id: "done", label: "Done", title: "Finished by you, on this machine" },
          ]} />
        {/* This panel is one repository at a time, so its own is the default
            and the rest are one press away rather than mixed in. */}
        <Menu align="left" title="Which repository" label={<span className="flex items-center gap-1 text-[11px]">
          <span className="truncate max-w-[220px]">{allRepos ? "Everywhere" : repo || "This repository"}</span>
          <span className="tabular-nums" style={{ color: "var(--text3)" }}>({allRepos ? onView(shelf).length : here_n})</span>
          <CaretIcon size={ICON.xs} /></span>}>
          {(close) => (
            <>
              <MenuItem icon={allRepos ? undefined : <DoneIcon size={ICON.sm} />} onClick={() => { setAllRepos(false); close(); }}>{(repo || "This repository") + ` (${here_n})`}</MenuItem>
              <MenuItem icon={allRepos ? <DoneIcon size={ICON.sm} /> : undefined} onClick={() => { setAllRepos(true); close(); }}>{`Everywhere (${onView(shelf).length})`}</MenuItem>
              {allRepos && repoCounts.filter((r) => r.value && r.value !== repo).slice(0, 8).map((r) => (
                <div key={r.value} className="flex items-center gap-2 px-2.5 text-[10.5px] whitespace-nowrap" style={{ minHeight: HIT, color: "var(--text3)" }}>
                  <span className="truncate flex-1" title={r.value}>{r.value}</span><span className="tabular-nums">{r.n}</span>
                </div>
              ))}
            </>
          )}
        </Menu>
        <span className="flex-1" />
        <Switch<"all" | "unread"> label="Show" value={unreadOnly ? "unread" : "all"} onChange={(v) => setUnreadOnly(v === "unread")}
          options={[{ id: "all", label: "All" }, { id: "unread", label: "Unread" }]} />
        {orderers.length > 0 && (
          <div title="Sort by time, or by the numbers an installed plugin gave the rows">
            <Switch<string> label="Sort" value={sortBy && orderers.includes(sortBy) ? sortBy : "time"} onChange={(v) => setSortBy(v === "time" ? null : v)}
              options={[{ id: "time", label: "Time" }, ...orderers.map((p) => ({ id: p, label: p }))]} />
          </div>
        )}
        {!(sortBy && orderers.includes(sortBy)) && (
          <button onClick={() => setNewest((v) => !v)} className="agx-btn rounded-md px-2 text-[10.5px] shrink-0"
            style={{ color: "var(--text3)", border: EDGE, minHeight: HIT }}
            title="Turn the order round">
            {newest ? "Newest first" : "Oldest first"}
          </button>
        )}
        <RefreshButton onRefresh={() => load(true)} busy={busy}
          title={at ? `Read ${fmtAgo(at)}` : "Read the inbox again"} />
        {/* The bulk verbs GitHub gives that are not per-thread, kept in the view
            and not in the panel's bar. Per repository rather than global,
            because "all of them everywhere" is a press nobody can take back. */}
        <Menu title="More" label={<MoreIcon size={ICON.sm} />}>
          {(close) => (
            <>
              <MenuItem onClick={() => { close(); void act(unreadHere, "read"); }}>{`Mark all read (${unreadHere.length} shown)`}</MenuItem>
              <MenuItem danger onClick={() => { close(); void markRepoRead(); }}>Mark this repository read</MenuItem>
            </>
          )}
        </Menu>
      </div>

      {/* Reasons. */}
      <div className="flex items-center gap-1.5 px-2.5 pb-2 shrink-0 flex-wrap" role="group" aria-label="Reason" style={{ borderBottom: LINE }}>
        {chips.map((c) => {
          const on = facet === c.id;
          return (
            <button key={c.id || "all"} type="button" aria-pressed={on} title={c.hint}
              onClick={() => { setFacet(on ? "" : c.id); setPicked(new Set()); }}
              className="agx-btn rounded-full px-2.5 text-[10.5px] flex items-center gap-1.5"
              style={{ minHeight: HIT - 4, border: EDGE, color: on ? "var(--on-primary)" : "var(--text2)", background: on ? "var(--primary)" : "transparent" }}>
              {c.label}<span className="tabular-nums" style={{ opacity: 0.7 }}>{c.n}</span>
            </button>
          );
        })}
        <span className="flex-1" />
        {err && <span className="text-[10.5px]" style={{ color: "var(--warning-ink)" }} title={err}>GitHub: {err.slice(0, 60)}</span>}
      </div>

      {/* What you can do to what is ticked. Only while something is. */}
      {picked.size > 0 && (
        <div className="flex items-center gap-2 px-2.5 py-1.5 shrink-0 flex-wrap" style={{ borderBottom: LINE }}>
          <button className="agx-btn flex items-center gap-2 text-[10.5px] rounded px-1 py-0.5"
            style={{ color: "var(--text2)" }}
            onClick={() => setPicked(allPicked ? new Set() : new Set(rows.map((n) => n.id)))}>
            <Tick on={allPicked} /> Select all
          </button>
          <span className="text-[10.5px] tabular-nums" style={{ color: "var(--text3)" }}>{picked.size} chosen</span>
          <span aria-hidden style={{ width: 1, height: 14, background: "color-mix(in srgb, var(--text) 14%, transparent)" }} />
          <button className="agx-btn rounded px-2 py-0.5 text-[10.5px]" style={{ color: "var(--text2)", border: EDGE }}
            disabled={busy} onClick={() => void act([...picked], "read")}>Mark read</button>
          <button className="agx-btn rounded px-2 py-0.5 text-[10.5px]" style={{ color: "var(--text2)", border: EDGE }}
            onClick={() => { for (const id of picked) setSaved(id, true); setPicked(new Set()); }}>Save</button>
          <button className="agx-btn rounded px-2 py-0.5 text-[10.5px]" style={{ color: "var(--text2)", border: EDGE }}
            disabled={busy}
            onClick={() => { for (const id of picked) setDone(id, true); void act([...picked], "read"); }}>Done</button>
          <button className="agx-btn rounded px-2 py-0.5 text-[10.5px]" style={{ color: "var(--warning-ink)", border: "1px solid color-mix(in srgb, var(--warning) 35%, transparent)" }}
            disabled={busy} onClick={() => void act([...picked], "unsubscribe")}>Unsubscribe</button>
          <button className="agx-btn rounded px-2 py-0.5 text-[10.5px]" style={{ color: "var(--text3)" }} onClick={() => setPicked(new Set())}>Clear</button>
        </div>
      )}

      {/* The list. */}
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        <div className="flex-1 min-h-0 overflow-y-auto agx-scroll">
          {raw === null && <div className="p-3"><Spinner label="Reading your notifications…" className="" /></div>}
          {raw !== null && !rows.length && shelf === "turn" && (
            <div className="px-6 py-14 text-center leading-relaxed">
              <div className="text-[12.5px] font-semibold" style={{ color: "var(--text)" }}>Nothing waits on you.</div>
              <div className="text-[10.5px]" style={{ color: "var(--text4)" }}>Review requests, mentions, changes requested and people writing on your pull requests land here.</div>
            </div>
          )}
          {raw !== null && !rows.length && shelf !== "turn" && (
            <div className="p-6 text-center text-[11.5px]" style={{ color: "var(--text3)" }}>
              {q.trim() ? <>Nothing matches “{q.trim()}”. <button type="button" className="agx-btn underline underline-offset-2" style={{ color: "var(--text2)" }} onClick={() => setQ("")}>Clear the filter</button></> : shelf === "done" ? "Nothing finished yet." : shelf === "saved" ? "Nothing saved yet." : unreadOnly ? "Nothing unread. Good." : "Nothing here."}
            </div>
          )}
          {byDay(rows).map((group) => (
            <div key={group.label}>
              <div className="px-3.5 pt-3 pb-1 text-[9.5px] uppercase tracking-wider sticky top-0 z-10"
                style={{ color: "var(--text4)", background: "var(--bg)" }}>{group.label}</div>
              {group.items.map((n) => renderRow(n, false))}
            </div>
          ))}
          {/* The one place a bot is mentioned: a line at the end, never a row.
              Silence would make this view look broken next to GitHub's own
              inbox ("where is my pull request?"), and a row would break what
              the view promises. */}
          {raw !== null && botRows.length > 0 && (
            <>
              <div className="flex items-center gap-1.5 px-2.5 py-2 text-[10.5px]" style={{ color: "var(--text3)", borderBottom: LINE }}>
                <span>{botRows.length} update{botRows.length === 1 ? "" : "s"} on your pull requests {showBots ? "where only bots wrote:" : "are hidden: only bots wrote them."}</span>
                <button className="agx-btn flex items-center gap-1 underline underline-offset-2" style={{ color: "var(--text2)" }}
                  aria-expanded={showBots} onClick={() => setShowBots((v) => !v)}>
                  {showBots ? "Hide them" : "Show them"}
                  <span aria-hidden className="flex" style={{ transform: showBots ? "rotate(180deg)" : undefined }}><CaretIcon size={ICON.xs} /></span>
                </button>
              </div>
              {showBots && botRows.map((n) => renderRow(n, true))}
            </>
          )}
        </div>
      </div>
      {dialog}
    </div>
  );
}
