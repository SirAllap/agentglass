// The pull requests that want something from you, in lanes.
//
// A board rather than a table, and it is only ever a board over the pull
// requests you have a stake in — yours, and the ones you were asked to look at.
// Three hundred and ninety open pull requests are a table; the table is still
// there, one click away, and this never pretends it could show them.
//
// The two pills it replaces were "Mine" and "Needs my review", and they were
// mutually exclusive: the two populations you care about could not be on screen
// together. Here they are two lanes, side by side, which is the whole point.
//
// Nothing is fetched for this. It reads the two lists the panel already loads
// for the pill counts — see stakeFrom in prLanes.ts — so the board costs what
// the pill row cost, and the numbers cannot disagree with their source.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { HIT, ICON, MIN_BOX } from "../lib/iconSize.ts";
import { InfoIcon } from "./settingsNavIcons.tsx";
import { CircleIcon, CommentIcon, CopyIcon, CrossIcon, DoneIcon, DraftIcon, FlagIcon, LinkIcon, PinIcon, RefreshIcon, SearchIcon, WarningIcon } from "../lib/glyphIcons.tsx";
import { FACES_MAX, eventLine, splitTitle, standing } from "../lib/prCardZones.ts";
import { ALWAYS_OPEN, foldable, foldedLanes, setFoldedLanes, walkable } from "../lib/boardPrefs.ts";
import type { PrSummary } from "../../../shared/types.ts";
import { staleApproval } from "../../../shared/mergeBlockers.ts";
import { LANES, LANE_CAP, board as fileAll, suggestedAction, ACTION_LABEL, type Filed, type LaneId } from "../lib/prLanes.ts";
import { taskLink } from "../lib/taskLink.ts";
import { onCard, cardVersion, withCard } from "../lib/prCardStore.ts";
import { CHIP_H } from "../lib/priority.tsx";
import { CardTracker } from "./CardTracker.tsx";
import { repoUsesTracker, trackerBlock } from "../lib/prCardBlock.ts";
import { CTRL_H, EDGE, LINE } from "./workspace/Chrome.tsx";
import { CODE_FONT_STYLE } from "./diff/DiffLines.tsx";
import { Avatar } from "./Avatar.tsx";
import { askingBehind, behindOf, onBehind } from "../lib/prBehindStore.ts";
import { onRollup, rollupOf } from "../lib/prRollupStore.ts";
import { failureHint, jobIdOf } from "../lib/prFailureHint.ts";
import { failureKey, loadCached, summaryOf, useFailureStore } from "../lib/checkFailuresStore.ts";
import { stamp } from "../lib/whenStamp.ts";
import { onSeenChange, readSeen } from "../lib/prNew.ts";
import { unreadOf, type Unread } from "../lib/prUnread.ts";
import { UnreadBadge } from "./UnreadBadge.tsx";
import { matchIndex, prMatches, stepMatch } from "../lib/prBoardFind.ts";
import { closeFind, openFind, registerEngine, topScope } from "../lib/findScope.ts";
import { CloseIcon } from "./CloseButton.tsx";
import { boardFace } from "../lib/boardFace.ts";
import { useClickupSetup } from "../lib/clickupSetup.ts";

/** The tracker bar's tint: the app's own accent, the one an unranked card chip already wears. */
const ACCENT = "var(--accent, var(--primary))";

const TRUNKS = new Set(["main", "master", "trunk", "develop", "development"]);

/** How long nothing may happen before a pull request counts as quiet. */
const QUIET_DAYS = 30;

/**
 * Has nothing at all happened to it in a month?
 *
 * `updatedAt` is the only clock on `PrSummary`, and it is GitHub's "last
 * touched by anything" — a push, a comment, a label. There is no push
 * timestamp on a summary and asking for one would be the per-card request this
 * board exists to avoid, so the footer says what is actually measured: thirty
 * days without a push OR a comment. Everything counted here really has had no
 * push, because a push would have moved this; there may be more that were
 * commented on and never pushed to. A floor, never an invention.
 *
 * A date that will not parse is not quiet. The list arrives in two passes and
 * fixtures hand over empty strings — counting those would put a number on
 * screen whose real meaning is "we could not read it".
 */
function quietAWhile(iso: string): boolean {
  const t = Date.parse(iso);
  return Number.isFinite(t) && Date.now() - t > QUIET_DAYS * 86_400_000;
}

type Card = PrSummary & { filed: Filed };

