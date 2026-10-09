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
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { usePoll } from "../../lib/usePoll.ts";
import type { InboxItem, PrSummary } from "../../../../shared/types.ts";
import { api } from "../../lib/api.ts";
import { botOnly, byDay, facetCounts, facetOrder, FACETS, filterInbox, inFacet, orderByAnnotation, reasonLabel, searchInbox, sorters, TURN_CHIP, turnLine, yourTurn } from "../../lib/ghInbox.ts";
import { doneIds, isDone, isSaved, onShelf, savedIds, setDone, setSaved, subscribeMarks, type Shelf } from "../../lib/inboxMarks.ts";
import { fmtAgo } from "../../lib/format.ts";
import { inboxCiLine } from "../../lib/inboxCiText.ts";
import { INBOX_RAIL_WIDTH, railFolds } from "../../lib/inboxLayout.ts";
import { jobIdOf } from "../../lib/prFailureHint.ts";
import { failureKey, loadCached, summaryOf, useFailureStore } from "../../lib/checkFailuresStore.ts";
import { openPr } from "../../lib/openPrs.ts";
import { useDialogs } from "../ConfirmDialog.tsx";
import { openIssue } from "../../lib/openIssue.ts";
import { Spinner } from "../Spinner.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { CaretIcon, ClockIcon, CommentIcon, DoneIcon, EyeIcon, FlagIcon, HandIcon, InboxIcon, UserIcon } from "../../lib/glyphIcons.tsx";
import { GitIcon } from "../workspace/icons.tsx";
import { RefreshButton, INPUT, INPUT_STYLE, EDGE, LINE } from "../workspace/Chrome.tsx";
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
        <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 24 24" fill="none" stroke="var(--bg)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M4 12l5 5L20 6" />
        </svg>
      )}
    </span>
  );
}

/** One control in the shelf rail or the filter list. */
/** Why each facet of the inbox is there, drawn: these were `◎ ❞ ✋ ❊ ◉` in the
 *  facet table, each a different size in the system font. */
const FACET_ICON: Record<string, ReactNode> = {
  assigned: <UserIcon size={ICON.xs} />,
  participating: <CommentIcon size={ICON.xs} />,
  mentioned: <HandIcon size={ICON.xs} />,
  team: <UserIcon size={ICON.xs} />,
  review: <EyeIcon size={ICON.xs} />,
};

function Rail({ mark, label, n, on, hint, onClick }: {
  mark: ReactNode; label: string; n?: number; on: boolean; hint: string; onClick: () => void;
}) {
  return (
    <button onClick={onClick} title={hint} aria-pressed={on}
      className="agx-btn w-full flex items-center gap-2 rounded-md px-2 py-1 text-[11px]"
      style={{
        color: on ? "var(--text)" : "var(--text2)",
        background: on ? "color-mix(in srgb, var(--text) 8%, transparent)" : "transparent",
        boxShadow: on ? "inset 2px 0 0 var(--primary)" : undefined,
      }}>
      <span aria-hidden className="shrink-0 flex justify-center" style={{ width: 14 }}>{mark}</span>
      <span className="truncate flex-1 text-left">{label}</span>
      {n != null && n > 0 && (
        <span className="tabular-nums text-[10px] px-1.5 rounded-full shrink-0"
          style={{ color: "var(--text3)", background: "color-mix(in srgb, var(--text) 10%, transparent)" }}>{n}</span>
      )}
    </button>
  );
}

