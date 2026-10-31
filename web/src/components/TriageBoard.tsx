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
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { HIT, ICON, MIN_BOX } from "../lib/iconSize.ts";
import { AnchoredMenu } from "./AnchoredMenu.tsx";
import { InfoIcon, SparkleIcon, BranchIcon, PullRequestIcon, ClockIcon, CrossIcon, DoneIcon, DraftIcon, EditIcon, EyeIcon, MergeIcon, MinusIcon, RefreshIcon, SearchIcon, StarIcon, WarningIcon } from "../lib/glyphIcons.tsx";
import { MenuRow, MenuRule } from "./ContextMenu.tsx";
import { PopHead } from "./PrFilterPop.tsx";
import { longAge } from "../lib/prFreshness.ts";
import { eventLine } from "../lib/prCardZones.ts";
import { cardView } from "../lib/prCardView.ts";
import { PrCard, type NotesChipView, type RailView, type StackView } from "./PrCard.tsx";
import { eventTip } from "../lib/prCardTips.ts";
import { tipAttr } from "../lib/tip.ts";
import { stripMode } from "../lib/laneStrip.ts";
import { railLinks, rowWord, stackRows } from "../lib/prStackChip.ts";
import { externalUrl } from "../lib/externalUrl.ts";
import { offerFor } from "../lib/leftovers.ts";
import { leftoverFor, useCleaning, useLeftover } from "../lib/leftoversStore.ts";
import { applyOff, cardMenu, trackerNameOf, type CardMenuId, type TrackerMode } from "../lib/prCardMenu.ts";
import { boardScroll, foldable, foldedLanes, laneSorts, setBoardScroll, setFoldedLanes, setLaneSorts, walkable } from "../lib/boardPrefs.ts";
import { SORT_KEYS, SORT_LABEL, sortCards, type SortKey } from "../lib/prSort.ts";
import { slipIn } from "../lib/prFilterView.ts";
import type { PrSummary } from "../../../shared/types.ts";
import { LANES, lanesFor, LANE_CAP, board as fileAll, fileInLane, type Filed, type LaneId } from "../lib/prLanes.ts";
import { isTrunkBranch, type Stack } from "../lib/prStack.ts";
import { usePrStacks } from "../lib/usePrStacks.ts";
import { type Facts } from "../lib/prStackWords.ts";
import { factsReader, laneMap } from "../lib/prStackFacts.ts";
import { taskLink } from "../lib/taskLink.ts";
import { onCard, cardVersion, withCard } from "../lib/prCardStore.ts";
import { LANE_WIDTH_PX, RAIL_WIDTH_PX, stillReading } from "../lib/prSearch.ts";
import { PrNotice } from "./PrNotice.tsx";
import { ClosedList } from "./ClosedList.tsx";
import { CleanAllButton } from "./CleanAllButton.tsx";
import { resultRow, type ResultRow } from "../lib/prResultRow.ts";
import { repoUsesTracker, trackerBlock } from "../lib/prCardBlock.ts";
import { Button, CTRL_H, EDGE, LINE, Segmented } from "./workspace/Chrome.tsx";
import { CODE_FONT_STYLE } from "./diff/DiffLines.tsx";
import { Avatar } from "./Avatar.tsx";
import { cardReviewers } from "../lib/cardReviewers.ts";
import { askingBehind, behindOf, onBehind } from "../lib/prBehindStore.ts";
import { askConflict, checkingConflict, onConflict } from "../lib/prConflictStore.ts";
import { onRollup, rollupOf } from "../lib/prRollupStore.ts";
import { onKnownBlock, withKnownBlock } from "../lib/prKnownBlock.ts";
import { failureHint, jobIdOf } from "../lib/prFailureHint.ts";
import { failureKey, loadCached, summaryOf, useFailureStore } from "../lib/checkFailuresStore.ts";
import { stamp } from "../lib/whenStamp.ts";
import { closedHeader, finishedKind } from "../../../shared/prClosed.ts";
import { onSeenChange, readSeen } from "../lib/prNew.ts";
import { cardStep } from "../lib/prKeymap.ts";
import { unreadOf, unreadTitle, type Unread } from "../lib/prUnread.ts";
import { PrCardMenu } from "./PrCardMenu.tsx";
import { openCard } from "../lib/openCard.ts";
import { useTrackerSetup } from "../lib/trackerSetup.ts";
import { matchIndex, prMatches, stepMatch } from "../lib/prBoardFind.ts";
import { closeFind, openFind, registerEngine, topScope } from "../lib/findScope.ts";
import { CloseIcon } from "./CloseButton.tsx";
import { boardFace } from "../lib/boardFace.ts";
import { useClickupSetup } from "../lib/clickupSetup.ts";
import { chipFor, gateFacts, notReadyChip, totalOpen } from "../lib/prNotesChip.ts";
import { headsOf, loadNotesSummary, notesSummaryVersion, onNotesSummary, refreshOnNotes, summariesOf } from "../lib/prNotesSummaryStore.ts";
import { onReviewGate, reviewGateOn } from "../lib/reviewGatePref.ts";
import type { PrNotesSummary } from "../../../shared/pluginUi.ts";

/** The tracker bar's tint: the app's own accent, the one an unranked card chip already wears. */
const ACCENT = "var(--accent, var(--primary))";


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
/* `humanReview.mine` is read by the server for the person running this app. On
   another person's board "you were asked" would name the wrong person, so the
   flag is dropped and the card names the reviewers instead. */
function notTheOwners(p: PrSummary): PrSummary {
  return p.humanReview?.mine ? { ...p, humanReview: { ...p.humanReview, mine: false } } : p;
}

function quietAWhile(iso: string): boolean {
  const t = Date.parse(iso);
  return Number.isFinite(t) && Date.now() - t > QUIET_DAYS * 86_400_000;
}

type Card = PrSummary & { filed: Filed };

/**
 * What a card can ask the panel to do. The ones a card can do alone (copy, pin,
 * open on GitHub) never leave this file; everything else is named here and the
 * panel does it: see `onAct` in PrPanel.
 */
export type CardAction = CardMenuId | "review";

/** Narrower than this, a board shows one lane at a time under tabs. */
const NARROW_BOARD_PX = 560;

/** One list of a closed view: its rows, its count and, while another page exists, its Load more. */
type ClosedSec = { id: string; label: string; rows: PrSummary[]; total: number | null; loading: boolean; failed?: boolean; more?: () => void };