export function TriageBoard({
  mine, review, total, hasTaskProvider, pinned,
  onOpen, onTogglePin, onShowTable, onAct, busy, acting, loading, settling, failed, hidden, onRetry, root, repoKey,
  onlyUnread, onOnlyUnread,
}: {
  /** The `mine` scope, as the panel already has it. */
  mine: PrSummary[];
  /** The `review` scope, likewise. Membership of these two IS the stake. */
  review: PrSummary[];
  /** Every open pull request, for the sentence that states the board's scope. */
  total: number;
  /** Whether anything is connected that could resolve a work-item id — see
   *  taskLink.ts for why a convention-shaped id is hidden without one. */
  hasTaskProvider: boolean;
  pinned: (n: number) => boolean;
  onOpen: (n: number) => void;
  onTogglePin: (p: PrSummary) => void;
  onShowTable: () => void;
  /** Perform the card's one suggested action. Only the ones this app can
   *  really do reach here — see suggestedAction. */
  onAct: (p: PrSummary, what: "open" | "merge" | "rerun") => void;
  /** True while an action is in flight, so a card cannot be pressed twice. */
  busy?: boolean;
  /** Which pull request that action is on. The board disables every card while
   *  one runs; the spinner belongs to the one you pressed. */
  acting?: number | null;
  /**
   * The two lists are still being fetched and nothing has arrived yet.
   *
   * Without this the board cannot tell its two zeroes apart: `mine` and
   * `review` start as empty arrays and are replaced when the calls land, so a
   * board that has not loaded renders exactly like a board with nothing on it
   * — five "Nothing here. Good." columns, which is a claim, on no evidence, at
   * the moment the answer is least knowable. Optional because a caller that
   * cannot say gets today's behaviour rather than a wrong wait.
   */
  loading?: boolean;
  /**
   * The rows are here and their check states are not.
   *
   * The list arrives in two passes, and which lane a pull request belongs in is
   * mostly a question about its checks — so a board painted from the first pass
   * files everything it cannot decide under "yours, in flight" and then moves
   * it when the second lands. Reported exactly that way: cards appearing in one
   * column and hopping to another a few seconds later.
   *
   * A card that moves on its own is worse than a card that is late. So the
   * skeleton stays up until the answer is whole — with a deadline, held by the
   * caller, because a rollup that never arrives must not mean a board that
   * never draws.
   */
  settling?: boolean;
  /**
   * A list could not be read on the last ask. With no rows to show, "nothing
   * wants anything from you" would be an answer nobody gave, so the board says
   * what happened instead. See boardFace.ts.
   */
  failed?: boolean;
  /** Rows that arrived and were hidden by the board's own filters, so an empty
   *  board can say it is the filters and not the repository. */
  hidden?: number;
  /** Ask again, from the failed state. */
  onRetry?: () => void;
  /** The checkout these pull requests belong to — needed to ask how far behind
   *  each branch is, which is not on the list payload. See prBehindStore. */
  root?: string;
  /**
   * `owner/name`, and it must be the SAME string the conversation writes its
   * "last looked" marks under — they are keyed by repository because pull request
   * numbers are per repository. Absent means the badge cannot be trusted to
   * belong to this project, so nothing is drawn. See prSeenKey.
   */
  repoKey?: string;
  /**
   * The filter bar's own switch, not a second one kept here.
   *
   * Measured: the bar's "N unread" chip toggled a state in the panel that this
   * board never read, so pressing it changed nothing on screen here — two
   * chips, both saying "N unread", answering to two different switches. There
   * is one `unreadOnly` now, owned by the panel; this component only reads it
   * and asks to flip it.
   */
  onlyUnread: boolean;
  onOnlyUnread: (v: boolean) => void;
}) {
  /* Answers arriving one at a time, each one a re-render of the board and
     nothing else — the cards do not move, a chip appears on one of them. */
  const [, bump] = useState(0);
  useEffect(() => onBehind(() => bump((n) => n + 1)), []);
  /*
   * A card that claims failure asks whether it is true.
   *
   * The list's rollup is GitHub's aggregate counts, which count a re-run's old
   * attempt beside the new one — measured on a pull request their own page
   * calls "All checks have passed" and whose aggregate says FAILURE. Only the
   * cards claiming red ask, only while they are on screen, and the answer is
   * remembered for a minute. Everything green is already telling the truth.
   */
  const [rollupTick, bumpRollup] = useState(0);
  useEffect(() => onRollup(() => bumpRollup((n) => n + 1)), []);
  const trueChecks = useCallback((p: PrSummary): PrSummary => {
    if (!root || !p.checks || p.checks.failure === 0) return p;
    /* Keyed by what the list says of it: the answer stands until the head
       commit or the aggregate moves. See SAME_MS in prRollupStore. */
    const real = rollupOf(root, p.number, `${p.headSha ?? ""}|${JSON.stringify(p.checks)}`);
    return real ? { ...p, checks: real } : p;
  }, [root]);

  /* WHICH TEST is failing, from what the app already read and kept. One request
     to this server's own cache, for the red cards on the board; nothing here
     reaches GitHub, and a card whose failures nobody opened says what it always
     did. Asked again only when a card's checks move. */
  const failureTick = useFailureStore();
  useEffect(() => {
    if (!root) return;
    const ids = new Set<string>();
    for (const p of [...mine, ...review]) for (const c of trueChecks(p).checks?.failing ?? []) { const j = jobIdOf(c); if (j) ids.add(j); }
    if (ids.size) void loadCached(root, [...ids]);
  }, [root, mine, review, trueChecks, rollupTick]);

  const lanes = useMemo(() => {
    // De-duplicated by number before filing: a pull request that is both yours
    // and asked of you arrives twice, and would otherwise be drawn twice.
    const by = new Map<number, PrSummary>();
    for (const p of [...mine, ...review]) if (!by.has(p.number)) by.set(p.number, trueChecks(p));
    const m = new Set(mine.map((p) => p.number));
    const r = new Set(review.map((p) => p.number));
    return fileAll([...by.values()], (p) => ({ mine: m.has(p.number), asked: r.has(p.number) }),
      (p) => (root && p.checks?.failing?.length ? failureHint(p.checks.failing, (job) => summaryOf(failureKey(root, job))) : null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mine, review, trueChecks, bumpRollup, root, failureTick]);

  const cards = useMemo(() => [...lanes.values()].flat(), [lanes]);
  /* Per repository: this board IS one repository's, so the answer is read off
     every card on it. See prCardBlock.ts for the rule and its ceiling. */
  const noCustomIds = useClickupSetup()?.noCustomIds === true;
  const repoUses = useMemo(() => repoUsesTracker(cards, hasTaskProvider, noCustomIds), [cards, hasTaskProvider, noCustomIds]);
  const involved = cards.length;
  const canLand = lanes.get("land")?.length ?? 0;
  // Only over the cards in hand. The other few hundred are not loaded here and
  // never will be — see the footer, which says whose staleness this is.
  const quiet = useMemo(() => cards.filter((p) => quietAWhile(p.updatedAt)).length, [cards]);

  /* Waiting is only waiting while there is nothing to show. A refresh with the
     previous answer still on screen must not blank it: last minute's board is
     a better answer than a skeleton, and it is about to be right again.
     `settling` is the other half — see the prop. */
  const face = boardFace({ reading: !!loading, settling: !!settling, involved, failed: !!failed, hidden: hidden ?? 0 });
  const waiting = face === "waiting";
  const rest = total - involved;
  /*
   * Whether `total` can be repeated out loud.
   *
   * It is the panel's count of every open pull request, and it has been wrong:
   * it used to be the CURRENT FILTER's count, which had the board announce
   * "the other 0 are a table" over a repository with 388 open. A total smaller
   * than the board standing in front of it is the one case that is provably
   * wrong from in here — the two lists are the evidence — so every sentence
   * built on it drops its number instead of repeating it. Clamping is how a
   * wrong number gets to sound like a right one.
   */
  const totalKnown = rest >= 0;
  const tableLabel = rest > 0 ? `Show all ${total} as a table` : "Show the table";

  /*
   * The columns actually drawn.
   *
   * `LANES` is the policy; this is the screen. Only one lane opts out of being
   * shown empty — see `hideWhenEmpty` — and everything downstream counts
   * columns rather than lanes so the keyboard's 1–5, the h/l walk and the grid
   * template all agree with what is in front of you.
   */
  const cols = useMemo(
    () => LANES.filter((l) => !l.hideWhenEmpty || (lanes.get(l.id)?.length ?? 0) > 0),
    [lanes],
  );
  /*
   * What is being looked for in the cards on screen.
   *
   * Everything a card SHOWS is searchable, and nothing it does not: the number,
   * the title, the author, both branches and the labels. Matching on something
   * invisible is how a search comes back with a card whose row says nothing
   * about why it is there.
   */
  const [find, setFind] = useState("");
  const needle = find.trim().toLowerCase();
  /*
   * Which of these has been spoken on since you last looked.
   *
   * The marks are localStorage, not React state, so a mark that moves — you open
   * a pull request, read it, come back — has to say so or the badge stays up on
   * the one thing you know you have read. See onSeenChange.
   */
  const [seenTick, bumpSeen] = useState(0);
  useEffect(() => onSeenChange(() => bumpSeen((n) => n + 1)), []);
  const unread = useMemo(() => {
    const seen = readSeen();
    const m = new Map<number, Unread | null>();
    for (const p of cards) m.set(p.number, unreadOf(p, repoKey, seen));
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards, repoKey, seenTick]);
  const unreadCount = useMemo(() => cards.filter((p) => unread.get(p.number)).length, [cards, unread]);
  /* Lit rather than filtered, like the find box beside it — see `matches`.
     `onlyUnread` itself is a prop now, not state — see the note on it above. */
  /*
   * ONE LANE LIT, from the counts row.
   *
   * That row was a summary and nothing else, and the note above it said why: a
   * row of buttons there "would read as filters that shrink the board". The
   * objection is right and this is not it. Nothing is removed — the same rule
   * the find box and the unread toggle already follow: the cards that answer
   * keep their colour and the rest go quiet, in the same lanes, at the same
   * heights, under counts that still add up.
   *
   * Asked for directly, looking at a board of five columns where the row was
   * the only thing on screen that named all five: "it should do something, like
   * a button to filter". It should.
   */
  const [onlyLane, setOnlyLane] = useState<string | null>(null);
  /* The rule itself lives in prBoardFind.ts — the app's own find bar drives the
     same one, so there is one search on this screen rather than two that
     disagree about what a card is. */
  const matches = useCallback((p: PrSummary) => {
    if (onlyUnread && !unread.get(p.number)) return false;
    return prMatches(p, needle);
  }, [needle, onlyUnread, unread]);
  /* What is LIT, which is the number the row beside it prints. A lane filter
     narrows it the same way the needle does — two ways of lighting the same
     board, so one count answers for both rather than each keeping its own. */
  const litIn = useCallback((p: PrSummary, laneId: string) =>
    matches(p) && (onlyLane === null || onlyLane === laneId), [matches, onlyLane]);
  const hits = useMemo(() => {
    if (!needle && !onlyUnread && onlyLane === null) return 0;
    let n = 0;
    for (const [laneId, ps] of lanes) for (const p of ps) if (litIn(p, laneId)) n++;
    return n;
  }, [needle, onlyUnread, onlyLane, lanes, litIn]);
  /**
   * Lanes opened past their cap, by lane id.
   *
   * The cap keeps the board a glance, and the four it left over used to be a
   * button that sent you to the TABLE — a different surface, sorted
   * differently, with the lane you were reading nowhere in it. A board that
   * sends you elsewhere for the rest of a lane defeats the cards: the rest of a lane
   * belongs in the lane. The board already holds those rows; only the slice was
   * hiding them.
   */
  const [openLanes, setOpenLanes] = useState<Record<string, boolean>>({});
  /*
   * FOLDED LANES, and the arithmetic that made it worth doing.
   *
   * The board demands `5 × 268 + 4 × 10 + 32 = 1412` CSS pixels. His screen at
   * 175% leaves 1170, which is why the cards in his screenshot wrap and the
   * last one is cut off. A lane folded from 268 to 44 gives back 224 plus its
   * gap, so TWO folded lanes bring the minimum under 1000 — below his real
   * width, without a breakpoint and without anything moving on its own.
   *
   * FOLDING IS NOT FILTERING, and the board already refused that twice in
   * writing. Eight printed numbers derive from the flattened partition rather
   * than from what is drawn — the headline "22 of 391", the "9 can land right
   * now", each segment count, the footer. If a fold subtracted, all eight go
   * wrong at once and the footer becomes a lie: those pull requests still want
   * something from you, you just stopped looking. So a folded lane keeps its
   * number on its own strip, which is what every other fold in this app does.
   */
  const laneIds = useMemo(() => LANES.map((l) => l.id), []);
  const [folded, setFolded] = useState<string[]>(() => foldedLanes(laneIds));
  /*
   * FOLDED, and allowed to be.
   *
   * Asked with the count rather than off the stored list alone: a lane folded
   * while it was empty must come back the moment something lands in it. The
   * alternative was tried and is worse — "the lane this board exists for" would
   * sit as a 44px strip with a review waiting behind it, which is the exact
   * harm `ALWAYS_OPEN` was written to prevent, arrived at by a different route.
   *
   * It does move under the hand, and that is the lesser of the two: what moved
   * is a column reopening because somebody just asked you for a review.
   */
  const isFolded = useCallback((id: LaneId) =>
    folded.includes(id) && foldable(id, lanes.get(id)?.length ?? 0), [folded, lanes]);
  const toggleFold = useCallback((id: string, count: number) => {
    /* Refused only in the direction that hides something: unfolding is always
       allowed, so a lane that filled up while folded can still be opened. */
    if (!foldable(id, count) && !folded.includes(id)) return;
    setFolded((cur) => {
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
      setFoldedLanes(next);
      return next;
    });
  }, [folded]);
  const frame = useRef<HTMLDivElement>(null);
  /*
   * THE KEYS DID NOTHING, AND THE ROW BELOW THE COUNTS SAID THEY DID.
   *
   * Reported: "that legend doesn't work at all, it is a lie" — the strip
   * that reads `1–4 lane · j k card · h l across · ⏎ open · a open it · p pin`.
   * It was not lying about which keys exist; every one of them is handled in
   * `onKey` below. They were UNREACHABLE. The handler hangs off this div, the
   * div is `tabIndex={0}`, and nothing in this file ever focused it — a grep
   * for `.focus()` on `frame` returned nothing, and the only other use of the
   * ref was a `scrollIntoView`. Arriving at the board from the view rail left
   * the focus wherever it had been, so six advertised shortcuts answered to
   * nobody.
   *
   * ON MOUNT IS ON ARRIVAL HERE, and that is not a coincidence worth relying
   * on quietly: the board is mounted conditionally (`boardShown && repo && …`
   * in PrPanel) and the whole PR view is unmounted when it is not the view on
   * screen — `KEEP_RUNNING` in Workspace.tsx holds only the terminal and the
   * chat. So this effect runs when the board appears and not while it sits
   * behind another view. If either of those ever changes, this becomes a focus
   * steal, which is the failure it is guarded against below.
   *
   * The guard is the whole risk of the fix. Taking focus from somebody who is
   * typing is worse than the bug: the next character goes to a board that
   * reads `p` as "pin this". So a field that is already focused keeps it, and
   * the keys start working on the next click anywhere else.
   */
  useEffect(() => {
    const held = document.activeElement as HTMLElement | null;
    const typing = !!held && (
      held.tagName === "INPUT" || held.tagName === "TEXTAREA" || held.isContentEditable
    );
    if (!typing) frame.current?.focus({ preventScroll: true });
  }, []);
  // Keyboard navigation walks exactly what is drawn — an opened lane included,
  // or j past the cap would step onto a card nobody can see.
  const shown = useCallback((i: number) => {
    const id = cols[i]?.id ?? "review";
    /* A folded lane walks as empty, which is the app's own answer three times
       over — `DockerPanel.ordered` says it out loud: "so j/k walks what is on
       screen, skipping collapsed stacks rather than jumping into a container
       nobody can see". Without this the cursor sits on a card behind a 44px
       strip: the heal below only rescues an EMPTY lane, and a folded lane with
       six cards in it reports six. */
    return walkable(lanes.get(id) ?? [], {
      folded: isFolded(id), opened: !!openLanes[id], cap: LANE_CAP,
    });
  }, [lanes, cols, openLanes, isFolded]);

  /*
   * The app's find bar, driving this board.
   *
   * There were two searches on this screen and they did different things: the
   * one in the corner painted the words it could see and counted 1/1, and this
   * board's own box lit the cards that answer and counted 1 of 16 — including
   * the cards whose only match is a reviewer, an assignee or a branch name,
   * which the first one cannot see at all.
   *
   * So the bar now runs THIS one. Ctrl+F anywhere on the board sets the same
   * needle, dims the same cards and steps through the same matches; the box beside the
   * lanes is the visible half of it rather than a second feature. Registered as
   * an engine, which is the seam findScope already has for a view that searches
   * something other than the document (see FindEngine).
   *
   * Everything the engine needs is read through refs: it is called from outside
   * React, and a closure over this render's `cards` would search the board as
   * it was when the bar opened.
   */
  const cardsRef = useRef(cards);
  cardsRef.current = cards;
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const colsRef = useRef(cols);
  colsRef.current = cols;
  /* Where the last step landed. Not painted: a card that looked chosen read as
     a pull request state, and nothing else on the board moves it. */
  const stepAt = useRef({ lane: 0, row: 0 });
  useEffect(() => {
    /** Every card the board is DRAWING, in reading order, with where it sits. */
    const drawn = () => {
      const out: { lane: number; row: number; p: Card }[] = [];
      for (let lane = 0; lane < colsRef.current.length; lane++) {
        shownRef.current(lane).forEach((p, row) => out.push({ lane, row, p }));
      }
      return out;
    };
    const flagsFor = (q: string, list: ReturnType<typeof drawn>) => list.map((x) => prMatches(x.p, q));
    const here = (list: ReturnType<typeof drawn>) =>
      list.findIndex((x) => x.lane === stepAt.current.lane && x.row === stepAt.current.row);
    let q = "";
    return registerEngine(() => {
      /* Only while this board is the thing on screen. The panel keeps it
         mounted behind other views, and an engine that answered from there
         would have the find bar searching a board nobody is looking at — which
         is the exact bug findScope's scope stack exists to prevent, so the
         answer comes from the same place: is the top scope holding us. */
      const scope = topScope();
      const el = frame.current;
      if (!el || !scope || !(scope === el || scope.contains(el))) return null;
      return {
        label: "board",
        search(next) {
          q = next;
          setFind(next);
          // The board's own count, not a count of words on screen: a card that
          // matches on a reviewer has nothing on it to paint and is still a hit.
          return next.trim() ? cardsRef.current.filter((p) => prMatches(p, next)).length : 0;
        },
        step(dir) {
          const list = drawn();
          const to = stepMatch(flagsFor(q, list), here(list), dir);
          if (to < 0) return;
          const hit = list[to]!;
          stepAt.current = { lane: hit.lane, row: hit.row };
          frame.current?.querySelector<HTMLElement>(`[data-pr="${hit.p.number}"]`)
            ?.scrollIntoView({ block: "nearest", inline: "nearest" });
        },
        at() {
          const list = drawn();
          return matchIndex(flagsFor(q, list), here(list));
        },
        clear() { q = ""; setFind(""); },
      };
    });
  }, []);

  const onKey = (e: React.KeyboardEvent) => {
    /* ⌃F opens the app's own find bar, seeded with whatever is already being
       searched — the board no longer has a field of its own, and the bar is
       driving this search either way (see the engine above). */
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      openFind(find);
      return;
    }
    /* No other keys. The board used to answer 1-4, j/k/h/l, Enter, p and a; the
       last one fired on Ctrl+Alt+A, the chord that closes and opens the bench,
       and opened whatever card the cursor was resting on. Nobody used them. */
  };

  return (
    /*
     * `h-full`, and the whole layout below hangs off it.
     *
     * The board is handed a height by the panel — it must take it rather than
     * grow past it, because everything above the cards is what a board is FOR.
     * When this frame was allowed to grow, the panel's own scrollbar carried
     * it, and the first long lane pushed the scope sentence, the lane
     * headings and the keys off the top: you were left scrolling a wall of
     * cards with nothing on screen saying which lane you were in. The
     * scrolling belongs to each column, one per lane, below.
     */
    <div ref={frame} tabIndex={0} onKeyDown={onKey} className="flex flex-col h-full min-h-0 outline-none">
      {/* The scope, said out loud. A board whose reach nobody states is a board
          nobody trusts — and the first question anybody asks it is "where are
          the other three hundred". */}
      <div className="shrink-0 px-4 pt-3 pb-1 text-[12.5px] flex items-start gap-4">
        <div className="min-w-0 flex-1">
        {waiting || face === "failed" ? (
          <>
            {/* No number, because there is no number yet. A zero here is the
                same lie the empty lanes used to tell, in bigger type. */}
            <b className="text-[17px] font-semibold" style={{ color: "var(--text4)" }}>{waiting ? "…" : "—"}</b>
            <span className="ml-1">{waiting ? "Reading the two lists this board is made of" : "Could not read the two lists this board is made of"}</span>
            <span className="block text-[11px] mt-2" style={{ color: "var(--text3)" }}>
              {waiting
                ? "Yours, and the ones you were asked to look at. Until both are in, an empty lane means nothing."
                : "Nothing is claimed about them, not even that they are empty."}
            </span>
          </>
        ) : (
          <>
            <b className="text-[17px] font-semibold">{involved}</b>
            <span className="ml-1">
              {totalKnown ? `of ${total} open pull requests` : "open pull requests"} want something from you
            </span>
            <span className="block text-[11px] mt-2" style={{ color: "var(--text3)" }}>
              Yours, and the ones you were asked to look at. The board never shows more than that
              {" — "}
              <button onClick={onShowTable} style={{ color: "var(--primary-ink)" }}>
                {rest > 0 ? `the other ${rest} are a table` : "the rest are a table"}
              </button>.
              {canLand > 0 && <> <span style={{ color: "var(--success-ink)" }}>{canLand}</span> can land right now.</>}
            </span>
          </>
        )}
        </div>
        {/*
          * Find, in the board, in the space the summary leaves.
          *
          * Not the bar at the top: that one asks GitHub, and pressing return in
          * it leaves the board for a table of every pull request in the
          * repository. This is the other question — "which of THESE twelve" —
          * and the honest answer to it is not a shorter board. A card that
          * stops being drawn takes its lane'"'"'s shape with it, and the counts
          * above would start disagreeing with what is under them.
          *
          * So nothing is removed: the ones that match keep their colour and the
          * rest go quiet. Same board, same places, one part of it lit.
          */}
        {!waiting && involved > 0 && (
          <div className="shrink-0 flex items-center gap-1.5">
            {/*
              * "Which of these is somebody waiting on me in", as one press.
              *
              * Here rather than up with the lane counts, and that is deliberate:
              * those state the shape of the board and are not buttons (see the
              * comment on them). This narrows it — the same job as the box beside
              * it, and the same honest version of narrowing, which is to light
              * the answers and quieten the rest rather than to take cards out of
              * lanes whose counts are printed above them.
              *
              * Only when there is something to press it about, or when it is
              * already on — a toggle that vanishes while engaged is a board
              * stuck in a state with nothing on screen to leave it.
              */}
            {(unreadCount > 0 || onlyUnread) && (
              <button onClick={() => onOnlyUnread(!onlyUnread)}
                aria-pressed={onlyUnread}
                title={onlyUnread
                  ? "Show every card again"
                  : `Light only the ${unreadCount} with something said since you last looked`}
                className="agx-btn inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10.5px] tabular-nums"
                style={{
                  color: unreadCount ? "var(--warning)" : "var(--text3)",
                  border: `1px solid color-mix(in srgb, ${onlyUnread ? "var(--warning) 70%" : unreadCount ? "var(--warning) 40%" : "var(--text) 16%"}, transparent)`,
                  background: onlyUnread ? "color-mix(in srgb, var(--warning) 16%, transparent)" : "transparent",
                }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
                </svg>
                {unreadCount} unread
              </button>
            )}
            {/*
              * No box of its own any more.
              *
              * There were two on this screen doing the same job — the app's find
              * bar in the corner and one here — and now that ⌃F drives THIS
              * search (see the engine above), a second field is a second place
              * to type the same thing. What is left is the count, because it
              * says something the bar cannot: how many of the cards in front of
              * you answer, out of how many there are. The unread toggle beside
              * it lights cards the same way and needs the same line.
              */}
            {!find && !onlyUnread && onlyLane === null && (
              <button onClick={() => openFind()}
                title="Find in these cards — number, title, author, branch, labels, assignees, reviewers, card id, card status, card people"
                className="agx-btn inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[10.5px]"
                style={{ color: "var(--text3)", border: EDGE }}>
                <SearchIcon size={ICON.xs} />Find in these<span style={{ color: "var(--text4)" }}>⌃F</span>
              </button>
            )}
            {(find || onlyUnread || onlyLane !== null) && (
              <span className="text-[10.5px] tabular-nums whitespace-nowrap flex items-center gap-1.5"
                style={{ color: hits ? "var(--primary)" : "var(--warning)" }}>
                {find && <span className="font-medium">{find}</span>}
                {hits} of {involved}
                {/* One way out of every way in. A lane lit from the row above
                    is left by pressing that chip again, but the board should not
                    require you to remember which one you pressed. */}
                {(find || onlyLane !== null) && (
                  <button onClick={() => { setFind(""); closeFind(); setOnlyLane(null); }}
                    title={find ? "Clear the search (Esc)" : "Show every lane again"}
                    className="agx-btn rounded grid place-items-center w-5 h-5" style={{ color: "var(--text3)" }}><CloseIcon size={ICON.xs} /></button>
                )}
              </span>
            )}
          </div>
        )}
      </div>

      {/*
        * Every lane's count on one line.
        *
        * A summary, and deliberately not a second way to navigate: the lanes
        * are directly underneath, 1–5 already jumps to them, and a row of
        * buttons up here would read as filters that shrink the board. What it
        * buys is the lanes you cannot see — five columns at 268px do not fit a
        * narrow window, and the counts scrolled off the right edge are exactly
        * what you want before deciding to go and look.
        */}
      {!waiting && face !== "failed" && (
        <div className="shrink-0 flex flex-wrap gap-1 px-4 pb-1.5">
          {cols.map((l) => {
            const n = lanes.get(l.id)?.length ?? 0;
            const on = onlyLane === l.id;
            /* An empty lane has nothing to light, so it stays a plain chip:
               pressing it would put the board in a state where every card is
               quiet and the way out is the chip you just pressed. */
            const Tag = n ? "button" : "span";
            return (
              <Tag key={l.id} data-seg={l.id}
                {...(n ? {
                  onClick: () => setOnlyLane((v) => (v === l.id ? null : l.id)),
                  "aria-pressed": on,
                  title: on ? "Show every lane again" : `Light the ${n} in ${l.label.toLowerCase()}, quieten the rest`,
                } : {})}
                className={`inline-flex items-baseline gap-1.5 rounded px-2 py-0.5 text-[10.5px]${n ? " agx-btn" : ""}`}
                style={{
                  color: l.tint,
                  border: `1px solid color-mix(in srgb, ${l.tint} ${on ? "80%" : "45%"}, transparent)`,
                  background: on ? `color-mix(in srgb, ${l.tint} 16%, transparent)` : "transparent",
                  // An empty lane is still worth a segment — "none asked of you"
                  // is an answer — but it should not compete with a lane of six.
                  opacity: n ? 1 : 0.5,
                }}>
                <b className="tabular-nums font-semibold">{n}</b>
                <span style={{ color: on ? l.tint : "var(--text3)" }}>{l.label.toLowerCase()}</span>
              </Tag>
            );
          })}
          <span className="inline-flex items-baseline rounded px-2 py-0.5 text-[10.5px] tabular-nums"
            style={{ color: "var(--text4)", border: EDGE }}>
            {totalKnown ? `${involved} / ${total}` : `${involved} on the board`}
          </span>
        </div>
      )}

      {/* Sideways only. The five columns still have to be reachable on a narrow
          window; the up-and-down is each column's own, below. */}
      <div className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden agx-scroll px-4 pb-3">
        {face === "failed" || face === "filtered" ? (
          /* Neither is the answer "nothing", and each says which it is: a read
             that failed has no number to give, and rows the filters hid are
             still there, one press away. */
          <div className="h-full grid place-items-center text-center">
            <div style={{ maxWidth: 400 }}>
              <div className="text-[13px]" style={{ color: face === "failed" ? "var(--warning-ink)" : "var(--text2)" }}>
                {face === "failed" ? "The pull requests could not be read." : "Your filters hide every pull request on this board."}
              </div>
              <p className="m-0 mt-1.5 text-[11px] leading-snug" style={{ color: "var(--text3)" }}>
                {face === "failed"
                  ? "This is not an empty board — the list did not come back. Asking again costs the same two calls."
                  : `${hidden} came in and none passes the filters above; clear one to see them.`}
              </p>
              {face === "failed" && onRetry && (
                <button onClick={onRetry} className="agx-btn mt-3 rounded px-2 py-1 text-[10.5px]"
                  style={{ color: "var(--text2)", border: EDGE }}>
                  Try again
                </button>
              )}
            </div>
          </div>
        ) : face === "empty" ? (
          /* Loaded, and genuinely nothing. Said once, plainly, instead of five
             columns each announcing its own emptiness — which is the same
             sentence five times and reads as a board that failed to load. */
          <div className="h-full grid place-items-center text-center">
            <div style={{ maxWidth: 400 }}>
              <div className="text-[13px]" style={{ color: "var(--text2)" }}>Nothing wants anything from you.</div>
              <p className="m-0 mt-1.5 text-[11px] leading-snug" style={{ color: "var(--text3)" }}>
                No open pull request of yours, and nobody has asked you to look at one. Both lists
                are in — this is an answer, not a wait.
              </p>
              <button onClick={onShowTable} className="agx-btn mt-3 rounded px-2 py-1 text-[10.5px]"
                style={{ color: "var(--text2)", border: EDGE }}>
                {tableLabel}
              </button>
            </div>
          </div>
        ) : (
          <div className="grid gap-2.5 h-full" style={{
            /* A folded lane is a fixed 44px; the rest share what is left. 268
               stays the floor for the open ones — it is what a card needs
               before its title starts wrapping, measured at 120px of title box
               where a 33-character subject already runs to three lines. */
            gridTemplateColumns: cols.map((l) => (isFolded(l.id) ? "44px" : "minmax(268px, 1fr)")).join(" "),
          }}>
            {cols.map((l, i) => {
              const all = lanes.get(l.id) ?? [];
              const opened = !!openLanes[l.id];
              const rows = opened ? all : all.slice(0, LANE_CAP);
              const more = all.length - rows.length;
              return (
                /* A column is a box of its own height: heading fixed, cards
                   scrolling under it. `min-h-0` on both the column and its
                   scroller or the flex chain hands them their content height
                   and they grow instead of scrolling. `data-lane` names the box
                   from outside — it is the thing that scrolls, so it is the
                   thing a probe has to be able to point at. */
                <div key={l.id} data-lane={l.id} className="min-w-0 min-h-0 flex flex-col rounded-sm"
                  style={{ borderTop: `2px solid ${l.tint}`, transition: "width 120ms ease" }}>
                  {isFolded(l.id) ? (
                    /*
                     * FOLDED, AND STILL SAYING WHAT IT HOLDS.
                     *
                     * The count comes first and stays upright, because it is
                     * the thing being kept: every fold in this app that hides
                     * something countable keeps its number on the folded
                     * header — the browser's spaces, Docker's stacks, the
                     * diff's files. One of them puts it as law: "the count is
                     * the whole point of a folded row".
                     *
                     * The name is vertical rather than truncated, copied from
                     * the tasks rail, whose own note is the argument: folded,
                     * it was "34 pixels of nothing but the button that unfolds
                     * it — asked about as 'is it normal that nothing shows'. A
                     * column that is empty when closed teaches people it holds
                     * nothing."
                     */
                    <button onClick={() => toggleFold(l.id, all.length)}
                      aria-expanded={false}
                      title={`${all.length} ${l.label} — unfold`}
                      className="flex-1 min-h-0 w-full flex flex-col items-center gap-1.5 pt-2 pb-3 overflow-hidden agx-hover"
                      style={{ color: l.tint }}>
                      <span className="text-[13px] tabular-nums shrink-0">{waiting ? "—" : all.length}</span>
                      <span className="truncate" style={{
                        writingMode: "vertical-rl", transform: "rotate(180deg)",
                        fontSize: 10.5, letterSpacing: "0.06em", maxHeight: "100%",
                        textTransform: "uppercase",
                      }}>{l.label}</span>
                    </button>
                  ) : (<>
                  <div className="shrink-0">
                    {/*
                      * One line, always — and that is what the ⓘ is for.
                      *
                      * The "why" ran to one line in some lanes and two in
                      * others, so the first card of each column started at a
                      * different height and the board read as though it had
                      * been assembled carelessly. Alignment across five columns
                      * is most of what makes a board scannable, and it cannot
                      * survive a heading whose height depends on how long a
                      * sentence happens to be.
                      *
                      * The sentence is not lost: it is what the ⓘ says, and it
                      * is read once — when you are learning what a lane means —
                      * not on every glance for ever after.
                      */}
                    <h3 className="flex items-center gap-2 m-0 pt-2 pb-2 px-0.5 text-[11px] font-semibold" style={{ color: l.tint }}>
                      <span className="text-[13px] tabular-nums">{waiting ? "—" : all.length}</span>
                      <span className="uppercase tracking-wide truncate">{l.label}</span>
                      {/*
                        * A DRAWN ⓘ, not the character.
                        *
                        * `ⓘ` at `fontSize: 14` paints about eight pixels of
                        * actual mark — a glyph fills roughly 60% of the size it
                        * is set at — so it sat beside a 12px stroked chevron in
                        * an identical 20×20 box and read as a third the size.
                        * Two adjacent controls in the same box at different
                        * sizes is exactly what "some icons are very big, others
                        * very small" named on the card's own header, fixed
                        * there and left standing here.
                        *
                        * Same fix as the card's: a real icon at a size off the
                        * app's ladder, matching its neighbour.
                        */}
                      <span title={l.why} aria-label={l.why} role="note"
                        className="shrink-0 grid place-items-center rounded-full cursor-help"
                        style={{ width: MIN_BOX, height: MIN_BOX, color: "var(--text4)" }}>
                        <InfoIcon size={ICON.xs} />
                      </span>
                      <span className="ml-auto text-[9px] px-1 rounded shrink-0" style={{ color: "var(--text4)", border: EDGE }}>{i + 1}</span>
                      {/*
                        * The fold lives HERE and not on the counts row above.
                        *
                        * That row is one chip per lane already and would have
                        * been the obvious place — but a test forbids a button
                        * in it, and the comment behind that test says why: "a
                        * row of buttons up here would read as filters that
                        * shrink the board". The heading is where the count
                        * already is, and where the ⓘ already sits at the size
                        * this app's own floor asks for.
                        *
                        * The lane the board exists for cannot be folded WHILE
                        * IT HOLDS SOMETHING, and then it draws no control
                        * rather than a dead one. At zero it folds like any
                        * other: an empty lane is asking nothing, and it was
                        * still taking 268px of a board that does not fit
                        * five columns — a lane that cannot be folded under a
                        * heading reading `0 NEEDS YOUR REVIEW`.
                        */}
                      {foldable(l.id, all.length) && (
                        <button onClick={() => toggleFold(l.id, all.length)}
                          aria-expanded
                          title={`Fold ${l.label} — its ${all.length} stay counted`}
                          className="shrink-0 grid place-items-center rounded agx-hover"
                          style={{ width: MIN_BOX, height: MIN_BOX, color: "var(--text4)" }}>
                          <svg viewBox="0 0 16 16" width={ICON.xs} height={ICON.xs} fill="none" stroke="currentColor"
                            strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
                            <path d="M10 3.5 5.5 8l4.5 4.5" />
                          </svg>
                        </button>
                      )}
                    </h3>
                  </div>

                  {/* `pb-2`: the last thing in a lane sat flush against the
                      bottom edge of the column, and a bordered button there
                      reads as clipped — "the Show fewer button looks sort of
                      eaten away". Cards had `mb-2` between them and nothing after
                      the final one. */}
                  <div className="flex-1 min-h-0 overflow-y-auto agx-scroll pb-2">
                    {waiting ? (
                      /* The shape of the thing being waited for, and no text:
                         a lane cannot honestly say how many it will hold. */
                      <div aria-hidden>
                        {[0, 1].map((k) => (
                          <div key={k} className="rounded-lg mb-2 animate-pulse"
                            style={{ height: 74, background: "var(--surface-card)", border: EDGE, animationDelay: `${(i * 2 + k) * 0.08}s` }} />
                        ))}
                      </div>
                    ) : (
                      <>
                        {rows.map((p) => (
                          <CardView key={p.number} p={p} hasTaskProvider={hasTaskProvider} repoUses={repoUses}
                            pinned={pinned(p.number)} onOpen={() => onOpen(p.number)} onPin={() => onTogglePin(p)}
                            onAct={onAct} busy={busy} acting={acting}
                            dim={!matches(p) || (onlyLane !== null && onlyLane !== l.id)} root={root}
                            unread={unread.get(p.number)} />
                        ))}
                        {/* Counted, and openable HERE. The cap is what keeps
                            the board a glance on a bad week; the rest of the
                            lane is one press away and lands in the lane it
                            belongs to, not in a table on the other side of the
                            panel. The column already scrolls. */}
                        {more > 0 && (
                          <button onClick={() => setOpenLanes((o) => ({ ...o, [l.id]: true }))}
                            title={`Show the other ${more} in this lane`}
                            className="w-full rounded-md py-1 mb-2 text-[10px]"
                            style={{ color: "var(--text3)", border: EDGE }}>
                            +{more} more in this lane
                          </button>
                        )}
                        {opened && all.length > LANE_CAP && (
                          <button onClick={() => setOpenLanes((o) => ({ ...o, [l.id]: false }))}
                            title={`Back to the first ${LANE_CAP}`}
                            className="w-full rounded-md py-1 mb-2 text-[10px]"
                            style={{ color: "var(--text4)", border: EDGE }}>
                            Show fewer
                          </button>
                        )}
                        {all.length === 0 && (
                          <p className="m-0 px-0.5 text-[10.5px]" style={{ color: "var(--text4)" }}>Nothing here. Good.</p>
                        )}
                      </>
                    )}
                  </div>
                  </>)}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/*
        * The footer, and the two things it will not do.
        *
        * There is no "sweep the stale ones". agentglass has no API that closes,
        * comments on or pokes a batch of pull requests, and a button that looks
        * like it can is the same lie as a nudge on a card — the one thing this
        * board has refused from the start.
        *
        * And the staleness is counted over THESE, not over the repository. The
        * other few hundred are not loaded — that is the whole bargain of the
        * board — so a number about them could only be made up. "Of these" is
        * the honest scope, and it is said in the sentence rather than left for
        * the reader to assume.
        */}
      {!waiting && involved > 0 && (
        <div className="shrink-0 flex flex-wrap items-center gap-2.5 px-4 py-2 text-[10.5px]"
          style={{ color: "var(--text3)", borderTop: LINE }}>
          {!totalKnown ? (
            <span>How many others are open is not a number this view can trust.</span>
          ) : rest > 0 ? (
            <span>The other <b style={{ color: "var(--text2)" }}>{rest}</b> open pull requests want nothing from you right now.</span>
          ) : (
            <span>That is every open pull request — there is nothing else.</span>
          )}
          <span style={{ color: "var(--text4)" }}>·</span>
          <span title="Measured from each pull request's last update, which GitHub moves for a push, a comment or a label. Counted only over the ones on this board.">
            {quiet > 0
              ? <>{quiet} of these {quiet === 1 ? "has" : "have"} gone {QUIET_DAYS} days without a push or a comment</>
              : <>everything here moved in the last {QUIET_DAYS} days</>}
          </span>
          <button onClick={onShowTable} className="agx-btn ml-auto rounded px-2 py-0.5"
            style={{ color: "var(--text2)", border: EDGE }}>
            {tableLabel}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The header line a card leads with: what a person decided.
 *
 * Everything comes off `humanReview`, computed server-side from the reviews the
 * list already fetches — see its note on PrSummary for why GitHub's own
 * `reviewDecision` cannot be used (it counts the auto-review bot, so a pull
 * request nobody had read reported APPROVED).
 *
 * `null` when nobody was asked and nobody looked: a header saying "nothing"
 * steals weight from the ones that say something.
 */
function cardVerdict(p: PrSummary): {
  tint: string; glyph: ReactNode; line: string; aria: string; url?: string; skeleton?: boolean;
} | null {
  /* A draft is waiting on nobody, and said so nowhere — it was a label lost
     among the others. */
  if (p.isDraft) {
    return { tint: "var(--text3)", glyph: <DraftIcon size={ICON.xs} />, line: "Draft \u2014 nobody has been asked",
      aria: "Draft, nobody has been asked to review" };
  }
  /*
   * NORMALISED, not trusted.
   *
   * This shipped reading `v.who.slice(...)` straight off the wire, and the view
   * died with "Cannot read properties of undefined (reading 'slice')" —
   * `Pull requests stopped drawing`, the whole page gone, on his screen.
   *
   * `humanReview` had just changed from a bare string to an object, and a row
   * can reach this render with the OLD shape: a page held open across an
   * install, a cached list, a stream that started before the new server. A
   * component that assumes the shape of something it received over a wire
   * turns a version skew into a blank view — and this app already answers that
   * question everywhere else by checking rather than assuming.
   */
  const raw: unknown = p.humanReview;
  /*
   * NOTHING YET IS NOT NOTHING.
   *
   * The list arrives in two passes: the rows first, then the review, the checks
   * and the tracker card a moment later. Until the second lands, `humanReview`
   * is simply absent — and this drew no header, which on a pull request that
   * HAS been reviewed is indistinguishable from one that has not. "It often
   * stays like that with no feedback that something is loading", and the honest answer
   * is that the card was reporting an answer it did not have yet.
   *
   * `checksLoaded` is the flag the list already sets for exactly this, and the
   * card never read it. A quiet line rather than a spinner: twenty of these
   * blinking at once is worse than the silence it replaces.
   */
  /* `=== false`, not `!== true`: `undefined` means this row was never built in
     two passes at all, and treating that as "still loading" leaves a skeleton
     on screen for ever on any caller that fetches in one go. */
  if (!raw && p.checksLoaded === false) {
    return { tint: "var(--text4)", glyph: "·", line: "", skeleton: true,
      aria: "Still reading who reviewed this" };
  }
  /*
   * A HEADER EVEN WHEN NOBODY HAS LOOKED.
   *
   * This returned null, on the argument that a header saying "nothing" steals
   * weight from the ones that say something. The argument was right about
   * weight and wrong about the card: without it the row is visibly shorter than
   * every other one in the lane, and a column of two shapes is a column you
   * re-read. Both can be true at once — it is drawn, in the quietest colour
   * there is, so it holds the shape without asking for attention.
   *
   * And it says the actual state rather than a placeholder: nobody has been
   * asked. On a release branch that is the whole story.
   */
  if (!raw) {
    return { tint: "var(--text4)", glyph: <CircleIcon size={ICON.xs} />, line: "No review asked for yet",
      aria: "Nobody has been asked to review this" };
  }
  const v = typeof raw === "string"
    /* The old shape: a kind and nothing else. Drawn without a name, which is
       what it always was, rather than not drawn at all. */
    ? { kind: raw as "approved" | "changes" | "awaiting" | "commented", who: [] as string[] }
    : raw as NonNullable<PrSummary["humanReview"]>;
  const who = Array.isArray(v.who) ? v.who : [];
  /* A shape this build does not know is "no verdict", not "no header": a
     malformed field must not change what the card looks like. */
  if (!v.kind) {
    return { tint: "var(--text4)", glyph: <CircleIcon size={ICON.xs} />, line: "No review asked for yet",
      aria: "Nobody has been asked to review this" };
  }

  const names = who.slice(0, 2).join(" and ") + (who.length > 2 ? ` +${who.length - 2}` : "");
  const also = v.others ? ` \u00B7 ${v.others} approval${v.others === 1 ? "" : "s"}` : "";

  if (v.kind === "approved") {
    /* STALE FIRST: an approval with commits on top of it is the dangerous
       state — the row says green and the reviewer approved something else. */
    if (v.stale) {
      /*
       * ASKED AGAIN, ON TOP OF STALE.
       *
       * A stale approval still says a reviewer decided; it just no longer
       * covers what is here now. When the author has already re-requested
       * that reviewer's look, the card read as if there were something for
       * the author to do about it, while the roster beside it already showed
       * the same reviewer with the re-request icon. `askedAgain` is the same
       * field the changes-requested branch below reads — see `humanVerdict`
       * in prs.ts, which computes it once from `pending` for either kind.
       *
       * AMBER IS FOR THE RE-REQUEST, NOT FOR TIME PASSING. This card used to
       * turn amber the moment ANY commit landed after the approval, whether
       * or not GitHub still counted it — reported beside the merge box on the
       * same pull request, which read the identical fact green ("still
       * counts"). One truth, two colours. `staleApproval` is the merge box's
       * own answer to whether GitHub counts it; a card has no `gate` (that is
       * PrDetail-only), so it asks with `reviewDecision` alone, which still
       * answers the common case right.
       */
      const counts = staleApproval(p.reviewDecision).counts;
      if (!v.askedAgain && counts) {
        return {
          tint: "var(--success)", glyph: <DoneIcon size={ICON.xs} />, url: v.url,
          line: (v.mine ? "You approved" : names ? `Approved by ${names}` : "Approved") + " · commits since" + also,
          aria: names ? `Approved by ${names}; commits have landed since, GitHub still counts it`
            : "Approved; commits have landed since, GitHub still counts it",
        };
      }
      const line = v.askedAgain && v.mine ? "You were asked to look again"
        : v.mine ? "You approved, but it has moved since"
          : (names ? `Approved by ${names}, but it has moved since` : "Approved, but it has moved since") + (v.askedAgain ? " — asked to look again" : "");
      return {
        tint: "var(--warning)", glyph: <RefreshIcon size={ICON.xs} />, url: v.url,
        line,
        aria: (names ? `Approved by ${names}, but commits have landed since that review`
          : "Approved, but commits have landed since that review") + (v.askedAgain ? ", and asked to look again since" : ""),
      };
    }
    return {
      tint: "var(--success)", glyph: <DoneIcon size={ICON.xs} />, url: v.url,
      line: (v.mine ? "You approved" : names ? `Approved by ${names}` : "Approved") + also,
      aria: names ? `Approved by ${names}` : "Approved",
    };
  }
  if (v.kind === "changes") {
    /*
     * CLEARED: every one of them has been re-asked, so nobody named here is
     * still the one holding up the merge \u2014 the same amber the merge box
     * draws for this exact fact (see p2Verdict in PrPanel.tsx). Reported on
     * the installed build still reading red here after the merge box had
     * already gone amber: one fact, two surfaces, two answers.
     */
    if (v.cleared) {
      const line = v.mine ? "You were asked to look again"
        : names ? `Waiting on review by ${names}` : "Waiting on review";
      return {
        tint: "var(--warning)", glyph: <CircleIcon size={ICON.xs} />, url: v.url,
        line: line + also,
        aria: (names ? `Waiting on review by ${names}, changes applied and asked to look again` : "Waiting on review, changes applied and asked to look again"),
      };
    }
    /*
     * STILL RED, because it still blocks the merge exactly as GitHub shows
     * it \u2014 a re-request does not withdraw the standing review. What was
     * missing is the other half of GitHub's own screen: the small \u21bb beside
     * their name that says a follow-up round has already been asked for.
     * Without it, applying the review and re-requesting left this line
     * reading exactly as it had before either happened.
     */
    const line = v.askedAgain && v.mine ? "You were asked to look again"
      : v.mine ? "You asked for changes"
        : (names ? `Changes requested by ${names}` : "Changes requested") + (v.askedAgain ? " \u2014 asked to look again" : "");
    return {
      tint: "var(--error)", glyph: <CrossIcon size={ICON.xs} />, url: v.url,
      line: line + also,
      aria: (names ? `Changes requested by ${names}` : "Changes requested") + (v.askedAgain ? ", and asked to look again since" : ""),
    };
  }
  if (v.kind === "awaiting") {
    /* Your own column is the one place this card is about YOU. */
    return {
      tint: "var(--warning)", glyph: <CircleIcon size={ICON.xs} />,
      line: v.mine ? "Waiting on you" : names ? `Waiting on ${names}` : "Awaiting review",
      aria: v.mine ? "Waiting on you to review" : names ? `Waiting on ${names} to review` : "Awaiting review",
    };
  }
  return {
    tint: "var(--text3)", glyph: <CommentIcon size={ICON.xs} />, url: v.url,
    line: names ? `${names} commented, no verdict` : "Commented, no verdict",
    aria: names ? `${names} commented without giving a verdict` : "Commented without a verdict",
  };
}

/** The edge of the number chip, and of the link once it has copied: green after a copy. */
const copyEdge = (done: boolean) =>
  `1px solid color-mix(in srgb, ${done ? "var(--success) 50%" : "var(--border) 55%"}, transparent)`;

function CardView({ p, hasTaskProvider, repoUses, pinned, onOpen, onPin, onAct, busy, acting, dim, root, unread }: {
  p: Card; hasTaskProvider: boolean;
  /** This repository links work items at all: see prCardBlock.ts. */
  repoUses: boolean;
  pinned: boolean;
  /** Unread remarks on this one, or null. See prUnread.ts. */
  unread?: Unread | null;
  /** The pull request whose action is running, so only its card spins. */
  acting?: number | null;
  /**
   * A find is running and this card is not one of the answers.
   *
   * Quietened, never removed. A card that stops being drawn takes its lane's
   * shape with it and the counts above start disagreeing with what is under
   * them — and the reason you are looking at a board rather than a list is that
   * the shape means something.
   */
  dim?: boolean;
  /** Where to ask how far behind this branch is. Absent means do not ask. */
  root?: string;
  onOpen: () => void; onPin: () => void;
  onAct: (p: PrSummary, what: "open" | "merge" | "rerun") => void; busy?: boolean;
}) {
  /* Asked for the first time by whoever draws the card, which is the thing that
     knows it is on screen. Null until the answer lands. */
  const behind = root ? behindOf(root, p.number) : null;
  const asking = root ? askingBehind(root, p.number) : false;
  /** Said on the number itself for a moment: a clipboard write is invisible. */
  const [copied, setCopied] = useState<number | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);
  const copyLink = () => {
    /* The URL GitHub itself would give you: `p.url` is already on the row, so
       there is nothing to build and nothing to build wrong. */
    void navigator.clipboard?.writeText(p.url || "").catch(() => {});
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 1200);
  };
  const copyNumber = (n: number) => {
    void navigator.clipboard?.writeText(`#${n}`).catch(() => {});
    setCopied(n);
    setTimeout(() => setCopied(null), 1200);
  };
  const c = p.checks;
  const act = suggestedAction(p, p.filed);
  const task = taskLink(p, hasTaskProvider);
  const tint = c.pending > 0 ? "var(--warning)" : c.verdict === "red" ? "var(--error)"
    : c.verdict === "green" ? "var(--success)" : "var(--text4)";
  /* What the standing zone says, and how far the bar is filled: see prCardZones. */
  const st = standing(c);
  const { pre, rest } = splitTitle(p.title);
  const ev = eventLine(p.filed.reason, p.updatedAt);
  const verdict = cardVerdict(p);
  const hr = p.humanReview as unknown;
  const headerPeople: string[] = hr && typeof hr === "object" && Array.isArray((hr as { who?: unknown }).who)
    ? ((hr as { who: unknown[] }).who.filter((x): x is string => typeof x === "string" && x !== ""))
    : [];
  /*
   * THE CARDS THE BOARDS DO NOT HOLD, asked for one at a time.
   *
   * `p.card` is free — the server reads it off the boards already cached on
   * disk — but only from a cache read within the day, so it can be absent from
   * every row at once. `prCardStore` fills the rest: keyed by card reference,
   * two in flight, a minute of cache.
   */
  /* Re-read when an answer lands. The mapping itself lives in the store, so the
     card this draws and the card a filter reads are the same one. */
  useSyncExternalStore(onCard, cardVersion, () => 0);
  const shown: PrSummary["card"] = withCard(p, hasTaskProvider).card;
  const block = trackerBlock({ card: !!shown, hasId: !!task, checksLoaded: p.checksLoaded, repoUses });
  return (
    /* `data-pr` because a card is the unit anything outside this file counts —
       a test asking how many landed in a lane, a probe asking which column it
       is measuring. The number is already on screen; this just makes it
       addressable without reading the design. */
    <div onClick={onOpen} role="button" tabIndex={-1} data-pr={p.number}
      data-dim={dim ? "1" : undefined}
      className="rounded-lg mb-2 cursor-pointer agx-btn agx-prc overflow-hidden"
      style={{
        border: EDGE,
        background: "var(--surface-card)",
        /* Saturation as well as opacity: these cards are read by colour — green
           lane, red checks, amber waiting — and dimming alone leaves a row of
           paler versions of the same signal still competing for the eye.
           Draining the colour takes them out of that conversation while leaving
           every word legible, which is the difference between "not this one"
           and "gone". */
        ...(dim ? { opacity: 0.32, filter: "saturate(0.25)" } : null),
        transition: "opacity 120ms ease, filter 120ms ease",
      }}>
      {/*
       * Title first, and the pin beside it.
       *
       * The pin used to be a 22px glyph in the bottom corner, which is a
       * target you aim at rather than one you hit — and it sat under a
       * sentence whose length decided where it ended up, so it moved between
       * cards. It is 26px now, in the one place every card has in common, and
       * the whole square is the button rather than the star inside it.
       */}
      {/*
        * THE VERDICT IS THE FIRST LINE OF THE CARD.
        *
        * It used to be a word in the middle of a grey run of statistics — the
        * branch name, the diff counts, the check total — and it is the only
        * thing on this card a PERSON decided. Everything else a machine
        * measured, and machines change their minds on a re-run.
        *
        * A band of its own colour with the name in it, chosen from three mocks:
        * it is what the pull request's own Overview already does, so the board
        * and the page say the same thing the same way.
        *
        * FIXED HEIGHT and truncating, because a column of cards is scanned down
        * its left edge: a header that wrapped to two lines on a long login
        * would start every card below it at a different place. Same reason the
        * lane's own "why" was cut to one line.
        */}
      {verdict && (
        <div className="flex items-center gap-1.5 px-2 shrink-0"
          role="note" aria-label={verdict.aria}
          style={{
            height: 22, fontSize: 10.5,
            background: `color-mix(in srgb, ${verdict.tint} 13%, transparent)`,
            borderBottom: `1px solid color-mix(in srgb, ${verdict.tint} 30%, transparent)`,
          }}>
          {/* The glyph as well as the colour: the board's own rule for check
              state, and the header is the first thing read. */}
          <span aria-hidden className="flex" style={{ color: verdict.tint }}>{verdict.glyph}</span>
          {verdict.skeleton ? (
            /* A bar the width a verdict tends to be, so the header keeps its
               height and the card does not jump when the real one lands. */
            <span aria-hidden className="rounded"
              style={{ width: 130, height: 8, background: "color-mix(in srgb, var(--text) 12%, transparent)" }} />
          ) : (
            <span className="truncate min-w-0" style={{ color: "var(--text)", fontWeight: 500 }}>
              {verdict.line}
            </span>
          )}
          {/* The people the line names, as faces right after it: who was asked,
              who approved, who asked for changes. */}
          {headerPeople.length > 0 && (
            <span className="shrink-0 flex items-center" aria-hidden>
              {headerPeople.slice(0, HEADER_FACES).map((login, n) => (
                <span key={login} className="rounded-full inline-flex"
                  style={{ marginLeft: n ? -3 : 0, boxShadow: "0 0 0 1.5px var(--surface-card)", position: "relative", zIndex: HEADER_FACES - n }}>
                  <Avatar login={login} size={16} />
                </span>
              ))}
            </span>
          )}
          <span className="flex-1" />
          {/* Open line threads: the number that says whether a "changes
              requested" is one nit or twelve, and whether an approval still
              has something under it. Only when there are any. */}
          {(p.openThreads?.open ?? 0) > 0 && (
            <span className="shrink-0 inline-flex items-center rounded-full px-1.5 tabular-nums"
              title={`${p.openThreads!.open}${p.openThreads!.more ? "+" : ""} review thread${p.openThreads!.open === 1 ? "" : "s"} still unresolved`}
              style={{ fontSize: 9.5, lineHeight: "14px", color: "var(--warning-ink)", background: "color-mix(in srgb, var(--warning) 12%, transparent)", border: "1px solid color-mix(in srgb, var(--warning) 30%, transparent)" }}>
              {p.openThreads!.open}{p.openThreads!.more ? "+" : ""} open
            </span>
          )}
          {/* A press lands on the review comment itself rather than on the
              conversation and a hunt through forty of them. */}
          {verdict.url && (
            <button className="agx-btn ml-auto shrink-0 px-1 rounded"
              style={{ color: "var(--text3)", fontSize: 10 }}
              title="Open the review itself on GitHub"
              onClick={(e) => { e.stopPropagation(); window.open(verdict.url, "_blank", "noopener"); }}>↗</button>
          )}
        </div>
      )}
      {/*
        * ONE SURFACE: the pull request, with the work item on its identity line.
        *
        * It was a tracker bar on top and a nested "Pull request" panel under it,
        * three zones deep — 405px a card at 600 wide, which is two cards on a
        * screen where the board exists to show twelve. The work item is now one
        * block at the end of the line the number is already on (CardTracker),
        * and the panel's header row is gone: the number, the link and the pin
        * live on the lines that were there anyway.
        *
        * Drawn only when the saved boards already hold the card, which costs no
        * request. Absent means "we have not seen it", not "it has no status".
        */}
      <div className="agx-prc-main">
        <div className="agx-prc-id">
          <span className="flex shrink-0" title={`${p.author} opened this pull request`}><Avatar login={p.author} size={20} /></span>
          {/*
            * The number, and pressing it copies it.
            *
            * It is the thing you take away from a board — into a branch name, a
            * commit, a message to somebody — and copying it meant opening the
            * pull request to reach the button that does. `stopPropagation`
            * because the card underneath opens on click, and this press means
            * "give me the number", not "show me the page".
            *
            * The same chip the pull request's own masthead wears — a bordered
            * number with ⧉ after it, one shape and one size in both states: a
            * swapped glyph of another width moved the row at the moment you
            * were looking at it.
            */}
          {/* The number, the link and the pin are one group: the three things you
              take away from a card, side by side and wrapping as one. The link and
              the pin are as tall as the number chip so the row does not grow, and
              HIT on a touch screen, where a 20px square is a target to aim at. The
              whole square is the button rather than the glyph inside it: the pin
              used to be a 22px glyph in a corner, a target you aim at rather than
              one you hit. */}
          <span className="agx-prc-grp flex items-center gap-1 shrink-0"
            style={{ "--ib": `${CHIP_H + 2}px`, "--ib-hit": `${HIT}px` } as CSSProperties}>
          <button onClick={(e) => { e.stopPropagation(); copyNumber(p.number); }}
            aria-live="polite"
            title={copied === p.number ? "Copied!" : `Copy #${p.number}`}
            className="agx-btn agx-prc-cp shrink-0 tabular-nums inline-flex items-center gap-1 px-1.5 rounded-md text-[10px]"
            style={{
              height: CHIP_H + 2,
              color: copied === p.number ? "var(--success)" : "var(--text2)",
              border: copyEdge(copied === p.number),
              background: "var(--surface-inset)",
            }}>
            #{p.number}
            {copied === p.number ? <DoneIcon size={ICON.xs} /> : <CopyIcon size={ICON.xs} />}
          </button>
          <button onClick={(e) => { e.stopPropagation(); copyLink(); }}
            title={copiedLink ? "Copied!" : `Copy the link to #${p.number}`}
            aria-label={`Copy the link to #${p.number}`}
            className="agx-btn agx-prc-cp agx-prc-ib shrink-0 grid place-items-center rounded-md"
            style={{ lineHeight: 1,
              color: copiedLink ? "var(--success)" : "var(--text3)",
              border: copiedLink ? copyEdge(true) : "none",
              background: copiedLink ? "var(--surface-inset)" : "transparent" }}>
            {copiedLink ? <DoneIcon size={ICON.xs} /> : <LinkIcon size={ICON.xs} />}
          </button>
          <button onClick={(e) => { e.stopPropagation(); onPin(); }}
            title={pinned ? `Unpin #${p.number}` : `Pin #${p.number} to the bar at the top`}
            aria-label={pinned ? `Unpin #${p.number}` : `Pin #${p.number}`}
            aria-pressed={pinned}
            className="agx-btn agx-prc-cp agx-prc-ib shrink-0 grid place-items-center rounded-md"
            style={{ lineHeight: 1,
              color: pinned ? "var(--primary-hover)" : "var(--text3)",
              border: pinned ? "1px solid color-mix(in srgb, var(--primary) 40%, transparent)" : "none",
              background: pinned ? "color-mix(in srgb, var(--primary) 12%, transparent)" : "transparent" }}>
            <PinIcon size={ICON.xs} filled={pinned} />
          </button>
          </span>
          {/* Beside the number, before the title: the title is what a card IS
              and this is what it WANTS. */}
          {unread && <UnreadBadge u={unread} />}
          {/* No author name: the author is the first face bottom right, and a
              name here said the same thing in more width. */}
          <span className="tabular-nums shrink-0">{ago(p.updatedAt)}</span>
          {/* Everything that is only sometimes true, after what is always true. */}
          {(p.isCurrentBranch || p.isDraft) && (
            <span className="flex items-center gap-1 text-[9.5px]">
              {p.isCurrentBranch && <Tag tint="var(--primary)">here</Tag>}
              {p.isDraft && <Tag>draft</Tag>}
            </span>
          )}
          {/* At the end of the line, and on a line of its own — still right
              aligned — when what is before it leaves no room: the status never
              shrinks to make space. */}
          <CardTracker block={block} card={shown} task={task} prOpen={p.state === "OPEN"} />
        </div>

        {/* WHAT IT IS: three lines of title at most, then the cut. The whole
            title is on the tooltip and one press away on Open — a lane of long
            titles must not decide the height of its cards. */}
        <div title={p.title} className="agx-prc-title font-semibold"
          style={{ fontSize: 13, lineHeight: 1.4, color: "var(--text)", overflowWrap: "anywhere" }}>
          {pre && <span className="font-medium" style={{ color: "var(--text3)" }}>{pre} | </span>}{rest}
        </div>
        {/*
          * WHERE IT STANDS: the checks as a word and a bar, never as colour
          * alone — "red" has to be sayable to somebody who cannot see it.
          * Colour is spent on the checks and nowhere else in this zone.
          *
          * The bar is filled by what has reported: a suite half in looks half
          * in. Red fills whatever got that far rather than filling to the
          * end, because a failure is not a finished run. Nothing reported is
          * an empty track — not a hidden bar, which would make the card a
          * different height, and not a full grey one, which would read as done.
          *
          * The label sits on this line, after the base, and wraps with it: a
          * row of its own cost 22px on every card that has one.
          */}
        <div className="agx-prc-stand grid gap-1">
          <div className="flex items-center gap-x-2 gap-y-1 flex-wrap min-w-0" style={{ fontSize: 10.5, color: "var(--text3)", minHeight: 20 }}>
            <span className="shrink-0 font-semibold tabular-nums" style={{ color: st.kind === "none" ? "var(--text3)" : tint }}>{st.word}</span>
            {/* CONFLICTS, beside the checks. A green pull request that
                conflicts with its base reads as ready to merge, and it is
                not. `CONFLICTING` only: `UNKNOWN` is GitHub still working it
                out, and a warning that flashes on and off is worse than none. */}
            {p.mergeable === "CONFLICTING" && (
              <span className="shrink-0 inline-flex items-center gap-1 rounded-md px-1.5"
                style={{ height: CHIP_H + 2, color: "var(--error-ink)",
                  background: "color-mix(in srgb, var(--error) 12%, transparent)",
                  border: "1px solid color-mix(in srgb, var(--error) 35%, transparent)" }}
                title="Conflicts with the base branch — nothing else can move until they are resolved">
                <WarningIcon size={ICON.xs} />conflicts
              </span>
            )}
            <span aria-hidden style={{ color: "var(--text4)" }}>→</span>
            {/* Never truncated: the one that matters — a stacked branch with
                a long ticket in its name — is exactly the one you could not
                read. Tinted when it is not the trunk. */}
            <span className="shrink-0 whitespace-nowrap" title={`${p.headRefName} → ${p.baseRefName}`}
              style={{ color: TRUNKS.has(p.baseRefName) ? "var(--text3)" : "var(--warning)" }}>{p.baseRefName}</span>
            {st.failing && (
              <span className="shrink-0 inline-flex items-center rounded-md px-1.5 whitespace-nowrap"
                style={{ height: CHIP_H + 2, color: "var(--error-ink)",
                  background: "color-mix(in srgb, var(--error) 8%, transparent)",
                  border: "1px solid color-mix(in srgb, var(--error) 35%, transparent)" }}>
                {st.failing}
              </span>
            )}
            {p.labels.slice(0, 1).map((l) => (
              <span key={l.name} className="truncate inline-flex items-center rounded-md px-1.5"
                title={l.name}
                style={{ height: CHIP_H + 2, maxWidth: 200, color: "var(--text2)", background: "var(--surface-inset)", border: LINE }}>
                {l.name}
              </span>
            ))}
            {p.labels.length > 1 && (
              <span className="tabular-nums shrink-0" title={p.labels.map((l) => l.name).join(", ")}>+{p.labels.length - 1}</span>
            )}
            <span className="flex-1 min-w-0" />
            {/* How far behind the base, when somebody has found out. It
                arrives late and lands as a chip on a card that does not move:
                the space is held, quiet, while the answer is out. */}
            {behind ? (
              <span className="shrink-0 inline-flex items-center gap-0.5 tabular-nums px-1 rounded"
                title={`${behind} commit${behind === 1 ? "" : "s"} on ${p.baseRefName} that this branch does not have — its checks ran against an older base`}
                style={{ color: "var(--warning-ink)", background: "color-mix(in srgb, var(--warning) 14%, transparent)" }}>
                <RefreshIcon size={ICON.xs} />{behind}
              </span>
            ) : asking ? (
              <span aria-hidden className="shrink-0 rounded animate-pulse"
                title="Working out how far behind its base this branch is"
                style={{ width: 26, height: 11, background: "color-mix(in srgb, var(--text) 10%, transparent)" }} />
            ) : null}
            <span className="shrink-0 whitespace-nowrap tabular-nums">
              <span style={{ color: "var(--text)" }}>+{p.additions}</span>{" "}
              <span>−{p.deletions}</span>{" "}
              <span aria-hidden style={{ color: "var(--text4)" }}>·</span>{" "}
              <span>{p.changedFiles}f</span>
            </span>
          </div>
          <div role="img" aria-label={`Checks ${st.word}`} className="rounded-full overflow-hidden"
            style={{ height: 3, background: "color-mix(in srgb, var(--text) 12%, transparent)" }}>
            <span className="block h-full rounded-full" style={{ width: `${st.done}%`, background: tint, transition: "width .25s" }} />
          </div>
        </div>

        {/* WHAT HAPPENED LAST: the sentence that put it in this lane. Without it a
            board is a list whose order you have to re-derive every morning.
            Two lines, then the tooltip; a date beside it for "waiting since
            when", which is one question with the sentence. */}
        <div className="agx-prc-event min-w-0"
          style={{ fontSize: 10.5, lineHeight: 1.5, color: ev.empty || ev.quiet ? "var(--text3)" : "var(--text2)" }}>
          <div className="flex gap-2 items-baseline min-w-0">
            <span aria-hidden className="shrink-0" style={{ color: "var(--text4)" }}>↳</span>
            <span className="flex-1 min-w-0" title={p.filed.reason}
              style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", overflowWrap: "anywhere" }}>
              {ev.text}
            </span>
            {ev.empty ? (
              <span className="shrink-0" aria-label="No date" style={{ color: "var(--text3)" }}>–</span>
            ) : (
              <span className="shrink-0 tabular-nums whitespace-nowrap" style={{ color: "var(--text3)" }}
                title={`Last activity on this pull request — ${new Date(p.updatedAt).toString()}`}>
                {stamp(p.updatedAt)}
              </span>
            )}
          </div>
          {/* WHICH TEST, when one was read and kept: the sentence says whose it
              is, this says what it is. Absent, not blank, when nothing is known. */}
          {p.filed.test && (
            <div className="flex items-center gap-1.5 min-w-0" style={{ marginTop: 4, paddingLeft: 18 }}>
              <span className="truncate rounded-md px-1.5" title={p.filed.test.title}
                style={{ ...CODE_FONT_STYLE, fontSize: 10, color: "var(--text)", background: "var(--surface-inset)", border: LINE }}>{p.filed.test.title}</span>
              {p.filed.test.more > 0 && <span className="shrink-0 tabular-nums" style={{ color: "var(--text3)" }}>+{p.filed.test.more}</span>}
            </div>
          )}
          {/* A week of nothing is said in words too: ten cards reading
              "8d" look exactly like ten reading "1h". */}
          {ev.quiet && <div className="tabular-nums" style={{ fontSize: 10, marginTop: 2, paddingLeft: 18, color: "var(--text3)" }}>{ev.quiet}</div>}
        </div>
      </div>
    </div>
  );
}

/** Faces drawn in a lane header beside the name it says. */
const HEADER_FACES = 3;

const Tag = ({ children, tint, title }: { children: React.ReactNode; tint?: string; title?: string }) => (
  <span title={title} className="rounded px-1" style={{ color: tint ?? "var(--text3)", border: `1px solid color-mix(in srgb, ${tint ?? "var(--text)"} ${tint ? 34 : 16}%, transparent)` }}>
    {children}
  </span>
);

/** Short enough to sit in a row of ten-pixel type. */
function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return "";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

const K = ({ children }: { children: React.ReactNode }) => (
  <span className="rounded px-1 mx-px" style={{ border: `1px solid color-mix(in srgb, var(--text) 16%, transparent)` }}>{children}</span>
);