export function Inbox({ repo, root, prs, onFlash, onUnread, active = true }: {
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
}) {
  /* The app's own dialog, not the browser's — see no-native-dialogs.test.ts.
     This one had a `window.confirm` and the lint could not see it: its
     lookbehind skipped every receiver including `window`. */
  const { ask, dialog } = useDialogs();
  /* The panel's own width, to decide where the rail sits — see inboxLayout.ts. */
  const box = useRef<HTMLDivElement>(null);
  const [folded, setFolded] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => setFolded(railFolds(entries[0]!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const group = folded ? "flex flex-row items-center gap-0.5" : "flex flex-col gap-0.5";
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
  const [q, setQ] = useState("");
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
  const facetCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of FACETS) m.set(f.id, shelved.filter((n) => (unreadOnly ? n.unread : true) && inFacet(n, f.id)).length);
    return m;
  }, [shelved, unreadOnly]);

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

  /** One thread. `ghost` is a bot-only update the person asked to see: same
   *  anatomy, quieter, and labelled for what it is. */
  const renderRow = (n: InboxItem, ghost: boolean) => {
    const turnView = n.turn && (shelf === "turn" || ghost);
    const chip = turnView ? TURN_CHIP[n.turn!.kind] : null;
    const line = turnView ? turnLine(n.turn!) : null;
    const ci = root ? inboxCiLine(n, prs, (job) => summaryOf(failureKey(root, job))) : null;
    return (
      <div key={n.id} className="group flex flex-wrap items-start gap-x-2 gap-y-1 px-2.5 py-2"
        style={{ borderBottom: LINE, opacity: ghost ? 0.62 : undefined, background: n.unread && !ghost ? "color-mix(in srgb, var(--primary) 5%, transparent)" : "transparent" }}>
        <button className="agx-btn mt-0.5 shrink-0" title={picked.has(n.id) ? "Unpick" : "Pick"}
          onClick={() => setPicked((s) => { const next = new Set(s); if (next.has(n.id)) next.delete(n.id); else next.add(n.id); return next; })}>
          <Tick on={picked.has(n.id)} />
        </button>
        <span className="mt-0.5 shrink-0" title={n.type}><Kind type={n.type} /></span>
        <button className="agx-btn min-w-[220px] flex-1 text-left" onClick={() => open(n)}
          disabled={n.number == null}
          title={n.number == null ? `${n.type} — no page for this in the app` : `Open ${n.repo} #${n.number}`}>
          <div className="flex items-baseline gap-1.5 text-[10px]" style={{ color: "var(--text4)" }}>
            <span className="truncate">{n.repo}</span>
            {n.number != null && <span className="tabular-nums" style={{ color: "var(--text3)" }}>#{n.number}</span>}
          </div>
          <div className="text-[11.5px] leading-snug break-words"
            style={{ color: n.unread && !ghost ? "var(--text)" : "var(--text2)", fontWeight: n.unread && !ghost ? 600 : 400 }}>
            {n.title}
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
          /* The two that ask something of you wear the house chip — a tint, no
             border — rather than a third border weight. */
          ? <Chip tone={chip.tone}>{chip.label}</Chip>
          : <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-md whitespace-nowrap"
              style={{ color: "var(--text3)", border: EDGE }}>{chip ? chip.label : reasonLabel(n.reason)}</span>}
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
      </div>
    );
  };

  return (
    <div ref={box} className={`flex flex-1 min-h-0 ${folded ? "flex-col" : ""}`}>
      {/* The rail: shelves, then the named filters, then the repositories.
          Above the list as a strip that scrolls sideways when the panel is
          too narrow for it to sit beside — the same controls, the same order. */}
      <div className={folded
          ? "shrink-0 flex flex-row items-center gap-4 px-2 py-1.5 overflow-x-auto overflow-y-hidden agx-scroll [&>*]:shrink-0 [&_button]:w-auto [&_button]:whitespace-nowrap"
          : "shrink-0 flex flex-col gap-3 px-2 py-2 overflow-y-auto agx-scroll"}
        style={folded ? { borderBottom: LINE } : { width: INBOX_RAIL_WIDTH, borderRight: LINE }}>
        <div className={group}>
          <Rail mark={<InboxIcon size={ICON.xs} />} label="Inbox" n={counts.inbox} on={shelf === "inbox"} hint="Everything not finished" onClick={() => { setShelf("inbox"); setPicked(new Set()); }} />
          <Rail mark={<ClockIcon size={ICON.xs} />} label="Your turn" n={counts.turn} on={shelf === "turn"} hint="Review requests, mentions, changes requested, and people writing on your pull requests" onClick={() => { setShelf("turn"); setPicked(new Set()); }} />
          <Rail mark={<FlagIcon size={ICON.xs} filled />} label="Saved" n={onShelf(all, "saved").length} on={shelf === "saved"} hint="Kept by you, on this machine — GitHub's API has no shelf for it" onClick={() => { setShelf("saved"); setPicked(new Set()); }} />
          <Rail mark={<DoneIcon size={ICON.xs} />} label="Done" n={undefined} on={shelf === "done"} hint="Finished by you, on this machine" onClick={() => { setShelf("done"); setPicked(new Set()); }} />
        </div>

        <div className={group}>
          <div className={`text-[9.5px] uppercase tracking-wider px-2 ${folded ? "" : "pb-1"}`} style={{ color: "var(--text4)" }}>Filters</div>
          {FACETS.map((f) => (
            <Rail key={f.id} mark={FACET_ICON[f.id] ?? null} label={f.label} n={facetCount.get(f.id)} hint={f.hint}
              on={facet === f.id} onClick={() => { setFacet(facet === f.id ? "" : f.id); setPicked(new Set()); }} />
          ))}
        </div>

        <div className={group}>
          <div className={`text-[9.5px] uppercase tracking-wider px-2 ${folded ? "" : "pb-1"}`} style={{ color: "var(--text4)" }}>Repositories</div>
          {/* This panel is one repository at a time, so its own is the default
              and the rest are one press away rather than mixed in. */}
          <Rail mark={<GitIcon size={ICON.xs} />} label={repo || "This repository"} n={onView(shelf).filter((n) => n.repo === repo).length}
            on={!allRepos} hint="Only what is in the repository this panel is showing" onClick={() => setAllRepos(false)} />
          <Rail mark="◇" label="Everywhere" n={onView(shelf).length}
            on={allRepos} hint="Every repository you get notifications from" onClick={() => setAllRepos(true)} />
          {allRepos && repoCounts.filter((r) => r.value && r.value !== repo).slice(0, 8).map((r) => (
            <div key={r.value} className="flex items-center gap-1 pl-2 pr-1 py-0.5 text-[10.5px] shrink-0 whitespace-nowrap" style={{ color: "var(--text3)" }}>
              <span className="truncate flex-1" title={r.value}>{r.value}</span>
              <span className="tabular-nums">{r.n}</span>
            </div>
          ))}
        </div>

        {/* The one bulk verb GitHub gives that is not per-thread. Per repository
            rather than global, because "all of them everywhere" is a press
            nobody can take back. */}
        <button className={`agx-btn rounded-md px-2 py-1 text-[10.5px] ${folded ? "" : "mt-auto"}`} style={{ color: "var(--text3)", border: EDGE }}
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
        <div className="flex items-center gap-2 px-2.5 py-1.5 shrink-0 flex-wrap" style={{ borderBottom: LINE }}>
          <div className="flex rounded-md overflow-hidden shrink-0" style={{ border: EDGE }}>
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
            className={`flex-1 min-w-[160px] ${INPUT}`}
            style={q ? { ...INPUT_STYLE, border: "1px solid var(--primary)" } : INPUT_STYLE} />
          {orderers.length > 0 && (
            <div className="flex rounded-md overflow-hidden shrink-0" style={{ border: EDGE }}
              title="Sort by time, or by the numbers an installed plugin gave the rows">
              {[["Time", null], ...orderers.map((p) => [p, p] as const)].map(([label, id]) => {
                const on = (sortBy && orderers.includes(sortBy) ? sortBy : null) === id;
                return (
                  <button key={String(label)} onClick={() => setSortBy(id as string | null)}
                    className="agx-btn text-[10.5px] px-2 py-0.5"
                    style={{ color: on ? "var(--bg)" : "var(--text2)", background: on ? "var(--primary)" : "transparent" }}>{label}</button>
                );
              })}
            </div>
          )}
          {!(sortBy && orderers.includes(sortBy)) && (
            <button onClick={() => setNewest((v) => !v)} className="agx-btn rounded-md px-2 py-1 text-[10.5px] shrink-0"
              style={{ color: "var(--text3)", border: EDGE }}
              title="Turn the order round">
              {newest ? "Newest first" : "Oldest first"}
            </button>
          )}
          <RefreshButton onRefresh={() => load(true)} busy={busy}
            title={at ? `Read ${fmtAgo(at)}` : "Read the inbox again"} />
        </div>

        {/* Select all, and what you can do to what is selected. */}
        <div className="flex items-center gap-2 px-2.5 py-1.5 shrink-0" style={{ borderBottom: LINE }}>
          <button className="agx-btn flex items-center gap-2 text-[10.5px] rounded px-1 py-0.5"
            style={{ color: "var(--text2)" }}
            onClick={() => setPicked(allPicked ? new Set() : new Set(rows.map((n) => n.id)))}>
            <Tick on={allPicked} /> Select all
          </button>
          {picked.size > 0 && (
            <>
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
            </>
          )}
          <span className="flex-1" />
          {err && <span className="text-[10.5px]" style={{ color: "var(--warning-ink)" }} title={err}>GitHub: {err.slice(0, 60)}</span>}
        </div>

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
              {shelf === "done" ? "Nothing finished yet." : shelf === "saved" ? "Nothing saved yet." : unreadOnly ? "Nothing unread. Good." : "Nothing here."}
            </div>
          )}
          {byDay(rows).map((group) => (
            <div key={group.label}>
              <div className="px-2.5 py-1 text-[9.5px] uppercase tracking-wider sticky top-0 z-10"
                style={{ color: "var(--text4)", background: "var(--bg)", borderBottom: LINE }}>{group.label}</div>
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
