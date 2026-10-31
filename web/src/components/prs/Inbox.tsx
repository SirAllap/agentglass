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
 * whole width and a row per thread can say what, where, why and how long ago
 * (the mockup's `.irow`: tick, tile, title, tag, CI dot, age, verbs). The verbs
 * show on hover; the tick is always drawn, because a bulk pick that cannot be
 * seen cannot be started. The filter text comes from outside (`filterText`,
 * the panel keeps it) and is typed in a box in this header, not in the panel's
 * bar, which is the board's search. Two differences from GitHub's own inbox, both deliberate:
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
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { usePoll } from "../../lib/usePoll.ts";
import type { InboxItem, PrSummary } from "../../../../shared/types.ts";
import { api } from "../../lib/api.ts";
import { botOnly, CHIP_FACETS, emptyCopy, FACETS, facetCounts, facetOrder, filterInbox, inboxScreen, inFacet, orderByAnnotation, reasonChips, reasonSentence, rowLook, searchInbox, sorters, tagLabel, TURN_CHIP, turnLine, yourTurn, type RowIcon, type RowToneName } from "../../lib/ghInbox.ts";
import { doneIds, isDone, isSaved, onShelf, savedIds, setDone, setSaved, subscribeMarks, type Shelf } from "../../lib/inboxMarks.ts";
import { fmtAgo } from "../../lib/format.ts";
import { inboxCiLine, inboxCiState } from "../../lib/inboxCiText.ts";
import { jobIdOf } from "../../lib/prFailureHint.ts";
import { failureKey, loadCached, summaryOf, useFailureStore } from "../../lib/checkFailuresStore.ts";
import { openPr } from "../../lib/openPrs.ts";
import { useDialogs } from "../ConfirmDialog.tsx";
import { openIssue } from "../../lib/openIssue.ts";
import { Spinner } from "../Spinner.tsx";
import { HIT, ICON } from "../../lib/iconSize.ts";
import { CaretIcon, CircleIcon, CommentIcon, DoneIcon, EyeIcon, InboxIcon, MoreIcon, PlayIcon, PullRequestIcon, SortIcon, StarIcon, UndoIcon, WarningIcon } from "../../lib/glyphIcons.tsx";
import { Button, FilterField, RefreshButton, Segmented } from "../workspace/Chrome.tsx";
import { AnchoredMenu } from "../AnchoredMenu.tsx";
import { MenuItem } from "../PrPanel.tsx";
import { PrBlank } from "../TriageBoard.tsx";
import { PrNotice } from "../PrNotice.tsx";
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


const TILE_ICON: Record<RowIcon, (p: { size: number }) => ReactNode> = {
  pr: PullRequestIcon, issue: CircleIcon, ci: PlayIcon, comment: CommentIcon, review: EyeIcon,
};
/** The row's tone as a colour (the hue) and as text on a wash (the ink). Tokens only, so dark follows. */
const TONE: Record<RowToneName, { hue: string; ink: string }> = {
  info: { hue: "var(--info)", ink: "var(--info-ink, var(--info))" },
  bad: { hue: "var(--error)", ink: "var(--error)" },
  warn: { hue: "var(--warning)", ink: "var(--warning-ink)" },
  muted: { hue: "var(--text3)", ink: "var(--text3)" },
};
const CI_DOT = {
  ok: { color: "var(--success)", words: "CI passing" },
  bad: { color: "var(--error)", words: "CI failing" },
  run: { color: "var(--warning)", words: "CI running" },
} as const;

/** The 16px pick box. A checkbox by role, drawn by hand: see `.agx-itick`. */
function Tick({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button type="button" role="checkbox" aria-checked={on} aria-label={label} title={label} onClick={onClick} className="agx-itick agx-btn">
      {on && (
        /* ICON.xs is the floor for a stroked glyph, tick included. */
        <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M4 12l5 5L20 6" />
        </svg>
      )}
    </button>
  );
}

/** A square or labelled button that opens a menu under itself. */
function Pop({ label, title, square, children }: { label: ReactNode; title: string; square?: boolean; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  return (
    <div className="relative shrink-0 flex" ref={box}>
      <Button square={square} label={square ? title : undefined} title={title} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{label}</Button>
      {open && <AnchoredMenu anchor={box} align="right" onClose={close}>{children(close)}</AnchoredMenu>}
    </div>
  );
}

export function Inbox({ repo, root, prs, onFlash, onUnread, active = true, filterText, onFilterText, unreadOnly, onUnreadOnly }: {
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
  filterText: string;
  onFilterText: (v: string) => void;
  /** The panel keeps the switch, so it survives leaving the view; the "More" menu here turns it. */
  unreadOnly: boolean;
  onUnreadOnly: (v: boolean) => void;
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
  const q = filterText;
  const setQ = onFilterText;
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

  /** One thread, as a row. `ghost` is a bot-only update the person asked to
   *  see: same anatomy, quieter, and labelled for what it is. */
  const renderRow = (n: InboxItem, ghost: boolean) => {
    const turnView = n.turn && (shelf === "turn" || ghost);
    const chip = turnView ? TURN_CHIP[n.turn!.kind] : null;
    const line = turnView ? turnLine(n.turn!) : null;
    const ci = root ? inboxCiLine(n, prs, (job) => summaryOf(failureKey(root, job))) : null;
    const dot = inboxCiState(n, prs, repo);
    const reason = chip ? chip.label : tagLabel(n.reason);
    const look = rowLook(n);
    const tone = TONE[look.tone];
    /* The two turn chips that ask something of you wear their own tone; the rest wear the reason's. */
    const tag = chip && chip.tone !== "neutral" ? TONE[chip.tone === "accent" ? "warn" : chip.tone] : tone;
    const Icon = TILE_ICON[look.icon];
    const unread = n.unread && !ghost;
    const saved = isSaved(n.id);
    const done = isDone(n.id);
    return (
      <div key={n.id} className="agx-irow" data-unread={unread ? "1" : undefined} data-ghost={ghost ? "1" : undefined}
        data-nopage={n.number == null ? "1" : undefined} style={{ "--tone": tone.hue } as CSSProperties}
        onClick={(e) => { if (!(e.target as HTMLElement).closest("button")) open(n); }}>
        <Tick on={picked.has(n.id)} label={picked.has(n.id) ? "Unpick" : "Pick"}
          onClick={() => setPicked((s) => { const next = new Set(s); if (next.has(n.id)) next.delete(n.id); else next.add(n.id); return next; })} />
        <span aria-hidden className="agx-srow-tile" title={n.type}><Icon size={ICON.xs} /></span>
        <button type="button" className="agx-btn min-w-0 text-left" onClick={() => open(n)}
          disabled={n.number == null}
          title={n.number == null ? `${n.type} \u2014 no page for this in the app` : `Open ${n.repo} #${n.number}`}>
          <span className="agx-irow-tt">
            <span className="min-w-0 break-words">{n.title}</span>
            {unread && <span role="img" aria-label="Unread" className="agx-udot" />}
          </span>
          {/* One quiet line, as the design has it: what happened, in words. Where it happened is the repository's name only when the list spans more than one, and the number is in the tooltip. */}
          <span className="agx-irow-ss" title={ci ? ci.text + ci.tail : undefined}>
            {ci ? (
              <><span className="truncate">{ci.text}</span><span className="shrink-0 whitespace-pre">{ci.tail}</span></>
            ) : line && (line.by || line.text) ? (
              <span className="truncate">
                {line.by && <span style={{ color: "var(--text2)" }}>{line.by}</span>}{line.by && line.text ? " " : ""}{line.text}
              </span>
            ) : <span className="truncate">{reasonSentence(n.reason)}</span>}
            {n.repo !== repo && <span className="truncate shrink-0">{" \u00b7 "}{n.repo}{n.number != null ? ` #${n.number}` : ""}</span>}
          </span>
        </button>
        <span className="flex items-center justify-end gap-1.5 min-w-0">
          {n.annotations?.map((a) => a.badge && (
            <Chip key={a.plugin} tone={TO_ROW_TONE[a.badge.tone ?? "default"]} title={a.tip ? `${a.tip} \u2014 ${a.plugin}` : a.plugin}>{a.badge.text}</Chip>
          ))}
          <span className="agx-pc-tag" style={{ color: tag.ink, borderColor: `color-mix(in srgb, ${tag.hue} 35%, transparent)`, background: `color-mix(in srgb, ${tag.hue} 10%, transparent)` }}>{reason}</span>
          {dot && <span role="img" aria-label={CI_DOT[dot].words} title={CI_DOT[dot].words} className="agx-udot" style={{ background: CI_DOT[dot].color }} />}
          <span className="agx-irow-ss w-8 text-right tabular-nums" style={{ margin: 0 }} title={new Date(n.at).toLocaleString()}>{fmtAgo(n.at)}</span>
        </span>
        {/* Per-row verbs, drawn at rest as the design has them; one that does not apply is dimmed, not hidden, so nothing moves. */}
        <span className="agx-irow-acts">
          <Button size="hit" square tone="quiet" label="Mark read" title={n.unread ? "Mark it read on GitHub" : "Already read"}
            disabled={busy || !n.unread} onClick={() => void act([n.id], "read")}><EyeIcon size={ICON.sm} /></Button>
          <Button size="hit" square tone="quiet" label={saved ? "Saved" : "Save"} aria-pressed={saved}
            title={saved ? "Take it off the saved shelf" : "Save it (kept on this machine)"}
            style={saved ? { color: "var(--warning)" } : undefined}
            onClick={() => setSaved(n.id, !saved)}><StarIcon size={ICON.sm} filled={saved} /></Button>
          <Button size="hit" square tone="quiet" label={done ? "Put back" : "Done"}
            title={done ? "Put it back in the inbox" : "Finish with it \u2014 hides it here and marks it read on GitHub"}
            onClick={() => {
              setDone(n.id, !done);
              if (!done && n.unread) void act([n.id], "read");
            }}>{done ? <UndoIcon size={ICON.sm} /> : <DoneIcon size={ICON.sm} />}</Button>
        </span>
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

  const screen = inboxScreen(raw === null ? null : raw.length, err, rows.length);
  const count = (n: number) => <span className="tabular-nums text-[10.5px]" style={{ opacity: 0.7 }}>{n}</span>;
  const byPlugin = !!sortBy && orderers.includes(sortBy);
  const empty = emptyCopy({ shelf, repo, query: q, reason: !!facet, unreadOnly });
  /* The one place a bot is mentioned: a line at the end, never a row. Silence
     would make this view look broken next to GitHub's own inbox ("where is my
     pull request?"), and a row would break what the view promises. Above an
     empty screen, so it is not pushed off the bottom by it. */
  const botBlock = screen !== "loading" && screen !== "error" && botRows.length > 0 && (
    <>
      <div className="flex items-center gap-1.5 px-3 py-2 text-[10.5px]" style={{ color: "var(--text3)" }}>
        <span>{botRows.length} update{botRows.length === 1 ? "" : "s"} on your pull requests {showBots ? "where only bots wrote:" : "are hidden: only bots wrote them."}</span>
        <button className="agx-btn flex items-center gap-1 underline underline-offset-2" style={{ color: "var(--text2)" }}
          aria-expanded={showBots} onClick={() => setShowBots((v) => !v)}>
          {showBots ? "Hide them" : "Show them"}
          <span aria-hidden className="flex" style={{ transform: showBots ? "rotate(180deg)" : undefined }}><CaretIcon size={ICON.xs} /></span>
        </button>
      </div>
      {showBots && botRows.map((n) => renderRow(n, true))}
    </>
  );

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Shelves, repository, the order and the more menu: one strip. Wraps rather than scrolls, so nothing is ever hidden at 1100 px. */}
      <div className="flex items-center gap-2 px-3 pt-3 pb-1.5 shrink-0 flex-wrap">
        <Segmented<Shelf | "turn"> label="Shelf" value={shelf} onChange={(v) => { setShelf(v); setPicked(new Set()); }}
          options={[
            { id: "inbox", label: <>Inbox {count(counts.inbox)}</>, title: "Everything not finished" },
            { id: "turn", label: <>Your turn {count(counts.turn)}</>, title: "Review requests, mentions, changes requested, and people writing on your pull requests" },
            { id: "saved", label: <>Saved {count(onShelf(all, "saved").length)}</>, title: "Kept by you, on this machine \u2014 GitHub's API has no shelf for it" },
            { id: "done", label: <>Done {count(onShelf(all, "done").length)}</>, title: "Finished by you, on this machine" },
          ]} />
        {/* This panel is one repository at a time, so its own is the default
            and the rest are one press away rather than mixed in. The picker is
            drawn only when the inbox holds another repository to pick. */}
        {(allRepos || repoCounts.some((r) => r.value && r.value !== repo)) && <Pop title="Which repository" label={<>
          <span className="truncate max-w-[220px]">{allRepos ? "Everywhere" : repo || "This repository"}</span>
          <span className="tabular-nums" style={{ color: "var(--text3)" }}>({allRepos ? onView(shelf).length : here_n})</span>
          <CaretIcon size={ICON.xs} /></>}>
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
        </Pop>}
        <span className="flex-1" />
        <FilterField value={q} onChange={setQ} placeholder="Filter inbox" label="Filter the inbox by title, repository or number" className="!h-[28px] !w-[200px] !text-[11px]" />
        {/* Drawn always, as the design has it. With no plugin giving the rows numbers the group is off, and says so, rather than leaving the choice out. */}
        <Segmented<string> label="Sort" value={byPlugin ? sortBy! : "time"} disabled={orderers.length === 0}
          onChange={(v) => setSortBy(v === "time" ? null : v)}
          options={[
            { id: "time", label: newest ? "Newest" : "Oldest", title: "Order by time" },
            ...(orderers.length
              ? orderers.map((p) => ({ id: p, label: orderers.length === 1 ? "By plugin" : p, title: `Order by the numbers ${p} gave the rows` }))
              : [{ id: "plugin", label: "By plugin", title: "No plugin has given these rows numbers to order by" }]),
          ]} />
        <Button square label="Reverse order" aria-pressed={!newest} on={newest ? undefined : true} disabled={byPlugin}
          title={byPlugin ? "A plugin's order has no reverse" : "Turn the order round"} onClick={() => setNewest((v) => !v)}><SortIcon size={ICON.sm} /></Button>
        <RefreshButton onRefresh={() => load(true)} busy={busy}
          title={at ? `Read ${fmtAgo(at)}` : "Read the inbox again"} />
        {/* The bulk verbs GitHub gives that are not per-thread, kept in the view
            and not in the panel's bar. Per repository rather than global,
            because "all of them everywhere" is a press nobody can take back. */}
        <Pop square title="More" label={<MoreIcon size={ICON.sm} />}>
          {(close) => (
            <>
              <MenuItem icon={unreadOnly ? <DoneIcon size={ICON.sm} /> : undefined} onClick={() => { close(); onUnreadOnly(!unreadOnly); }}>Unread only</MenuItem>
              {FACETS.filter((f) => !CHIP_FACETS.includes(f.id)).map((f) => (
                <MenuItem key={f.id} icon={facet === f.id ? <DoneIcon size={ICON.sm} /> : undefined}
                  onClick={() => { close(); setFacet(facet === f.id ? "" : f.id); setPicked(new Set()); }}>{`${f.label} (${chips.find((c) => c.id === f.id)?.n ?? 0})`}</MenuItem>
              ))}
              <MenuItem onClick={() => { close(); void act(unreadHere, "read"); }}>{`Mark all read (${unreadHere.length} shown)`}</MenuItem>
              <MenuItem danger onClick={() => { close(); void markRepoRead(); }}>Mark this repository read</MenuItem>
            </>
          )}
        </Pop>
      </div>

      {/* Reasons. */}
      <div className="flex items-center gap-1.5 px-3 pb-2 shrink-0 flex-wrap" role="group" aria-label="Reason">
        {/* Six chips and no numbers, as drawn. The two GitHub filters the design leaves out wait in "More"; one that is on is drawn too. */}
        {chips.filter((c) => c.id === "" || CHIP_FACETS.includes(c.id) || c.id === facet).map((c) => {
          const on = facet === c.id;
          return (
            <button key={c.id || "all"} type="button" aria-pressed={on} title={c.id ? `${c.hint} \u2014 ${c.n} here` : c.hint} data-sm=""
              onClick={() => { setFacet(on ? "" : c.id); setPicked(new Set()); }}
              className="agx-vchip">
              {c.label}
            </button>
          );
        })}
        <span className="flex-1" />
        {/* A refused read with rows already on screen: the rows stay, and this says they may be old. */}
        {err && screen !== "error" && <span className="inline-flex items-center gap-1 text-[10.5px]" style={{ color: "var(--warning-ink)" }} title={err}><WarningIcon size={ICON.xs} />GitHub: {err.slice(0, 60)}</span>}
      </div>

      {/* The list. */}
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        <div className="flex-1 min-h-0 overflow-y-auto agx-scroll px-3">
          {screen === "loading" && <div className="p-3"><Spinner label="Reading your notifications…" className="" /></div>}
          {screen === "error" && (
            <PrNotice title="GitHub said no" reason={`GitHub: ${err}`}
              actions={<Button tone="primary" size="hit" pending={busy} onClick={() => load(true)}>Try again</Button>}>
              The notifications read was refused.
            </PrNotice>
          )}
          {screen === "empty" && botBlock}
          {screen === "empty" && (
            <PrBlank icon={<InboxIcon size={ICON.lg} />} title={empty.title} sentence={empty.sentence} ghost={empty.ghost}>
              {empty.clear
                ? <Button size="hit" onClick={() => setQ("")}>Clear the filter</Button>
                : <RefreshButton onRefresh={() => load(true)} busy={busy} title="Read the inbox again" />}
            </PrBlank>
          )}
          {/* One flat list, newest first, as the design draws it: the day is the age on the right of each row. */}
          {rows.map((n) => renderRow(n, false))}
          {screen === "rows" && botBlock}
        </div>
      </div>

      {/* What you can do to what is ticked. Only while something is. */}
      {picked.size > 0 && (
        <div className="agx-pickbar" role="toolbar" aria-label="Selected notifications">
          <Tick on={allPicked} label="Select all" onClick={() => setPicked(allPicked ? new Set() : new Set(rows.map((n) => n.id)))} />
          <b className="tabular-nums">{picked.size} selected</b>
          <span className="flex-1" />
          <Button size="hit" disabled={busy} onClick={() => void act([...picked], "read")}><EyeIcon size={ICON.sm} />Mark read</Button>
          <Button size="hit" onClick={() => { for (const id of picked) setSaved(id, true); setPicked(new Set()); }}><StarIcon size={ICON.sm} />Save</Button>
          <Button size="hit" disabled={busy}
            onClick={() => { for (const id of picked) setDone(id, true); void act([...picked], "read"); }}><DoneIcon size={ICON.sm} />Done</Button>
          <Button size="hit" tone="danger" disabled={busy} onClick={() => void act([...picked], "unsubscribe")}>Unsubscribe</Button>
          <Button size="hit" tone="quiet" onClick={() => setPicked(new Set())}>Clear</Button>
        </div>
      )}
      {dialog}
    </div>
  );
}