export function TriageBoard({
  mine, review, total, hasTaskProvider, pinned,
  onOpen, onTogglePin, onShowTable, onAct, selected, menuOff, busy, acting, loading, settling, failed, hidden, onRetry, lastRead, root, repoKey, repoSlug,
  onlyUnread, onOnlyUnread, unfiltered, lens, others, showEveryone, results, more, viewer, person,
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
  /** `to: "notes"` lands on the Conversation, filtered to what plugins wrote. */
  /** `how` is only "dblclick" when the whole panel is asked for (lib/prDock.ts); a click docks. */
  onOpen: (n: number, to?: "notes", how?: "click" | "dblclick") => void;
  onTogglePin: (p: PrSummary) => void;
  onShowTable: () => void;
  /** Perform the card's one suggested action. Only the ones this app can
   *  really do reach here — see suggestedAction. */
  onAct: (p: PrSummary, what: CardAction) => void;
  /** The pull request docked beside the board, when one is: its card wears the selected ring. */
  selected?: number | null;
  /** Menu entries the panel cannot do yet, with the reason each one gives. */
  menuOff?: Partial<Record<CardMenuId, string>>;
  /** True while an action is in flight, so a card cannot be pressed twice. */
  busy?: boolean;
  /** Which pull request that action is on. The board disables every card while
   *  one runs; the spinner belongs to the one you pressed. */
  acting?: ReadonlySet<number>;
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
  /** `owner/name`: what the local review's notes are stored under. Absent
   *  means no chips and no gate, which is the board as it was. */
  repoSlug?: string;
  /** When the rows last really came back; the error box quotes it. */
  lastRead?: number;
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
  /**
   * The two lists before the board's own filters.
   *
   * A stacked pull request names its base, and the base may be one the filters
   * hide; its card is not on the board but its state is still known, and the
   * token says it. Absent, the lists above are all there is.
   */
  unfiltered?: { mine: PrSummary[]; review: PrSummary[] };
  /**
   * What the filter deck took off the board, so each lane can say so: a live
   * "N hidden" with a mini strip in its heading, "All N hidden by your rules"
   * when it is empty because of them, and, while Alt is held or the pointer is
   * on the "N hidden", one hatched slip per hidden card saying which rule hid it.
   */
  lens?: {
    rows: PrSummary[];
    /** Board order of every row, kept or hidden: where a hidden one slips in among the cards. */
    rank: Map<number, number>;
    why: Map<number, { id: string; name: string; colour: string }>;
    onOpenRule: (id: string) => void;
    /** Drawn in place of the plain sentence when the filters hide every card. */
    wall?: ReactNode;
  };
  /**
   * The rest of the repository, one page of it: pull requests that are neither
   * yours nor asked of you. Filed in the same lanes (they have no stake, so they
   * land in "waiting on someone else" unless they are ready to land) and drawn
   * only by the views that reach past your two queues — see `BOARD_IS_WIDE`
   * and the "Show everyone's PRs" switch.
   */
  others?: PrSummary[];
  /** The repository's page is on this board because the person turned on "Show everyone's PRs" for this repository — the gate `BOARD_IS_WIDE` used to hold. */
  showEveryone?: boolean;
  /**
   * A flat list in place of the lanes: search results, or the closed and merged
   * pull requests. Lanes are a triage of OPEN work, and filing a merged pull
   * request would put it under "Blocked", so these are rows and not cards.
   */
  /**
   * The repository's list has another page. The board shows it as a card at the
   * end of the section (and a button in the footer under the lanes) that APPENDS
   * the next page: there is no Previous/Next, because a page number is a table's
   * idea and rows already seen should stay.
   */
  more?: { loading: boolean; onMore: () => void };
  /**
   * Whose board this is, when it is somebody else's: `mine` is what they opened,
   * `review` is what they were asked to look at, and every sentence is worded
   * about them (see `voice` in prLanes.ts). Absent is the owner's own board,
   * which draws exactly as it did before this prop existed.
   */
  viewer?: string;
  /** Only on a person's board: the way back to the owner's, and whether the
   *  person has more than the first page of either list. */
  person?: {
    /** The display name GitHub gave for the login, when it is already in hand. */
    name?: string;
    onBack: () => void; more: boolean; /** Star on the banner: follow this colleague. */ follow?: { on: boolean; toggle: () => void };
    /** When their open lists were last read, for "checked just now". */
    checkedAt?: number;
    /** Their merged and closed pull requests, which the Closed tab switches on. */
    closed?: { on: boolean; set: (on: boolean) => void; sections: ClosedSec[] };
  };
  results?: {
    /** Why a card is in this search, when the box is about a person: "name: author, reviewer". */
    why?: (p: PrSummary) => string | null;
    /** The name of the rule that keeps this pull request off the board, when one does. */
    hiddenBy?: (n: number) => string | undefined;
    title: string;
    rows: PrSummary[];
    /** The rows split under their own headings, each with its count and its own
     *  Load more (the viewer's merged and closed-without-merging). When set,
     *  `rows` is every section's rows together and drives the heading count. */
    sections?: { id: string; label: string; rows: PrSummary[]; total: number | null; loading: boolean; failed?: boolean; /** Present only while another page exists. */ more?: () => void }[];
    /** The list is being fetched and has nothing to show yet. */
    loading: boolean;
    /** What an empty answer says. */
    empty: string;
    /** Back to the lanes. */
    onBack: () => void;
    /** Present while GitHub has not been asked yet: what was typed, and the press that asks. */
    ask?: { query: string; run: () => void };
  };
}) {
  /* The closed list's All | Merged | Closed switch. */
  const [closedF, setClosedF] = useState<"all" | "merged" | "closed">("all");
  /* Answers arriving one at a time, each one a re-render of the board and
     nothing else — the cards do not move, a chip appears on one of them. */
  const [, bump] = useState(0);
  useEffect(() => onBehind(() => bump((n) => n + 1)), []);
  useEffect(() => onConflict(() => bump((n) => n + 1)), []);
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
  /* What an opened detail concluded (conflict, required check never reported)
     moves the card at once, with no request. See prKnownBlock.ts. */
  const [knownTick, bumpKnown] = useState(0);
  useEffect(() => onKnownBlock(() => bumpKnown((n) => n + 1)), []);
  const trueChecks = useCallback((p0: PrSummary): PrSummary => {
    const p = root ? withKnownBlock(root, p0) : p0;
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
    for (const p of [...mine, ...review, ...(others ?? [])]) for (const c of trueChecks(p).checks?.failing ?? []) { const j = jobIdOf(c); if (j) ids.add(j); }
    if (ids.size) void loadCached(root, [...ids]);
  }, [root, mine, review, others, trueChecks, rollupTick]);

  /* Whether the repository's page is on this board at all. Counted from the
     * view, not from `others` being non-empty: an empty page is still "wide". */
  const wide = !!showEveryone && !!others;
  /* What the plugins' reviews say about these cards: ONE read for the board,
     asked again when a card's head moves or a plugin writes (see
     prNotesSummaryStore.ts). The gate is a second switch on the same data and
     is OFF unless the person turned it on, in which case `gateOf` is absent and
     the filing below is the one it always was. */
  const notesTick = useSyncExternalStore(onNotesSummary, notesSummaryVersion, notesSummaryVersion);
  const gateOn = useSyncExternalStore(onReviewGate, reviewGateOn, reviewGateOn);
  const headsKey = useMemo(() => JSON.stringify(headsOf([...mine, ...review, ...(others ?? [])])), [mine, review, others]);
  useEffect(() => {
    if (!repoSlug || viewer) return;
    const heads = JSON.parse(headsKey) as Record<number, string>;
    void loadNotesSummary(repoSlug, heads);
    return refreshOnNotes(repoSlug, () => heads);
  }, [repoSlug, viewer, headsKey]);
  const summaries = viewer ? summariesOf(undefined) : summariesOf(repoSlug);
  const lanes = useMemo(() => {
    // De-duplicated by number before filing: a pull request that is both yours
    // and asked of you arrives twice, and would otherwise be drawn twice.
    const by = new Map<number, PrSummary>();
    for (const p of [...mine, ...review, ...(wide ? others ?? [] : [])]) if (!by.has(p.number)) by.set(p.number, viewer ? notTheOwners(trueChecks(p)) : trueChecks(p));
    const m = new Set(mine.map((p) => p.number));
    const r = new Set(review.map((p) => p.number));
    const filed = fileAll([...by.values()], (p) => ({ mine: m.has(p.number), asked: r.has(p.number) }),
      (p) => (root && p.checks?.failing?.length ? failureHint(p.checks.failing, (job) => summaryOf(failureKey(root, job))) : null),
      viewer,
      gateOn ? (p) => gateFacts(summaries.get(p.number)) : undefined);
    return filed;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mine, review, others, wide, trueChecks, bumpRollup, root, failureTick, knownTick, viewer, gateOn, notesTick]);

  const cards = useMemo(() => [...lanes.values()].flat(), [lanes]);
  /* Per repository: this board IS one repository's, so the answer is read off
     every card on it. See prCardBlock.ts for the rule and its ceiling. */
  const cuSetup = useClickupSetup();
  const noCustomIds = cuSetup?.noCustomIds === true;
  const trackers = useTrackerSetup();
  /* One menu serves every card on the board, opened at a point. */
  const [menu, setMenu] = useState<{ p: Card; x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const repoUses = useMemo(() => repoUsesTracker(cards, hasTaskProvider, noCustomIds), [cards, hasTaskProvider, noCustomIds]);
  /*
   * STACKS. Read off the lists in hand — `unfiltered` when the panel says what
   * the filters hid, so a base that is filtered out is still a base — plus the
   * few bases the lists do not hold, asked one branch at a time. See prStack.ts.
   */
  const everyone = useMemo(() => {
    const by = new Map<number, PrSummary>();
    for (const p of [...cards, ...(unfiltered?.mine ?? []), ...(unfiltered?.review ?? [])]) if (!by.has(p.number)) by.set(p.number, p);
    return [...by.values()];
  }, [cards, unfiltered]);
  const onBoard = useMemo(() => new Set(cards.map((c) => c.number)), [cards]);
  const isShown = useCallback((n: number) => onBoard.has(n), [onBoard]);
  const stacks = usePrStacks(root, everyone, isShown);

  /* THE CARD MENU. What it offers is decided in lib/prCardMenu.ts from the same
     facts the card's footer reads; this only gathers them for the card that was
     pressed, and does the entries that need nothing from the panel. */
  const menuModel = (() => {
    if (!menu) return null;
    const { p } = menu;
    const shown = withCard(p, hasTaskProvider).card;
    const task = taskLink(p, hasTaskProvider);
    const cardId = shown ? (shown.customId ?? shown.id) : task?.label;
    const tracker = trackerNameOf(cardId, trackers);
    const mode: TrackerMode = !tracker ? "none" : !cardId ? "unlinked"
      : tracker === "Jira" ? "jira" : cuSetup?.writeEnabled === false ? "ro" : "clickup";
    const reviewers = cardReviewers(p.humanReview);
    const view = cardView({
      p, filed: p.filed, reviewers,
      behind: root ? behindOf(root, p.number) : null, tracker: "none", hasTaskProvider,
    });
    return applyOff(cardMenu({
      p, view, pinned: pinned(p.number), mode, leftovers: (() => { const o = root ? offerFor(leftoverFor(root, p.number, p.state), "card") : null; return o?.button ? o.chip ?? "" : undefined; })(), tracker: tracker ?? undefined, cardId, stacked: !!stacks.of(p.number),
      waiting: reviewers.waiting.length > 0,
    }), viewer ? { ...menuOff, hideauthor: HIDE_OFF, hidebranch: HIDE_OFF } : menuOff);
  })();
  const pickFromMenu = (id: CardMenuId) => {
    if (!menu) return;
    const { p } = menu;
    const clip = (text: string) => { void navigator.clipboard?.writeText(text).catch(() => {}); };
    const shown = withCard(p, hasTaskProvider).card;
    const task = taskLink(p, hasTaskProvider);
    switch (id) {
      case "open": onOpen(p.number); return;
      case "github": window.open(p.url, "_blank", "noopener"); return;
      case "copylink": clip(p.url || ""); return;
      case "copynum": clip(`#${p.number}`); return;
      case "copybranch": clip(p.headRefName); return;
      case "copycard": clip(shown ? (shown.customId ?? shown.id) : task?.label ?? ""); return;
      case "copycardname": clip(shown?.title ?? ""); return;
      case "copycardlink": clip(externalUrl(shown?.url) ?? ""); return;
      case "pin": onTogglePin(p); return;
      case "card":
        if (shown) openCard(shown.customId || shown.id, shown.customId);
        else if (task) openCard(task.query, task.label);
        return;
      default: onAct(p, id);
    }
  };
  const menuEl = menu && menuModel && (
    <PrCardMenu menu={menuModel} x={menu.x} y={menu.y} onPick={pickFromMenu} onClose={closeMenu} />
  );
  /* The column a filtered-out pull request WOULD sit in: the same filing, so the
     word on a token is the one its own card would carry. */
  const laneOfAll = useMemo(() => {
    const out = laneMap(everyone.filter((p) => !onBoard.has(p.number)),
      new Set((unfiltered?.mine ?? mine).map((p) => p.number)), new Set((unfiltered?.review ?? review).map((p) => p.number)), trueChecks);
    for (const c of cards) out.set(c.number, c.filed.lane);
    return out;
  }, [cards, everyone, onBoard, unfiltered, mine, review, trueChecks]);
  /* Where each hidden card would sit, by the same filing as the visible ones. */
  const hiddenLane = useMemo(() => laneMap(lens?.rows ?? [],
    new Set((unfiltered?.mine ?? mine).map((p) => p.number)), new Set((unfiltered?.review ?? review).map((p) => p.number)), trueChecks),
  [lens?.rows, unfiltered, mine, review, trueChecks]);
  /* One hidden card, drawn as a slip in its culprit's colour; a press opens the rule. */
  const slipOf = (p: PrSummary) => {
const w = lens?.why.get(p.number);
        const c = w?.colour ?? "var(--text3)";
        return (
          <button key={`hidden-${p.number}`} type="button" onClick={() => w && lens?.onOpenRule(w.id)}
            title={`#${p.number} ${p.title} — hidden by ${w?.name ?? "a rule"}. Click to open the rule.`}
            className="relative w-full flex items-center gap-2 mb-2 pl-3 pr-2 py-1.5 rounded-lg text-left text-[11px] agx-btn overflow-hidden"
            style={{ border: `1px dashed color-mix(in srgb, ${c} 45%, transparent)`, color: "var(--text3)",
              background: `repeating-linear-gradient(135deg, color-mix(in srgb, ${c} 9%, transparent) 0 6px, transparent 6px 12px)` }}>
            <span aria-hidden className="absolute left-0 top-1 bottom-1 w-[3px] rounded-sm" style={{ background: c }} />
            <span className="tabular-nums shrink-0" style={{ color: "var(--text2)" }}>#{p.number}</span>
            <span className="truncate flex-1 min-w-0" style={{ textDecoration: "line-through", textDecorationColor: "var(--text4)" }}>{p.title}</span>
            <span className="min-w-0 max-w-[70%] truncate text-[10.5px]">hidden by <b style={{ color: c, fontWeight: 600 }}>{w?.name ?? "a rule"}</b></span>
          </button>
        );
  };
  /* Alt held shows every hidden card as a slip; the pointer on one lane's "N hidden" shows that lane's. */
  const [altHeld, setAltHeld] = useState(false);
  const [peek, setPeek] = useState<string | null>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => setAltHeld(e.altKey);
    const off = () => setAltHeld(false);
    window.addEventListener("keydown", k); window.addEventListener("keyup", k); window.addEventListener("blur", off);
    return () => { window.removeEventListener("keydown", k); window.removeEventListener("keyup", k); window.removeEventListener("blur", off); };
  }, []);
  const factsOf = useMemo(() => factsReader({
    pool: everyone, found: stacks.found, onBoard: (n) => onBoard.has(n), lane: (n) => laneOfAll.get(n),
    status: (p) => withCard(p, hasTaskProvider).card?.status,
  }), [everyone, stacks, onBoard, laneOfAll, hasTaskProvider]);
  /* Outlined while the pointer is on the token that names it. */
  const [lit, setLit] = useState<number | null>(null);
  /* The chain a stack chip lights: every card of the stack that is on screen. */
  const [chain, setChain] = useState<{ members: Set<number>; me: number } | null>(null);
  const onChain = useCallback((members: number[] | null, me: number) => setChain(members ? { members: new Set(members), me } : null), []);
  const involved = cards.length;
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
  const totalKnown = !viewer && rest >= 0;
  const tableLabel = rest > 0 ? `Show all ${total}` : "Show every open pull request";

  /*
   * The columns actually drawn: every lane, empty or not (the mockup always
   * draws all five, and an empty "Waiting on someone else" is an answer).
   * Everything downstream counts columns rather than lanes so the counts and
   * the grid template agree with what is in front of you.
   */
  const hScroll = useRef<HTMLDivElement>(null);
  /* Under this width the lanes become tabs: one lane at a time, each tab keeping its live count. */
  const [narrowBoard, setNarrowBoard] = useState(false);
  const [boardPx, setBoardPx] = useState(0);
  const [laneTab, setLaneTab] = useState<string | null>(null);
  useEffect(() => {
    const el = hScroll.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => { setNarrowBoard(el.clientWidth < NARROW_BOARD_PX); setBoardPx(el.clientWidth); });
    ro.observe(el);
    return () => ro.disconnect();
    /* The scroller unmounts while a results view (Closed) is up and a new one mounts on return; observing once left `narrowBoard` stuck at the width-0 reading and the board showed one lane. */
  }, [!!results, !!(person && viewer && person.closed?.on)]);
  const cols = useMemo(() => lanesFor(viewer), [viewer]);
  const activeTab = cols.some((l) => l.id === laneTab) ? laneTab : cols[0]?.id;
  const shownCols = narrowBoard ? cols.filter((l) => l.id === activeTab) : cols;
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
   * Lanes are a fixed LANE_WIDTH_PX, so a window too narrow for them scrolls
   * sideways instead of squeezing. A folded lane (44 px) still gives back
   * the difference plus its gap, so folding is how a narrow window sees
   * more lanes at once, without a breakpoint and without anything moving on
   * its own.
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
      /* Another person's board reads your folds and sorts but never writes them: folding theirs must not fold yours. */
      if (!viewer) setFoldedLanes(next);
      return next;
    });
  }, [folded, viewer]);
  /* Sort order per lane, persisted like the folds. The default is never
     stored, and sorting is a view over the cards already in hand: no request. */
  const [sorts, setSorts] = useState<Record<string, SortKey>>(() => laneSorts(laneIds));
  /* Entering or leaving a person's board starts again from what is saved, so what was folded or sorted over there does not follow you back. */
  const seatedFor = useRef(viewer);
  useEffect(() => {
    if (seatedFor.current === viewer) return;
    seatedFor.current = viewer;
    setFolded(foldedLanes(laneIds)); setSorts(laneSorts(laneIds));
  }, [viewer, laneIds]);
  const sortOf = useCallback((id: string): SortKey => sorts[id] ?? "default", [sorts]);
  const titleOf = useMemo(() => {
    const m = new Map(everyone.map((p) => [p.number, p.title] as const));
    return (n: number) => m.get(n);
  }, [everyone]);
  /* The gutter rail of each lane: where two stack neighbours sit one right under the other. */
  const rails = useMemo(() => {
    const out = new Map<string, Map<number, RailView>>();
    for (const l of cols) {
      const order = sortCards(lanes.get(l.id) ?? [], sortOf(l.id)).map((p) => p.number);
      const links = railLinks(order, (n) => stacks.of(n)?.next ?? [], (n) => {
        const s = stacks.of(n);
        return s ? stackRows(s, n).find((r) => r.me)?.pos : undefined;
      });
      if (links.size) out.set(l.id, links);
    }
    return out;
  }, [cols, lanes, sortOf, stacks]);
  /** A lane is a fixed column: the card's 336px and its air, wider by the gutter when a rail hangs in it. */
  const laneWidth = (id: string) => LANE_WIDTH_PX + (rails.has(id) ? RAIL_WIDTH_PX : 0);
  const setSort = useCallback((id: string, k: SortKey) => {
    setSorts((cur) => {
      const next = { ...cur, [id]: k };
      if (!viewer) setLaneSorts(next);
      return next;
    });
  }, [viewer]);
  const frame = useRef<HTMLDivElement>(null);
  /* The frame takes focus on arrival so ⌃F reaches the board's find. A field
     that is already focused keeps it: stealing focus from somebody typing is
     worse than the bug. The board mounts only while it is the view on screen,
     so this runs on arrival and not while it sits behind another view. */
  useEffect(() => {
    const held = document.activeElement as HTMLElement | null;
    const typing = !!held && (
      held.tagName === "INPUT" || held.tagName === "TEXTAREA" || held.isContentEditable
    );
    if (!typing) frame.current?.focus({ preventScroll: true });
  }, []);
  // The find walks exactly what is drawn — an opened lane included, or it
  // would step onto a card past the cap that nobody can see.
  const shown = useCallback((i: number) => {
    const id = cols[i]?.id ?? "review";
    /* A folded lane walks as empty, which is the app's own answer three times
       over — `DockerPanel.ordered` says it out loud: skip collapsed stacks
       rather than jump into a container nobody can see. Without this the find steps onto a card behind a 44px
       strip: the heal below only rescues an EMPTY lane, and a folded lane with
       six cards in it reports six. */
    return walkable(sortCards(lanes.get(id) ?? [], sortOf(id)), {
      folded: isFolded(id), opened: !!openLanes[id], cap: LANE_CAP,
    });
  }, [lanes, cols, openLanes, isFolded, sortOf]);

  /* Where the board was left: the sideways scroll and each lane's own, per
     repository, restored once the lanes are drawn and written (debounced) as
     they move. Local storage only, no request. */
  const scrollKey = repoKey ?? "repo";
  const laneScrolls = useRef(new Map<string, HTMLDivElement>());
  const saved = useRef<ReturnType<typeof boardScroll> | null>(null);
  const restored = useRef(false);
  const writeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /* What the last scroll left, taken at the scroll itself: by the time the board unmounts its elements are gone. */
  const latest = useRef<ReturnType<typeof boardScroll> | null>(null);
  const remember = useCallback(() => {
    if (!restored.current) return;
    const lanesY: Record<string, number> = {};
    for (const [id, el] of laneScrolls.current) lanesY[id] = Math.round(el.scrollTop);
    latest.current = { x: Math.round(hScroll.current?.scrollLeft ?? 0), lanes: lanesY };
    if (writeTimer.current) clearTimeout(writeTimer.current);
    writeTimer.current = setTimeout(() => { writeTimer.current = null; if (latest.current) setBoardScroll(scrollKey, latest.current); }, 200);
  }, [scrollKey]);
  /* Leaving the board (full screen) inside the debounce window would drop the last scroll; write what is pending now. */
  useEffect(() => () => {
    if (!writeTimer.current) return;
    clearTimeout(writeTimer.current);
    if (latest.current) setBoardScroll(scrollKey, latest.current);
  }, [scrollKey]);
  const drawnLanes = face === "rows";
  useLayoutEffect(() => {
    if (!drawnLanes || restored.current) return;
    saved.current ??= boardScroll(scrollKey);
    if (hScroll.current) hScroll.current.scrollLeft = saved.current.x;
    for (const [id, el] of laneScrolls.current) el.scrollTop = saved.current.lanes[id] ?? 0;
    restored.current = true;
  }, [drawnLanes, scrollKey]);

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

  /* The board is mouse-driven: no card cursor, no j/k. Cards are buttons and
     links, so Tab reaches them the ordinary way. */
  const onKey = (e: React.KeyboardEvent) => {
    /* ⌃F opens the app's own find bar, seeded with whatever is already being
       searched — the board no longer has a field of its own, and the bar is
       driving this search either way (see the engine above). */
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      openFind(find);
      return;
    }
    /* j and k walk the cards the board draws, in reading order. Only from a card
       or the board itself: a field, a menu button or a link keeps its letters. */
    const key = e.key;
    if ((key === "j" || key === "k") && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const t = e.target as HTMLElement;
      if (t !== e.currentTarget && !t.hasAttribute("data-pr")) return;
      const nodes = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[data-pr]")).filter((n) => n.offsetParent !== null);
      const next = nodes[cardStep(nodes.length, nodes.indexOf(t), key === "j" ? 1 : -1)];
      if (next) { e.preventDefault(); next.focus(); next.scrollIntoView({ block: "nearest" }); }
    }
  };

  /* Which lane of YOUR board each open result sits in: a result is filed there only when the board has it. */
  const laneOf = useMemo(() => {
    const m = new Map<number, LaneId>();
    for (const [id, cards] of lanes) for (const c of cards) m.set(c.number, id);
    return m;
  }, [lanes]);
  const resultGrid = (rows: PrSummary[], more: { loading: boolean; onMore: () => void } | undefined, dim: boolean) => (
            <div className="flex flex-col gap-2 pt-1" role="list" aria-label="Results"
              style={{ opacity: dim ? 0.7 : 1, transition: "opacity .15s" }}>
              {rows.map((r) => {
                const p = trueChecks(r);
                /* The menu is the card's, and files the pull request the way the board would. */
                const base: Filed = p.state === "MERGED" ? { lane: "others", reason: "Merged." }
                  : p.state === "CLOSED" ? { lane: "others", reason: "Closed without merging." }
                  : stillReading(p) ? { lane: "others", reason: "Reading its checks…" }
                  : fileInLane(p, { mine: false, asked: false });
                /* A person's board says how they come into it ("wrote", "asked to review"); a search says why it matched. */
                const why = person && viewer ? (p.author === viewer ? "wrote" : "asked to review") : results?.why?.(p) ?? null;
                const view = resultRow(p, { lane: laneOf.get(p.number) ?? null, hiddenBy: results?.hiddenBy?.(p.number) ?? null, why });
                return (
                  <ResultRowView key={p.number} p={p} view={view} bare={!!person} closed={!!results?.sections} selected={selected === p.number}
                    onOpen={() => onOpen(p.number)} onOpenFull={() => onOpen(p.number, undefined, "dblclick")}
                    root={root} onClean={() => onAct(p, "clean")}
                    onMenu={(at) => setMenu({ p: { ...p, filed: base }, ...at })} />
                );
              })}
              {more && (
                <button onClick={more.onMore} disabled={more.loading}
                  className="agx-btn rounded-lg text-[11px] disabled:opacity-60"
                  style={{ minHeight: 40, border: `1px dashed color-mix(in srgb, var(--text) 24%, transparent)`, color: "var(--text2)" }}>
                  {more.loading ? "Loading more…" : "Load more"}
                </button>
              )}
            </div>
  );

  /* A person's Closed tab is the Closed list of this board, fed with their pull requests: one component, whoever's they are. */
  const closedOfPerson = !results && !!(person && viewer && person.closed?.on);
  const closedView = closedOfPerson && person
    ? { title: "", rows: [], sections: person.closed!.sections, loading: false, empty: "", onBack: person.onBack } as NonNullable<typeof results>
    : results;
  if (closedView) {
    /* The same rows the list below draws: the sections the switch shows, newest first. */
    const closedSecs = closedView.sections?.filter((x) => closedF === "all" || (closedF === "merged") === (x.id === "merged")) ?? [];
    const closedRows = closedSecs.flatMap((x) => x.rows).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return (
      <div ref={frame} data-board {...(closedOfPerson ? { "data-person": "" } : null)} tabIndex={0} onKeyDown={onKey} className="flex flex-col h-full min-h-0 outline-none">
        {closedOfPerson && person && viewer && <div className="shrink-0 px-4 pt-3 pb-1.5"><PersonBanner login={viewer} name={person.name} onBack={person.onBack} follow={person.follow} /></div>}
        {closedView.sections ? (
          <div className="shrink-0 px-4 pt-3 pb-1.5 flex items-center gap-2">
            <Segmented<"all" | "merged" | "closed"> track label="Show" value={closedF} onChange={setClosedF}
              options={[{ id: "all", label: "All" }, { id: "merged", label: "Merged" }, { id: "closed", label: "Closed" }]} />
            <span className="flex-1" />
            {/* Newest first and not clipped to a window: the lists load a page at a time, so older ones are a Load more away. */}
            <span className="agx-srow-ss" style={{ marginTop: 0 }}>newest first</span>
            {root && <CleanAllButton root={root} rows={closedRows} />}
          </div>
        ) : (
          <div className="shrink-0 px-4 pt-3 pb-1.5 flex flex-col gap-1.5">
            <div className="agx-banner" role="status">
              <SearchIcon size={ICON.sm} />
              <span className="min-w-0"><b>Searching every pull request in {repoSlug || "this repository"}.</b> Your rules and saved views do not apply here.</span>
              <span className="flex-1" />
              <Button size="compact" onClick={closedView.onBack}>Back to the board</Button>
            </div>
            {/* The one thing the banner would otherwise overstate: until GitHub has been asked, only the loaded pull requests were searched. */}
            {closedView.ask && (
              <div className="agx-srow-ss min-w-0" style={{ marginTop: 0 }} title={closedView.title}>
                <span className="truncate">{closedView.title}</span>
              </div>
            )}
          </div>
        )}
        {/* A search that is still out: the cards stay, and this says so. */}
        <div aria-hidden className="shrink-0 h-0.5 mx-4 rounded-full"
          style={{ background: closedView.loading && closedView.rows.length > 0 ? "color-mix(in srgb, var(--primary) 55%, transparent)" : "transparent" }}
          {...(closedView.loading && closedView.rows.length > 0 ? { role: "progressbar" } : {})} />
        <div className="flex-1 min-h-0 overflow-y-auto agx-scroll px-4 pb-3" data-results>
          {!closedView.sections && closedView.loading && closedView.rows.length === 0 ? (
            <div aria-hidden className="flex flex-col gap-2 pt-1">
              {[0, 1, 2, 3, 4].map((k) => (
                <div key={k} className="rounded-lg animate-pulse"
                  style={{ height: 46, background: "var(--surface-card)", border: EDGE, animationDelay: `${k * 0.08}s` }} />
              ))}
            </div>
          ) : !closedView.sections && closedView.rows.length === 0 ? (
            <PrBlank icon={<SearchIcon size={ICON.lg} />}
              title={closedView.ask ? "No match in the pull requests I know" : "No pull request matches"}
              sentence={closedView.ask ? `Press Enter to ask GitHub about “${closedView.ask.query}”.` : closedView.empty}>
              {closedView.ask && <Button size="hit" tone="primary" onClick={closedView.ask.run}><SearchIcon size={ICON.sm} />Ask GitHub</Button>}
            </PrBlank>
          ) : closedView.sections ? (
            /* The closed list: one list under the switch, the viewer's merged and closed-without-merging together, newest first. */
            (() => {
              const secs = closedSecs, rows = closedRows;
              const busyNow = secs.some((x) => x.loading);
              const failedSecs = secs.filter((x) => x.failed);
              const more = secs.some((x) => x.more) ? { loading: busyNow, onMore: () => secs.forEach((x) => x.more?.()) } : undefined;
              if (rows.length === 0 && busyNow) return (
                <div aria-hidden className="flex flex-col gap-2 pt-1">
                  {[0, 1, 2, 3, 4].map((k) => <div key={k} className="rounded-lg animate-pulse" style={{ height: 46, background: "var(--surface-card)", border: EDGE, animationDelay: `${k * 0.08}s` }} />)}
                </div>
              );
              if (rows.length === 0) return failedSecs.length
                ? <PrNotice title="Could not load closed pull requests" actions={null}>GitHub did not answer in time. Leave this tab and come back to ask again.</PrNotice>
                : <PrBlank icon={<MergeIcon size={ICON.lg} />} title="Nothing closed" sentence="Merged and closed pull requests land here." ghost />;
              return (
                <>
                  {failedSecs.length > 0 && <p className="m-0 mb-1 text-[11px]" style={{ color: "var(--warning-ink)" }}>Could not read the {failedSecs.map((x) => x.label.toLowerCase()).join(" or ")} list.</p>}
                  <div style={{ opacity: busyNow ? 0.7 : 1, transition: "opacity .15s" }}>
                    <ClosedList rows={rows} resetKey={closedF} card={(r) => {
                      /* The inventory is local and read-only, asked for the rows on screen whoever wrote them; Clean up appears only where offerFor allows it. */
                      const p = { ...trueChecks(r), filed: { lane: "others", reason: r.state === "MERGED" ? "Merged." : "Closed without merging." } } as Card;
                      return (
                        <CardView p={p} hasTaskProvider={hasTaskProvider} repoUses={repoUses} lazyCard={!!viewer}
                          pinned={pinned(p.number)} onOpen={() => onOpen(p.number)} onOpenFull={() => onOpen(p.number, undefined, "dblclick")} onPin={() => onTogglePin(p)}
                          onAct={onAct} onMenu={(c, at) => setMenu({ p: c, ...at })} busy={busy} acting={acting} selected={selected === p.number}
                          root={root} unread={unread.get(p.number)} titleOf={titleOf} factsOf={factsOf} onOpenBase={onOpen} />
                      );
                    }} />
                    {more && (
                      <button onClick={more.onMore} disabled={more.loading}
                        className="agx-btn rounded-lg text-[11px] w-full mt-2 disabled:opacity-60"
                        style={{ minHeight: 40, border: `1px dashed color-mix(in srgb, var(--text) 24%, transparent)`, color: "var(--text2)" }}>
                        {more.loading ? "Loading more…" : "Load more"}
                      </button>
                    )}
                  </div>
                </>
              );
            })()
          ) : resultGrid(closedView.rows, more, closedView.loading)}
        </div>
        {menuEl}
      </div>
    );
  }

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
    <div ref={frame} data-board {...(person && viewer ? { "data-person": "" } : {})} tabIndex={0} onKeyDown={onKey} className="relative flex flex-col h-full min-h-0 outline-none">
      {person && viewer && <div className="shrink-0 px-4 pt-3 pb-1.5"><PersonBanner login={viewer} name={person.name} onBack={person.onBack} follow={person.follow} /></div>}
      {/*
        * The board's own tools: which of THESE cards, and the ones with news.
        *
        * They used to live on a line of their own above the lanes, with a
        * sentence ("13 open · yours and asked of you · 1 can land right now")
        * the mockup does not draw. The sentence is gone — the lane counts say
        * it — and the tools float at the bottom right instead of taking a row,
        * drawn only when there is something to do with them. Ctrl+F still
        * opens the find without them.
        */}
      {!waiting && involved > 0 && (unreadCount > 0 || onlyUnread || !!find || onlyLane !== null) && (
        <div className="agx-pl-tools">
          {/*
            * "Which of these is somebody waiting on me in", as one press.
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
              className="agx-btn inline-flex items-center gap-1 rounded-md px-2 text-[10.5px] tabular-nums"
              style={{ height: CTRL_H.compact,
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
          {/* The count is what the bar cannot say: how many of the cards in
              front of you answer, out of how many there are. It sits LEFT of
              the icon so the icon never moves, whatever state the board is in. */}
          {(find || onlyUnread || onlyLane !== null) && (
            <span className="text-[10.5px] tabular-nums whitespace-nowrap flex items-center gap-1.5"
              style={{ color: hits ? "var(--primary)" : "var(--warning)" }}>
              {find && <span className="font-medium">{find}</span>}
              {hits} of {involved}
              {/* One way out of every way in. A lane lit from its count is
                  left by pressing that count again, but the board should not
                  require you to remember which one you pressed. */}
              {(find || onlyLane !== null) && (
                <button onClick={() => { setFind(""); closeFind(); setOnlyLane(null); }}
                  title={find ? "Clear the search (Esc)" : "Show every lane again"}
                  className="agx-btn rounded grid place-items-center" style={{ width: CTRL_H.compact, height: CTRL_H.compact, color: "var(--text3)" }}><CloseIcon size={ICON.xs} /></button>
              )}
            </span>
          )}
          <button onClick={() => openFind()}
            aria-label="Find in these cards"
            aria-pressed={!!find}
            title="Find in these cards (⌃F) — number, title, author, branch, labels, assignees, reviewers, card id, card status, card people"
            className="agx-btn shrink-0 grid place-items-center rounded-md"
            style={{ width: MIN_BOX, height: MIN_BOX, color: find ? "var(--primary)" : "var(--text3)", border: EDGE }}>
            <SearchIcon size={ICON.xs} />
          </button>
        </div>
      )}

      {/* Sideways only. The five columns still have to be reachable on a narrow
          window; the up-and-down is each column's own, below. */}
      {narrowBoard && !waiting && face !== "failed" && face !== "filtered" && face !== "empty" && (
        <div role="tablist" aria-label="Lanes" className="shrink-0 flex gap-1 px-4 pt-2 pb-2 overflow-x-auto agx-scroll">
          {cols.map((l) => {
            const on = l.id === activeTab;
            const n = lanes.get(l.id)?.length ?? 0;
            const icons = stripMode(cols.map((c) => c.label.split(",")[0]), boardPx) === "icon";
            return (
              <button key={l.id} role="tab" aria-selected={on} onClick={() => setLaneTab(l.id)}
                aria-label={icons ? `${l.label}, ${n}` : undefined} data-tip={icons ? tipAttr({ name: l.label, detail: String(n) }) : undefined}
                className={`agx-btn rounded-md text-[10.5px] font-semibold uppercase tracking-wide inline-flex items-center gap-1.5 ${icons ? "flex-1 min-w-0 justify-center px-1" : "shrink-0 px-2"}`}
                style={{ height: CTRL_H.regular, color: on ? "var(--bg)" : l.tint, background: on ? l.tint : "var(--surface-inset)", boxShadow: on ? undefined : "inset 0 0 0 1px color-mix(in srgb, currentColor 22%, transparent)" }}>
                {icons ? LANE_GLYPH[l.id as LaneId] : l.label.split(",")[0]}<span className="tabular-nums">{n}</span>
              </button>
            );
          })}
        </div>
      )}
      <div ref={hScroll} onScroll={remember} className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden agx-scroll p-3">
        {face === "filtered" && lens?.wall ? lens.wall : face === "failed" ? (
          /* Not the answer "nothing": a read that failed has no number to give. */
          <PrNotice title="The pull requests could not be read"
            actions={onRetry ? <>
              <Button size="hit" tone="primary" onClick={onRetry}><RefreshIcon size={ICON.sm} />Try again</Button>
              {lastRead ? <span className="agx-notice-note">Last good read: {longAge(Date.now() - lastRead)}</span> : null}
            </> : null}>
            This is not an empty board: the list did not come back. Asking again costs the same two calls.
          </PrNotice>
        ) : face === "filtered" ? (
          /* The rows the rules hid are still there, one press away. */
          <PrBlank icon={<EyeIcon size={ICON.lg} />} tone="var(--warning)" title="Your rules hide every pull request on this board"
            sentence={`${hidden} came in and none passes the rules above; clear one to see them.`} />
        ) : face === "empty" ? (
          /* Loaded, and genuinely nothing. Said once, plainly, instead of five
             columns each announcing its own emptiness, which is the same
             sentence five times and reads as a board that failed to load. */
          person && viewer ? (
            <PrBlank icon={<DoneIcon size={ICON.lg} />} title="Nothing open"
              sentence={`Checked ${person.checkedAt && Date.now() - person.checkedAt > 45_000 ? `${ago(new Date(person.checkedAt).toISOString())} ago` : "just now"}: ${viewer} has no open pull request and nobody has asked them to review one.`}>
              {person.closed && <Button size="hit" tone="primary" onClick={() => person.closed!.set(true)}><MergeIcon size={ICON.sm} />Show {viewer}'s closed and merged PRs</Button>}
            </PrBlank>
          ) : <PrBlank icon={<PullRequestIcon size={ICON.lg} />} title="No open pull requests" ghost
            sentence={rest > 0
              ? `Nothing of yours is open in ${repoSlug || "this repository"}, and nobody has asked you to look at one. Quiet is good.`
              : `Nothing is open in ${repoSlug || "this repository"}. Quiet is good.`}>
            {onRetry && <Button size="hit" onClick={onRetry}><RefreshIcon size={ICON.sm} />Refresh</Button>}
            {rest > 0 && <Button size="hit" onClick={onShowTable}>{tableLabel}</Button>}
          </PrBlank>
        ) : (
          <div aria-busy={waiting || undefined} className="grid gap-2.5 h-full w-full" style={{
            /* A folded lane is a fixed 44px. An open one is at least
               LANE_WIDTH_PX and shares what the window has left (`1fr`), so a
               wide window is filled by its lanes instead of ending at the
               fourth with a blank strip. A narrow one scrolls whole lanes
               sideways, as a Jira board does: the grid is as wide as its
               minimums say (`minWidth`) and no narrower than the window. It
               cannot be `w-max`: `1fr` inside a max-content box sizes to the
               widest card (442px measured), not to the 300 the lanes ask for.
               Shift+wheel and the arrow keys scroll it natively. */
            minWidth: narrowBoard ? undefined : cols.reduce((n, l) => n + (isFolded(l.id) ? 44 : laneWidth(l.id)), 0) + (cols.length - 1) * 10,
            /* One lane at a time (the tabs): centred, so the dock's worst-case allowance for a rail (LANE_PX) is air on both sides, not a gap before the grip. */
            justifyContent: narrowBoard ? "center" : undefined,
            gridTemplateColumns: shownCols.map((l) => (isFolded(l.id) && !narrowBoard ? "44px" : `${laneWidth(l.id)}px`)).join(" "),
          }}>
            {shownCols.map((l, i) => {
              const all = sortCards(lanes.get(l.id) ?? [], sortOf(l.id));
              const opened = !!openLanes[l.id];
              const hiddenHere = lens ? lens.rows.filter((p) => hiddenLane.get(p.number) === l.id) : [];
              const slips = hiddenHere.length > 0 && (altHeld || peek === l.id);
              const hiddenNums = new Set(hiddenHere.map((p) => p.number));
              /* Slips sit where the card would: in the lane's own order, or in the chosen sort. */
              const entries: readonly PrSummary[] = !slips || !lens ? all
                : sortOf(l.id) === "default" ? slipIn<PrSummary>(all, hiddenHere, lens.rank) : [...sortCards<PrSummary>([...all, ...hiddenHere], sortOf(l.id))];
              const rows = opened ? entries : entries.slice(0, LANE_CAP + (slips ? hiddenHere.length : 0));
              const more = all.length - rows.filter((p) => !hiddenNums.has(p.number)).length;
              const canFold = foldable(l.id, all.length);
              return (
                /* A column is a box of its own height: heading fixed, cards
                   scrolling under it. `min-h-0` on both the column and its
                   scroller or the flex chain hands them their content height
                   and they grow instead of scrolling. `data-lane` names the box
                   from outside — it is the thing that scrolls, so it is the
                   thing a probe has to be able to point at. */
                <div key={l.id} data-lane={l.id} className="agx-pl min-w-0 min-h-0 flex flex-col"
                  style={{ "--lane": l.tint, transition: "width 120ms ease" } as CSSProperties}>
                  {(isFolded(l.id) && !narrowBoard) ? (
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
                      className="flex-1 min-h-0 w-full flex flex-col items-center gap-1.5 pt-2 pb-3 overflow-hidden agx-lane-bar"
                      style={{ color: l.tint, "--lane": l.tint } as CSSProperties}>
                      <span className="text-[13px] tabular-nums shrink-0">{waiting ? "…" : all.length}</span>
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
                    <h3 onClick={canFold ? () => toggleFold(l.id, all.length) : undefined}
                      className={`agx-pl-head${canFold ? " agx-lane-bar" : ""}`}
                      style={{ color: l.tint, "--lane": l.tint } as CSSProperties}>
                      {/* The lane's own mark, in its colour: the one thing besides the
                          name that tells five columns apart at a glance. */}
                      <span aria-hidden className="agx-pl-tile">{LANE_GLYPH[l.id]}</span>
                      <span className="truncate font-semibold" style={{ color: "var(--text)" }}>{l.label}</span>
                      {/* The lane's count, and the one way to light just this lane: it
                          used to be a chip in a row of its own above the lanes. A
                          lane with nothing in it has nothing to light, so it stays
                          plain: lighting it would leave every card quiet and the
                          way out the very count you just pressed. */}
                      {all.length > 0 && !waiting ? (
                        <button data-seg={l.id} onClick={(e) => { e.stopPropagation(); setOnlyLane((v) => (v === l.id ? null : l.id)); }}
                          aria-pressed={onlyLane === l.id}
                          title={onlyLane === l.id ? "Show every lane again" : `Light the ${all.length} in ${l.label.toLowerCase()}, quieten the rest`}
                          className="agx-btn rounded-lg px-1.5 tabular-nums shrink-0"
                          style={{ height: HIT, ...CODE_FONT_STYLE, fontSize: 11, color: onlyLane === l.id ? l.tint : "var(--text3)", background: onlyLane === l.id ? `color-mix(in srgb, ${l.tint} 16%, transparent)` : "transparent" }}>
                          {all.length}
                        </button>
                      ) : <span className="tabular-nums shrink-0" style={{ ...CODE_FONT_STYLE, fontSize: 11, color: "var(--text3)" }}>{waiting ? "…" : all.length}</span>}
                      {/* The lane's sentence lives on a tooltip: wrapped under the heading it ran
                          to one or two lines and the first card of each column started at a
                          different height. */}
                      {!waiting && (
                        <button type="button" data-tip={tipAttr(l.why)} aria-label={`About ${l.label}: ${l.why}`}
                          className="shrink-0 grid place-items-center rounded-lg agx-hover"
                          style={{ width: HIT, height: HIT, color: "var(--text4)" }}>
                          <InfoIcon size={ICON.sm} />
                        </button>
                      )}
                      <span className="flex-1" />
                      {/* Sort: in every lane and in every state, in the same place, so
                          nothing beside it moves. A dot says an order other than the
                          default is on; the menu says which. */}
                      {!waiting && <SortButton lane={l.id} label={l.label} value={sortOf(l.id)} onPick={(k) => setSort(l.id, k)} only={onlyLane === l.id} onOnly={() => setOnlyLane((v) => (v === l.id ? null : l.id))} />}
                      {/*
                        * The fold lives HERE and not on the counts row above.
                        *
                        * That row is one chip per lane already and would have
                        * been the obvious place — but a test forbids a button
                        * in it, and the comment behind that test says why: "a
                        * row of buttons up here would read as filters that
                        * shrink the board". The heading is where the count
                        * already is.
                        *
                        * The lane the board exists for cannot be folded WHILE
                        * IT HOLDS SOMETHING, and then it draws no control
                        * rather than a dead one. At zero it folds like any
                        * other: an empty lane is asking nothing, and it was
                        * still taking 268px of a board that does not fit
                        * five columns — a lane that cannot be folded under a
                        * heading reading `0 NEEDS YOUR REVIEW`.
                        */}
                      {canFold && !waiting && (
                        <button onClick={(e) => { e.stopPropagation(); toggleFold(l.id, all.length); }}
                          aria-expanded
                          title={`Fold ${l.label} — its ${all.length} stay counted`}
                          aria-label={`Fold ${l.label}`}
                          className="shrink-0 grid place-items-center rounded-lg agx-hover"
                          style={{ width: HIT, height: HIT, color: "var(--text4)" }}>
                          <MinusIcon size={ICON.sm} />
                        </button>
                      )}
                    </h3>
                    {/* What the filters took off this lane: a dashed row, and a
                        way to see which. Holding Alt peeks too. */}
                    {hiddenHere.length > 0 && !waiting && (
                      <div data-hidden-in={l.id} className="agx-pl-hid"
                        title={`${hiddenHere.length} hidden by your rules. Hold Alt to see which rule hid each.`}>
                        <span aria-hidden className="inline-flex gap-0.5 shrink-0">
                          {hiddenHere.slice(0, 8).map((p) => {
                            const c = lens?.why.get(p.number)?.colour ?? "var(--text3)";
                            return <i key={p.number} style={{ width: 9, height: 9, borderRadius: 3, background: `repeating-linear-gradient(135deg, ${c} 0 2px, color-mix(in srgb, ${c} 30%, transparent) 2px 4px)` }} />;
                          })}
                        </span>
                        <span className="truncate min-w-0">{hiddenHere.length} hidden by your rules</span>
                        <button type="button" className="agx-pl-peek" aria-pressed={peek === l.id}
                          onClick={() => setPeek(peek === l.id ? null : l.id)}>
                          {peek === l.id ? "Hide again" : "Peek"}
                        </button>
                      </div>
                    )}
                  </div>

                  {/* `pb-2`: the last thing in a lane sat flush against the
                      bottom edge of the column, and a bordered button there
                      reads as clipped — "the Show fewer button looks sort of
                      eaten away". Cards had `mb-2` between them and nothing after
                      the final one. */}
                  <div ref={(el) => { if (el) laneScrolls.current.set(l.id, el); else laneScrolls.current.delete(l.id); }}
                    onScroll={remember} className="flex-1 min-h-0 overflow-y-auto agx-scroll pb-2">
                    {waiting ? (
                      /* The shape of the thing being waited for, and no text:
                         a lane cannot honestly say how many it will hold. */
                      <div aria-hidden>
                        {[0, 1].slice(0, i === 0 ? 2 : 1).map((k) => (
                          <div key={k} className="agx-prc-sk">
                            <i className="agx-sk" style={{ width: "60%", height: 12 }} />
                            <i className="agx-sk" style={{ width: "100%", height: 16 }} />
                            <i className="agx-sk" style={{ width: "85%", height: 16 }} />
                            <i className="agx-sk" style={{ width: "100%", height: 24, borderRadius: 7 }} />
                            <i className="agx-sk" style={{ width: "70%", height: 24, borderRadius: 7 }} />
                            <i className="agx-sk" style={{ width: "100%", height: 6, borderRadius: 3 }} />
                            <div className="flex gap-1.5 mt-1.5">
                              <i className="agx-sk" style={{ width: 70, height: 26, borderRadius: 7 }} />
                              <i className="agx-sk" style={{ width: 110, height: 26, borderRadius: 7 }} />
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <>
                        {rows.map((p) => hiddenNums.has(p.number) ? slipOf(p) : (
                          <CardView key={p.number} p={p as Card} hasTaskProvider={hasTaskProvider} repoUses={repoUses} lazyCard={!!viewer}
                            pinned={pinned(p.number)} onOpen={() => onOpen(p.number)} onOpenFull={() => onOpen(p.number, undefined, "dblclick")} onPin={() => onTogglePin(p)}
                            notes={summaries.get(p.number)} onOpenNotes={() => onOpen(p.number, "notes")}
                            onAct={onAct} onMenu={(c, at) => setMenu({ p: c, ...at })} busy={busy} acting={acting} selected={selected === p.number}
                            dim={!matches(p) || (onlyLane !== null && onlyLane !== l.id)} root={root}
                            unread={unread.get(p.number)}
                            stack={stacks.of(p.number)} titleOf={titleOf} factsOf={factsOf} lit={lit === p.number} onLit={setLit} onOpenBase={onOpen}
                            chain={chain?.members.has(p.number) ? (chain.me === p.number ? "me" : "on") : undefined} onChain={onChain}
                            rail={rails.get(l.id)?.get(p.number)} gutter={rails.has(l.id)} />
                        ))}
                        {/* Counted, and openable HERE. The cap is what keeps
                            the board a glance on a bad week; the rest of the
                            lane is one press away and lands in the lane it
                            belongs to, not in a table on the other side of the
                            panel. The column already scrolls. */}
                        {more > 0 && (
                          <button onClick={() => setOpenLanes((o) => ({ ...o, [l.id]: true }))}
                            title={`Show the other ${more} in this lane`}
                            className="agx-btn w-full rounded-md py-1 mb-2 text-[11px]"
                            style={{ color: "var(--text3)", border: EDGE }}>
                            Show the other {more}
                          </button>
                        )}
                        {opened && all.length > LANE_CAP && (
                          <button onClick={() => setOpenLanes((o) => ({ ...o, [l.id]: false }))}
                            title={`Back to the first ${LANE_CAP}`}
                            className="agx-btn w-full rounded-md py-1 mb-2 text-[11px]"
                            style={{ color: "var(--text4)", border: EDGE }}>
                            Back to the first {LANE_CAP}
                          </button>
                        )}
                        {all.length === 0 && (
                          <p className="m-0 px-0.5 text-[10.5px]" style={{ color: "var(--text4)" }}>
                            {hiddenHere.length > 0 ? "Everything here is hidden by your rules." : "Nothing here. Quiet is good."}
                          </p>
                        )}
                      </>
                    )}
                  </div>
                  {!waiting && all.length > 0 && (
                    <div className="agx-pl-foot" title="Measured from each pull request's last activity">
                      <ClockIcon size={ICON.xs} />Median age {medianAge(all)}
                    </div>
                  )}
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
      {!waiting && involved > 0 && (wide || viewer || (totalKnown && rest > 0) || quiet > 0) && (
        <div className="shrink-0 flex flex-wrap items-center gap-2.5 px-4 py-2 text-[10.5px]"
          style={{ color: "var(--text3)", borderTop: LINE }}>
          {wide ? (
            more ? (
              <button onClick={more.onMore} disabled={more.loading} className="inline-flex items-center justify-center agx-btn rounded px-2 disabled:opacity-60"
                style={{ height: CTRL_H.compact, color: "var(--text2)", border: EDGE }}>
                {more.loading ? "Loading more…" : "Load more pull requests"}
              </button>
            ) : <span>That is every pull request in this list.</span>
          ) : viewer ? (
            <span>Only {viewer}'s two lists are on this board: the open ones {viewer} opened and was asked to review.{person?.more ? " Only the first page of each list is read." : ""}</span>
          ) : totalKnown && rest > 0 ? (
            <span>The other <b style={{ color: "var(--text2)" }}>{rest}</b> open pull requests want nothing from you right now.</span>
          ) : null}
          {quiet > 0 && (
            <>
              {(wide || viewer || (totalKnown && rest > 0)) && <span style={{ color: "var(--text4)" }}>·</span>}
              <span title="Measured from each pull request's last update, which GitHub moves for a push, a comment or a label. Counted only over the ones on this board.">
                {quiet} of these {quiet === 1 ? "has" : "have"} gone {QUIET_DAYS} days without a push or a comment
              </span>
            </>
          )}
        </div>
      )}
      {menuEl}
    </div>
  );
}

/**
 * A lane's sort, as an icon and a menu instead of a select.
 *
 * The select spelled out "Default order" in every lane's bar, up to 140px of a
 * 268px column, to say that nothing was changed. The icon takes the house square (HIT, the mockup's `.btn.sq`), and the
 * dot is the whole of the state that matters on the bar: an order other than
 * the default is on. Which one is the menu's tick and the tooltip's. It stays
 * in the same place in every state, and a press on it never folds the lane.
 */
function SortButton({ lane, label, value, onPick, only, onOnly }: { lane: string; label: string; value: SortKey; onPick: (k: SortKey) => void; only: boolean; onOnly: () => void }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const on = value !== "default";
  return (
    <>
      <button ref={anchor} data-sort={lane} onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        aria-label={`Sort ${label}`} aria-haspopup="menu" aria-expanded={open}
        title={on ? `Sorted by ${SORT_LABEL[value].toLowerCase()}` : "Sort this lane"}
        className="ml-auto shrink-0 relative grid place-items-center rounded-lg agx-hover"
        style={{ width: HIT, height: HIT, color: on ? "var(--text2)" : "var(--text4)" }}>
        <svg viewBox="0 0 16 16" width={ICON.sm} height={ICON.sm} fill="none" stroke="currentColor"
          strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
          <path d="M5 13V3M2.5 5.5 5 3l2.5 2.5M11 3v10M8.5 10.5 11 13l2.5-2.5" />
        </svg>
        {on && <span data-sort-dot aria-hidden className="absolute rounded-full"
          style={{ top: 2, right: 2, width: 5, height: 5, background: "var(--primary)" }} />}
      </button>
      {open && (
        <AnchoredMenu anchor={anchor} align="left" minWidth={180} onClose={() => setOpen(false)}>
          <PopHead>Sort this lane</PopHead>
          {SORT_KEYS.map((k) => (
            <MenuRow key={k} icon={k === value ? <DoneIcon size={ICON.xs} /> : <span aria-hidden style={{ width: ICON.xs }} />}
              onClick={() => { onPick(k); setOpen(false); }}>{SORT_LABEL[k]}</MenuRow>
          ))}
          <MenuRule />
          <MenuRow icon={<span aria-hidden style={{ width: ICON.xs }} />} onClick={() => { onOnly(); setOpen(false); }}>
            {only ? "Light every lane again" : "Light only this lane"}
          </MenuRow>
        </AnchoredMenu>
      )}
    </>
  );
}

/** The mark in each lane's heading, in the lane's colour. */
const LANE_GLYPH: Record<LaneId, ReactNode> = {
  review: <EyeIcon size={ICON.xs} />, land: <MergeIcon size={ICON.xs} />, blocked: <WarningIcon size={ICON.xs} />,
  others: <ClockIcon size={ICON.xs} />, flight: <EditIcon size={ICON.xs} />,
};

/** How long the lane's pull requests have sat, as the middle one says: "3 h", or days past two of them. */
export function medianAge(rows: readonly PrSummary[], now = Date.now()): string | null {
  const ages = rows.map((p) => now - Date.parse(p.updatedAt)).filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  if (ages.length === 0) return null;
  const mid = ages.length % 2 ? ages[(ages.length - 1) / 2]! : (ages[ages.length / 2 - 1]! + ages[ages.length / 2]!) / 2;
  const h = Math.round(mid / 3_600_000);
  return h >= 48 ? `${Math.round(h / 24)} d` : `${h} h`;
}

function CardView({ p, hasTaskProvider, repoUses, pinned, onOpen, onOpenFull, onPin, notes, onOpenNotes, onAct, onMenu, busy, acting, dim, selected, root, unread, stack, titleOf, factsOf, lit, onLit, onOpenBase, chain, onChain, rail, gutter, lazyCard }: {
  p: Card; hasTaskProvider: boolean;
  /** Ask the tracker for this card only once it has been on screen (a person's board: a hundred cards, one request budget). */
  lazyCard?: boolean;
  /** This repository links work items at all: see prCardBlock.ts. */
  repoUses: boolean;
  pinned: boolean;
  /** The pull request is the viewer's own: their face is not drawn beside the age. */
  /** Unread remarks on this one, or null. See prUnread.ts. */
  unread?: Unread | null;
  /** The pull request whose action is running, so only its card spins. */
  acting?: ReadonlySet<number>;
  /**
   * A find is running and this card is not one of the answers.
   *
   * Quietened, never removed. A card that stops being drawn takes its lane's
   * shape with it and the counts above start disagreeing with what is under
   * them — and the reason you are looking at a board rather than a list is that
   * the shape means something.
   */
  dim?: boolean;
  /** The pull request docked beside the board is this one. */
  selected?: boolean;
  /** Where to ask how far behind this branch is. Absent means do not ask. */
  root?: string;
  /** The stack this pull request is in, or null: see prStack.ts. */
  stack?: Stack | null;
  titleOf?: (n: number) => string | undefined;
  factsOf?: (n: number) => Facts | undefined;
  /** A token that names this card is under the pointer. */
  lit?: boolean;
  onLit?: (n: number | null) => void;
  /** Open the pull request a token names, inside this app. */
  onOpenBase?: (n: number) => void;
  /** The chain a stack chip lights: how this card sits in it. */
  chain?: "on" | "me";
  onChain?: (members: number[] | null, me: number) => void;
  /** The gutter rail this card hangs on, when a stack neighbour sits right below or above it. */
  rail?: RailView | null;
  /** The lane has a rail somewhere: a card with none keeps the same left edge as the ones that hang on it. */
  gutter?: boolean;
  onOpen: () => void; onPin: () => void;
  /** Double-click: the detail takes the whole panel. */
  onOpenFull?: () => void;
  /** What a plugin's review said about this pull request, when one did. */
  notes?: PrNotesSummary; onOpenNotes?: () => void;
  onAct: (p: PrSummary, what: CardAction) => void; busy?: boolean;
  /** The right-click menu, at a point. The card never draws it: one menu serves the board. */
  onMenu: (p: Card, at: { x: number; y: number }) => void;
}) {
  /* Asked for the first time by whoever draws the card, which is the thing that
     knows it is on screen. Null until the answer lands. */
  const fin = finishedKind(p);
  const behind = root && !fin ? behindOf(root, p.number) : null;
  const asking = root && !fin ? askingBehind(root, p.number) : false;
  /* GitHub answers UNKNOWN for a branch it has not looked at lately. The card
     asks git (lib/prConflictStore.ts) and says so meanwhile, rather than file
     itself under "ready to land" over a silence. */
  const cardEl = useRef<HTMLDivElement>(null);
  const [onScreen, setOnScreen] = useState(false);
  const everOn = useRef(false);
  if (onScreen) everOn.current = true;
  useEffect(() => {
    const el = cardEl.current;
    if (!el || typeof IntersectionObserver === "undefined") { setOnScreen(true); return; }
    const io = new IntersectionObserver((es) => { for (const e of es) setOnScreen(e.isIntersecting); });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => { if (root && onScreen && !fin) askConflict(root, p); }, [root, onScreen, fin, p.number, p.mergeable, p.headSha]);
  const checkingMerge = root && !fin ? checkingConflict(root, p) : false;
  const task = taskLink(p, hasTaskProvider);
  const reviewers = cardReviewers(p.humanReview);
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
  const shown: PrSummary["card"] = lazyCard && !everOn.current ? p.card : withCard(p, hasTaskProvider).card;
  const block = trackerBlock({ card: !!shown, hasId: !!task, checksLoaded: p.checksLoaded, repoUses });
  /* What the card shows in each slot is decided in lib/prCardView.ts, where a
     test can reach it; this only draws it. */
  const working = !!acting?.has(p.number);
  const chip = fin ? null : chipFor(notes);
  const leftoverState = useLeftover(root, p);
  const cleaning = useCleaning(root, p.number);
  const cv = cardView({
    p, filed: p.filed, reviewers, behind, asking, checking: checkingMerge, reading: !fin && stillReading(p), leftoverState, cleaning,
    busy: working, tracker: block, hasTaskProvider,
    notes: chip && notes ? totalOpen(notes) : undefined, labels: p.labels.map((l) => l.name),
  });
  const hold = notes && p.filed.lane === "land" ? notReadyChip(notes) : null;
  const notesChip: NotesChipView | null = chip
    ? (hold ? { text: hold.text, tone: "error", title: hold.title } : { text: chip.text, tone: chip.tone, title: chip.title })
    : null;
  const rows = stack ? stackRows(stack, p.number) : [];
  const base = stack?.base;
  const stackView: StackView | null = stack && rows.length > 1 ? {
    rows,
    list: rows.map((row) => ({ row, title: titleOf?.(row.number) ?? `Pull request #${row.number}`, ...rowWord(row, factsOf?.(row.number)) })),
    prev: base?.kind === "pr" ? { number: base.number, branch: base.branch } : null,
    broken: stack.broken === "merged" && base?.kind === "merged" ? `The base #${base.number} is merged and this one still targets its branch.`
      : stack.broken === "closed" && base?.kind === "closed" ? `The base #${base.number} was closed without merging.`
        : stack.broken === "missing" && base?.kind === "missing" ? `The base branch ${base.branch} has no pull request.` : "",
  } : null;
  const hr = p.humanReview as { url?: string } | undefined;
  return (
    <PrCard cardRef={cardEl} p={p} cv={cv} card={shown} task={task} prOpen={p.state === "OPEN"} age={ago(p.updatedAt)}
        stripNote={fin ? closedHeader(p, stamp) : undefined} reviewUrl={hr?.url} notesChip={notesChip}
        eventTip={eventTip({ reason: p.filed.reason, test: p.filed.test, author: p.author, quiet: eventLine(p.filed.reason, p.updatedAt).quiet, at: stamp(p.updatedAt) })}
        unread={unread ? unreadTitle(unread) : null}
        pinned={pinned} working={working} locked={!!busy && !working} dim={dim} selected={selected} lit={lit} chain={chain}
        stack={stackView} rail={rail ?? null} gutter={gutter}
        onChain={(members) => onChain?.(members, p.number)} onOpenPr={(n) => onOpenBase?.(n)} onLit={onLit}
        onOpen={onOpen} onOpenFull={onOpenFull} onOpenNotes={onOpenNotes} onPin={onPin}
        onAct={(what) => onAct(p, what)} onMenu={(at) => onMenu(p, at)} />
  );
}

const ROW_ICON = { pr: PullRequestIcon, draft: DraftIcon, merge: MergeIcon, x: CrossIcon } as const;
const ROW_TONE: Record<ResultRow["tone"], string> = { ok: "var(--success)", merged: "var(--merged, var(--primary))", bad: "var(--error)", quiet: "var(--text3)" };

/**
 * One search or closed-list result as a row (the mockup's `.srow`): a tile for
 * its state, the title, who and when, and the tags that tell it apart. It opens
 * docked on a click and full screen on a double-click, and has the card's menu.
 */
function ResultRowView({ p, view, bare, closed, selected, onOpen, onOpenFull, onMenu, root, onClean }: {
  /** Where the local inventory is asked, and what the row's Clean up does. */ root?: string; onClean?: () => void;
  p: PrSummary; view: ResultRow; /** The closed list: the route sits on the right and the age in the meta line, as the mockup draws it. */ closed?: boolean; /** A person's board: "#12 · wrote", no author and no route (every row is theirs). */ bare?: boolean; selected: boolean;
  onOpen: () => void; onOpenFull: () => void; onMenu: (at: { x: number; y: number }) => void;
}) {
  const Icon = ROW_ICON[view.icon];
  const lane = view.lane ? LANES.find((l) => l.id === view.lane) : null;
  const finished = view.state === "merged" || view.state === "closed";
  /* The Leftovers column: only a row whose inventory found something draws anything (lib/leftovers.ts). */
  const lo = offerFor(useLeftover(finished ? root : undefined, p), "closedRow");
  const route = (
    <span className="agx-pc-route min-w-0" style={{ minHeight: 0 }}>
      <span className="agx-pc-src" title={p.headRefName}><BranchIcon size={ICON.xs} />{p.headRefName}</span>
      <span aria-hidden className="shrink-0" style={{ color: "var(--text4)" }}>→</span>
      <span className="agx-pc-dest" data-trunk={isTrunkBranch(p.baseRefName) ? "1" : undefined} title={`${p.headRefName} → ${p.baseRefName}`}><BranchIcon size={ICON.xs} />{p.baseRefName}</span>
    </span>
  );
  return (
    <div role="listitem" className="contents">
      <div role="button" tabIndex={0} className="agx-srow" data-pr={p.number} data-selected={selected ? "1" : undefined}
        aria-label={view.aria} aria-haspopup="menu" style={{ "--tone": ROW_TONE[view.tone] } as CSSProperties}
        onClick={onOpen}
        onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest("button, a")) onOpenFull(); }}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onMenu({ x: e.clientX, y: e.clientY }); }}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); }
          else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            onMenu({ x: r.left + 24, y: r.top + 24 });
          }
        }}>
        <span aria-hidden className="agx-srow-tile"><Icon size={ICON.xs} /></span>
        <div className="min-w-0">
          <div className="agx-srow-tt" title={p.title}>{p.title}</div>
          <div className="agx-srow-ss">
            <span className="min-w-0 truncate">#{p.number}{bare ? "" : ` · ${p.author}`}{closed && finished ? ` · ${view.state} ${ago(p.updatedAt)} ago` : ""}{bare && view.why ? ` · ${view.why}` : ""}</span>
            {!closed && !bare && route}
            {view.why && !bare && <span className="truncate" title={view.why}>· {view.why}</span>}
          </div>
        </div>
        <span className="flex items-center gap-1.5">
          {closed && !bare && route}
          {view.hiddenBy && (
            <span className="agx-pc-tag" data-tone="warn" title={`This pull request is not on your board: your rule “${view.hiddenBy}” hides it`}>
              <EyeIcon size={ICON.xs} />your rule hides it
            </span>
          )}
          {!closed && (lane ? <span className="agx-pc-tag" style={{ color: lane.tint, borderColor: `color-mix(in srgb, ${lane.tint} 35%, transparent)` }}>{lane.label}</span>
            : !view.hiddenBy ? <span className="agx-pc-tag">{view.state}</span> : null)}
          {lo.button && (
            <>
              <span className="agx-pc-tag" data-leftovers="" title={lo.tooltip} style={{ color: "var(--primary-ink)", borderColor: "color-mix(in srgb, var(--primary) 35%, transparent)" }}>{lo.chip}</span>
              <button type="button" className="agx-cln-ib" data-clean-row="" title={`Clean up local leftovers: ${lo.tooltip}`} aria-label={`Clean up #${p.number}: ${lo.tooltip}`}
                onClick={(e) => { e.stopPropagation(); onClean?.(); }}><SparkleIcon size={ICON.xs} /></button>
            </>
          )}
          {view.approved > 0 && (
            <span className="agx-pc-tag" style={{ color: "var(--success-ink)", borderColor: "color-mix(in srgb, var(--success) 35%, transparent)" }}>
              <DoneIcon size={ICON.xs} />{view.approved} approved
            </span>
          )}
        </span>
        {!closed && <span className="agx-srow-ss" style={{ marginTop: 0 }} title={`Last activity ${ago(p.updatedAt)} ago`}>{ago(p.updatedAt)}</span>}
      </div>
    </div>
  );
}

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


/** An empty answer, as the mockup draws it: a tile, a title, a sentence, three dashed ghost rows when the panel is empty of everything, then the actions. */
export function PrBlank({ icon, title, sentence, tone, ghost, children }: { icon: ReactNode; title: string; sentence: ReactNode; tone?: string; ghost?: boolean; children?: ReactNode }) {
  return (
    <div className="agx-blank h-full">
      <div>
        <span aria-hidden className="agx-blank-tile" style={tone ? { "--tone": tone } as CSSProperties : undefined}>{icon}</span>
        <div className="agx-blank-t">{title}</div>
        <div className="agx-blank-s">{sentence}</div>
        {ghost && <div aria-hidden className="agx-ghostrows"><i /><i /><i /></div>}
        {children && <div className="flex flex-wrap justify-center gap-1.5">{children}</div>}
      </div>
    </div>
  );
}

/**
 * The banner over somebody else's board (the mockup's info banner).
 *
 * The board of a person is rows and not your five lanes, so nothing here can be
 * mistaken for your own queue: this row says whose it is and what it holds, and
 * says that your rules do not apply to it. Follow keeps them one click away
 * from the search box; Back returns to your board. Its own row, nothing is
 * drawn over it or under it.
 */
export function PersonBanner({ login, name, onBack, follow }: { login: string; /** The display name GitHub gave, when it is in hand. */ name?: string; onBack: () => void; follow?: { on: boolean; toggle: () => void } }) {
  return (
    <div role="status" data-person-banner className="agx-banner">
      <Avatar login={login} size={20} />
      <span className="min-w-0"><b>Viewing {login}{name ? ` (${name})` : ""}.</b> Every pull request they wrote or were asked on. Your rules do not apply.</span>
      <span className="flex-1" />
      {follow && (
        <Button size="compact" onClick={follow.toggle} aria-pressed={follow.on} tone={follow.on ? "primary" : undefined}
          title={follow.on ? "Unfollow: remove from People" : "Follow: one click to this board from the search box"}>
          <StarIcon size={ICON.sm} filled={follow.on} />{follow.on ? "Following" : "Follow"}
        </Button>
      )}
      <Button size="compact" onClick={onBack}>Back</Button>
    </div>
  );
}

/** Your hide rules are not applied on somebody else's board, so the entries that write one say why they are off. */
const HIDE_OFF = "Your hide rules do not apply on another person's board";
