/*
 * Pull requests, across every repository at once.
 *
 * ── all of them, then narrowed ───────────────────────────────────────────
 * The screen used to show ONE repository, picked from a sheet behind the
 * title, which meant the question "is anything waiting on me" had to be asked
 * once per repository. It opens on all of them now, grouped under each
 * repository's name, and a row of chips narrows it to one.
 *
 * Capped at the eight most recently touched repositories, and the cap is a
 * real limit stated rather than hidden: each costs a GitHub-backed request per
 * filter, and a machine with thirty would spend a minute of radio to draw a
 * list whose bottom nobody scrolls to. Picking a chip reaches any of them.
 *
 * ── the row ──────────────────────────────────────────────────────────────
 * A card (src/review/PrCard.tsx): whose move it is, what CI thinks, what it is,
 * and the tracker card it belongs to. Whole card is the touch target. The words
 * and choices are decided in model/prCard.ts.
 *
 * ── paging ───────────────────────────────────────────────────────────────
 * A page is twenty rows a repository, and the next one is a button, not a
 * scroll that fires: a list that grows under the thumb loses its place, and each
 * page is a GitHub read the person did not choose to spend.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { useRouter } from "expo-router";
import type { GitRepoRef, PrSummary } from "../../../shared/types.ts";
import { prRepoKey, unreadOf, type Unread } from "../../../shared/prUnread.ts";
import { ask, askCached } from "../../src/lib/api.ts";
import { useAgentglass, PR_READ_TTL_MS } from "../../src/state/host-context.tsx";
import { useReloadOnTick, useTalkTick } from "../../src/state/pr-talk.ts";
import { usePaletteTick } from "../../src/state/use-palette.ts";
import { useSeenMarks } from "../../src/state/read-marks.ts";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Btn, Card, CommandLine, Group, GroupTitle, Note, Row, Segmented, Sheet, Snack, Switch, TAP } from "../../src/ui.tsx";
import { Glyph } from "../../src/nav/glyphs.tsx";
import { InboxBell } from "../../src/nav/InboxBell.tsx";
import { ComputerChip } from "../../src/nav/ComputerChip.tsx";
import { UsageChip } from "../../src/usage/Usage.tsx";
import { PrCard } from "../../src/review/PrCard.tsx";
import { LaneBoard } from "../../src/board/LaneBoard.tsx";
import { CardSkeleton, StateCard } from "../../src/board/BoardState.tsx";
import { PrActiveFilters } from "../../src/review/PrActiveFilters.tsx";
import { PrFilterSheet } from "../../src/review/PrFilterSheet.tsx";
import { PrSearchRow } from "../../src/review/PrSearchRow.tsx";
import { forgetPrCards, usePrCard } from "../../src/state/pr-cards.ts";
import { forgetBehind } from "../../src/state/pr-behind.ts";
import { useJiraReach } from "../../src/state/use-jira-reach.ts";
import { useTracksWork } from "../../src/state/use-tracks-work.ts";
import { allCount } from "../../src/model/prCard.ts";
import { mainCheckouts } from "../../src/model/prRows.ts";
import { sumPrCounts, type PrViewCounts } from "../../src/model/prCounts.ts";
import { byState, stateQuery, STATE_LABEL, type StateView } from "../../src/model/prState.ts";
import {
  activeChips, effectiveState, matchesFilters, NO_FILTERS, removeChip, withoutCard, type PrFilters,
} from "../../src/model/prFilters.ts";
import { listPath as prListPath, withLocalMatches } from "../../src/model/prSearch.ts";
import { flatten, type RepoGroup } from "../../src/model/prLook.ts";
import {
  boardRows, inView, laneBoard, viewChips, viewHiddenCount, HIDE_BY_RULES,
  type BoardData, type BoardLane, type LaneRules,
} from "../../src/model/prBoard.ts";
import { usePrViews, loadViews, saveNewView } from "../../src/state/pr-views.ts";
import { SaveViewSheet } from "../../src/review/SaveViewSheet.tsx";
import type { PrView } from "../../../shared/prFilter.ts";
import { mergeFresh, nextPageCount } from "../../src/model/prPaging.ts";
import { keepLoadedChecks } from "../../../shared/prMerge.ts";
import { writeBlocked } from "../../src/model/prManage.ts";
import type { SyncTarget } from "../../src/model/prSync.ts";
import { SyncSheet } from "../../src/review/SyncSheet.tsx";
import { PrActionsSheet } from "../../src/review/PrActionsSheet.tsx";
import { WatchRuleSheet } from "../../src/inbox/WatchRuleSheet.tsx";
import { repoOf } from "../../src/model/prRef.ts";
import { rerunSaid } from "../../src/model/prActions.ts";
import type { Suggested } from "../../../shared/prLanes.ts";
import type { Host } from "../../src/lib/host.ts";
import { C, RADIUS, SPACE, T, tint } from "../../src/theme.ts";
import { ComputerGone } from "../../src/nav/ComputerGone.tsx";

type Filter = "mine" | "review" | "all";
/** How the tab draws the one repository it is looking at: the board, or rows. */
type Mode = "board" | "list";

/** "review" first is deliberate: somebody is blocked on you in that one. */
const FILTERS: Filter[] = ["review", "mine", "all"];
const FILTER_LABEL: Record<Filter, string> = {
  review: "Review",
  mine: "Mine",
  all: "All",
};

/** How many repositories "All repos" asks. See the note at the top. */
const REPO_CAP = 8;
const ALL = "*";

/** How long typing pauses before the words go to the server. */
const SEARCH_DEBOUNCE_MS = 400;

/** What `/prs/list` answers with.
 *
 *  Declared here rather than imported because the server's copy lives in
 *  `server/src/prs.ts` and not in `shared/types.ts` — this app compiles
 *  against the shared wire types and nothing else. */
interface PrList {
  ok: boolean;
  error?: string;
  prs: PrSummary[];
  /** `owner/name`, which is the key the server's view store is filed under.
   *  Absent for a checkout GitHub does not know. */
  repo?: { nameWithOwner?: string };
  needsAuth?: boolean;
  loading?: boolean;
  total?: number;
  hasNext?: boolean;
  cursor?: string | null;
  pageSize?: number;
}

/** A repository's rows, and where its next page starts. */
interface PrGroup extends RepoGroup<PrSummary> { total?: number; hasNext?: boolean; cursor?: string | null; pageSize?: number }

/** What the button says when the server did not say a page size. */
const PAGE_DEFAULT = 20;


// PrViewCounts and how repositories' counts add up live in
// src/model/prCounts.ts — the one field this screen reads is named after a
// filter, which is what keeps the two in step: a rename on either side stops
// matching `FILTERS`.

/** One row: its card line is looked up here so each row asks for its own. */
function Item({ host, pr, tracked, now, forMe, unread, query, onOpen }: {
  host: Host;
  pr: PrSummary;
  tracked: boolean | null;
  now: number;
  forMe: boolean;
  /** Something said on it since this person last looked — see shared/prUnread.ts. */
  unread: Unread | null;
  query: string;
  onOpen: () => void;
}): React.ReactNode {
  // A key the connected Jira site listed is its card, not a ClickUp one.
  const jira = useJiraReach(host);
  const { state, find } = usePrCard(host, pr, tracked, jira);
  return <PrCard pr={pr} now={now} forMe={forMe} unread={unread} card={state} query={query} onFind={find} onOpen={onOpen} />;
}

/** The screen, behind the card that says so when its computer is gone. */
export default function PrsScreen(): React.ReactNode {
  return <ComputerGone><PrsScreenBody /></ComputerGone>;
}

/**
 * One press in the PR board's own header (mock 28): 44 points, no border, a
 * count on the corner when the control has something to report.
 */
function HeadIcon({ label, onPress, badge, children }: {
  label: string;
  onPress: () => void;
  /** What the control is keeping from the screen, when it is anything. */
  badge?: number;
  children: React.ReactNode;
}): React.ReactNode {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={badge ? `${label}, ${badge} hidden` : label}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => ({
        width: 44, height: 44, alignItems: "center", justifyContent: "center",
        borderRadius: 12, backgroundColor: pressed ? C.bg3 : "transparent",
        transform: [{ scale: pressed ? 0.97 : 1 }],
      })}
    >
      {children}
      {badge ? (
        <View style={{
          position: "absolute", top: 5, right: 5, minWidth: 15, height: 15, borderRadius: 8,
          paddingHorizontal: 3, alignItems: "center", justifyContent: "center", backgroundColor: C.primary,
        }}>
          <Text style={{ color: C.bg, fontSize: 9.5, fontWeight: "700", lineHeight: 12 }}>{badge > 9 ? "9+" : badge}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

function PrsScreenBody(): React.ReactNode {
  usePaletteTick(); // a scene repaints only if it asks — see use-palette.ts
  const { host } = useAgentglass();
  const router = useRouter();
  const [repos, setRepos] = useState<GitRepoRef[] | null>(null);
  /** A repository's root, or ALL. */
  const [pick, setPick] = useState<string>(ALL);
  /** Whether a repository was chosen for the person yet: the tab lands on the
   *  most recent one's board, as the mock does, and never bounces a later
   *  "All repositories" back to it. */
  const pickedOnce = useRef(false);
  /** The board is one repository; "All repositories" keeps the grouped list. */
  const [mode, setMode] = useState<Mode>("board");
  useEffect(() => { if (pick === ALL) setMode("list"); }, [pick]);
  /** Which sentences are the person's own rules, and the drawers they fill. */
  const [rules, setRules] = useState<LaneRules>(HIDE_BY_RULES);
  /** Everyone's pull requests, or only the ones that are yours to act on —
   *  the mock's switch (30). Off is the desk's answer: its two queues. */
  const [everyone, setEveryone] = useState(false);
  /** The board's repository as GitHub spells it, which is the key the server's
   *  saved views are filed under. Null until a list answer carries it. */
  const [repoSlug, setRepoSlug] = useState<string | null>(null);
  /** The views the server holds for it, and which one this phone is on. */
  const {
    views: savedViews, active: activeView, condition: viewsCondition, activeMissing,
    setActive: setActiveView, retry: retryViews,
  } = usePrViews(host, repoSlug);
  /** The lane whose branches are being synced, as N single syncs. */
  const [laneSync, setLaneSync] = useState<BoardLane | null>(null);
  const blocked = host ? writeBlocked(host.scope) : null;
  const [filter, setFilter] = useState<Filter>("review");
  /** What the sheet narrows by. Its state is Open unless asked — the list
   *  answers "what is waiting", and a closed pull request is a thing you go
   *  looking for — and Any while searching. */
  const [filters, setFilters] = useState<PrFilters>(NO_FILTERS);
  const [sheet, setSheet] = useState(false);
  /** Which repository the board is for, and the menu that is not a screen. */
  const [repoSheet, setRepoSheet] = useState(false);
  const [moreSheet, setMoreSheet] = useState(false);
  const [saveSheet, setSaveSheet] = useState(false);
  const [text, setText] = useState("");
  /** Whether the field is open. The board is read far more often than
   *  searched, so the field is not a row the cards pay for. */
  const [searchOpen, setSearchOpen] = useState(false);
  /** What was typed, once typing paused: the words the server is asked. */
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);
  const searching = query.length > 0;
  /** The repository a board would draw, or null while "All repositories" is
   *  picked — a board over eight repositories is sixteen requests. */
  const boardRepo = pick === ALL ? null : (repos ?? []).find((r) => r.root === pick) ?? null;
  const showingBoard = mode === "board" && boardRepo !== null && !searching;
  /** The state the tab's own list is read in, and the state shown: a search
   *  looks at every state unless one was chosen. */
  const browseView = effectiveState(filters, false);
  const view = effectiveState(filters, searching);
  const [groups, setGroups] = useState<PrGroup[] | null>(null);
  /** The lists the board files from, for the one repository it draws. `all`
   *  is absent until the switch asks for it. */
  const [boardData, setBoardData] = useState<BoardData | null>(null);
  const [boardLoading, setBoardLoading] = useState(false);
  /** The server answered the board with its fast pass: one re-read a moment
   *  later is the second. The list has had this since it was written; without
   *  it a board read that landed first-pass stayed first-pass. */
  const [boardReading, setBoardReading] = useState(false);
  const [boardFailed, setBoardFailed] = useState<{ error: string; needsAuth: boolean } | null>(null);
  const [more, setMore] = useState(false);
  /** Why the last "Load more" brought nothing, when it failed. */
  const [moreError, setMoreError] = useState<string | null>(null);
  /** The "All" tab's number — the server sends none, see allCount. */
  const [allKnown, setAllKnown] = useState<number | null>(null);
  const tracked = useTracksWork(host);
  /** What the connected Jira site lists as its keys, so a branch naming one is
   *  read as a Jira card by the board's cards as well as the list's rows. */
  const jira = useJiraReach(host);
  const [failed, setFailed] = useState<{ error: string; needsAuth: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  /**
   * The numbers behind the segmented control, summed over what is shown.
   *
   * `/prs/counts` answers all of them in ONE GraphQL call per repository and
   * caches it, which is the whole reason the control can carry counts at all.
   * Null while it has not answered, and the control simply draws no numbers —
   * a zero on "Review" that means "we have not asked" is the kind of lie this
   * app spends comments avoiding elsewhere.
   */
  const [counts, setCounts] = useState<PrViewCounts | null>(null);
  const [pulling, setPulling] = useState(false);
  /* The marks the server holds, moved live by the desk and by this phone. The
     rows are not re-read when one changes: the badge is a function of the row's
     talk and the mark, so it repaints from here. */
  const seenMarks = useSeenMarks();

  useEffect(() => {
    if (!host) return;
    void (async () => {
      const answer = await askCached<{ repos: GitRepoRef[] }>(host, "/git/repos", PR_READ_TTL_MS);
      if (!answer.ok) { setFailed({ error: answer.error, needsAuth: false }); return; }
      /*
       * One entry per REPOSITORY, not per checkout.
       *
       * Measured against a real machine: 23 checkouts, six of them linked
       * worktrees of one repository, each answering with the same 19 pull
       * requests. Six identical-looking chips showing identical lists are not
       * a choice — they are the same answer six times.
       *
       * `mainCheckouts` is the browser companion's, already tested: it drops a
       * worktree whose main checkout is present and KEEPS one whose main
       * checkout is not, because that repository's pull requests have to come
       * from somewhere. Most recently touched first is what `/git/repos`
       * already answers with.
       */
      const list = mainCheckouts(Array.isArray(answer.value.repos) ? answer.value.repos : []);
      setRepos(list);
      if (!pickedOnce.current && list.length) {
        pickedOnce.current = true;
        setPick(list[0]!.root);
        setMode("board");
      }
    })();
  }, [host]);

  const shown = useMemo(
    () => (repos ?? []).filter((r) => pick === ALL || r.root === pick).slice(0, pick === ALL ? REPO_CAP : 1),
    [repos, pick],
  );

  /* Which read is the latest. A tap on a chip or a filter starts a new read
     while the last one may still be out, and eight repositories answer in
     whatever order GitHub does: without this, a slow answer to the filter you
     left could land after the one you are on and paint the wrong list. */
  const asked = useRef(0);
  /** One place spells the question, first page or a later one; model/prSearch.ts
   *  is where a search stops being the tab's list. */
  const listPath = useCallback((root: string, after?: string): string =>
    prListPath({ root, tab: filter, state: view, text: query, after }),
    [filter, view, query]);
  /* `force`: something changed (a refresh, a live tick, the server still
     * loading), so ask the computer. Opening the tab or moving a filter reads
     * what the queue's own pass just read, which is the same URLs. */
  const load = useCallback(async (force = false): Promise<void> => {
    if (!host || !shown.length || showingBoard) return;
    const mine = ++asked.current;
    const answers = await Promise.all(shown.map(async (repo) => {
      const [answer, browsed] = await Promise.all([
        askCached<PrList>(host, listPath(repo.root), PR_READ_TTL_MS, force),
        /* What a search cannot see in GitHub's own text — number, author, branch —
           is matched on the tab's own list, which is the read the screen made
           before a word was typed, so it is almost always in the cache. */
        query
          ? askCached<PrList>(host, prListPath({ root: repo.root, tab: filter, state: browseView, text: "" }), PR_READ_TTL_MS, force)
          : null,
      ]);
      return { repo, answer, browsed };
    }));
    if (mine !== asked.current) return;
    const good = answers.filter((a) => a.answer.ok && a.answer.value.ok);
    // Said only when NOTHING answered: one repository without a GitHub remote
    // among eight is not a reason to hide the other seven.
    if (!good.length) {
      const first = answers[0]?.answer;
      setFailed({
        error: first && !first.ok ? first.error : (first?.ok && first.value.error) || "GitHub did not answer",
        needsAuth: answers.some((a) => a.answer.ok && a.answer.value.needsAuth),
      });
      setGroups(null);
      return;
    }
    setFailed(null);
    setLoading(good.some((a) => a.answer.ok && a.answer.value.loading));
    // A refresh keeps the pages "Load more" appended (see model/prPaging.ts).
    setGroups((was) => mergeFresh<PrSummary, PrGroup>(was, good.map(({ repo, answer, browsed }) => ({
      root: repo.root,
      name: repo.name,
      items: withLocalMatches(
        answer.ok && Array.isArray(answer.value.prs) ? answer.value.prs : [],
        browsed?.ok && Array.isArray(browsed.value.prs) ? browsed.value.prs : [],
        query,
      ),
      total: answer.ok ? answer.value.total : undefined,
      hasNext: answer.ok ? !!answer.value.hasNext : false,
      cursor: answer.ok ? answer.value.cursor : null,
      pageSize: answer.ok ? answer.value.pageSize : undefined,
    }))));
  }, [host, shown, filter, view, browseView, query, listPath, showingBoard]);

  /*
   * The board's own read: both scopes for its one repository, so the stake is
   * membership in lists the phone already asks for, plus the repository's whole
   * list only while the person has everyone's on. The list's `filter` is not
   * used here — a board shows the five lanes at once, and asking only "review"
   * would file every card as somebody else's.
   */
  const boardAsked = useRef(0);
  const loadBoard = useCallback(async (force = false): Promise<void> => {
    if (!host || !boardRepo || !showingBoard) return;
    const mine = ++boardAsked.current;
    setBoardLoading(true);
    const [askedMine, askedReview, askedAll] = await Promise.all([
      askCached<PrList>(host, prListPath({ root: boardRepo.root, tab: "mine", state: browseView, text: "" }), PR_READ_TTL_MS, force),
      askCached<PrList>(host, prListPath({ root: boardRepo.root, tab: "review", state: browseView, text: "" }), PR_READ_TTL_MS, force),
      everyone
        ? askCached<PrList>(host, prListPath({ root: boardRepo.root, tab: "all", state: browseView, text: "" }), PR_READ_TTL_MS, force)
        : null,
    ]);
    if (mine !== boardAsked.current) return;
    const failure = (a: typeof askedMine): { error: string; needsAuth: boolean } | null => {
      if (!a.ok) return { error: a.error, needsAuth: false };
      if (a.value.ok) return null;
      return { error: a.value.error ?? "GitHub did not answer", needsAuth: !!a.value.needsAuth };
    };
    const bad = failure(askedMine) ?? failure(askedReview) ?? (askedAll ? failure(askedAll) : null);
    if (bad) {
      setBoardFailed(bad);
      setBoardData(null);
      setBoardLoading(false);
      return;
    }
    const rowsOf = (a: typeof askedMine): PrSummary[] =>
      a && a.ok && a.value.ok && Array.isArray(a.value.prs) ? a.value.prs : [];
    setBoardFailed(null);
    /* The list answer names the repository the way GitHub does; the views are
       filed under that, not under the checkout's directory name. */
    if (askedMine.ok && askedMine.value.ok) setRepoSlug(askedMine.value.repo?.nameWithOwner ?? null);
    /* A refresh may add and it may correct, but it may not un-know: the second
       pass the cards already had (checks, size, review, merge state, the
       tracker card) survives the fast pass every read starts with. Same carry
       as the list's — see shared/prMerge.ts — on all three lists the lanes are
       filed from. */
    setBoardData((was) => ({
      mine: keepLoadedChecks(was?.mine ?? [], rowsOf(askedMine)),
      review: keepLoadedChecks(was?.review ?? [], rowsOf(askedReview)),
      all: askedAll ? keepLoadedChecks(was?.all ?? [], rowsOf(askedAll)) : [],
    }));
    setBoardReading([askedMine, askedReview, askedAll].some((a) => !!a && a.ok && a.value.ok && a.value.loading));
    setBoardLoading(false);
  }, [host, boardRepo, showingBoard, browseView, everyone]);

  useEffect(() => {
    setBoardFailed(null);
    setBoardData(null);
    setBoardReading(false);
    if (showingBoard) void loadBoard();
  }, [loadBoard, showingBoard]);

  /* A different repository is a different list of views; the slug is refilled by
     the board's next answer. */
  useEffect(() => { setRepoSlug(null); }, [boardRepo?.root]);

  /* Focus is the event: coming back to the app (or opening the sheet that shows
     the views) reads the desk's file again, so a view saved or edited there is
     the one this board narrows by. No poll: nothing is asked while it sits still. */
  useEffect(() => {
    if (!host || !repoSlug) return;
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") void loadViews(host, repoSlug, true);
    });
    return () => sub.remove();
  }, [host, repoSlug]);
  useEffect(() => {
    if (sheet && host && repoSlug) void loadViews(host, repoSlug, true);
  }, [sheet, host, repoSlug]);

  useEffect(() => { setGroups(null); setMoreError(null); void load(); }, [load]);

  /* The next page of every repository that has one, appended. Same guard as
     `load`: a read started after this one (a new filter, a refresh) makes these
     rows belong to a list that is gone. */
  const loadMore = useCallback(async (): Promise<void> => {
    if (!host || !groups) return;
    const mine = asked.current;
    setMore(true);
    let failure: string | null = null;
    const next = await Promise.all(groups.map(async (g) => {
      if (!g.hasNext || !g.cursor) return g;
      const a = await ask<PrList>(host, listPath(g.root, g.cursor));
      if (!a.ok || !a.value.ok) {
        failure ??= a.ok ? a.value.error ?? "GitHub did not answer" : a.error;
        return g;
      }
      // The same pull request can move between pages while it is read.
      const have = new Set(g.items.map((p) => p.number));
      return {
        ...g,
        items: [...g.items, ...(Array.isArray(a.value.prs) ? a.value.prs : []).filter((p) => !have.has(p.number))],
        total: a.value.total ?? g.total, hasNext: !!a.value.hasNext, cursor: a.value.cursor ?? null,
      };
    }));
    if (mine === asked.current) { setGroups(next); setMoreError(failure); }
    setMore(false);
  }, [host, groups, listPath]);

  // A live comment or review landed on one of these pull requests.
  const loadFresh = useCallback(() => load(true), [load]);
  useReloadOnTick(useTalkTick(), loadFresh);
  // A talk tick on the board is the same news as on the list, and the board is
  // the screen that is actually open while its lanes are drawn.
  const boardFresh = useCallback(() => { void loadBoard(true); }, [loadBoard]);
  useReloadOnTick(useTalkTick(), boardFresh);

  /* Which count read is the latest — same reason `asked` guards `load`: a
   *  pull-to-refresh and a live tick can both ask this while a slower answer
   *  to an older ask is still out. */
  const countsAsked = useRef(0);
  const loadCounts = useCallback(async (): Promise<void> => {
    if (!host || !shown.length || browseView === "merged") return;
    const mine = ++countsAsked.current;
    const answers = await Promise.all(shown.map((r) =>
      ask<{ ok: boolean; counts?: PrViewCounts }>(host, `/prs/counts?root=${encodeURIComponent(r.root)}&state=${stateQuery(browseView)}`)));
    if (mine !== countsAsked.current) return;
    const got = answers.flatMap((a) => (a.ok && a.value.ok && a.value.counts ? [a.value.counts] : []));
    const sum = sumPrCounts(got);
    if (sum) setCounts(sum);
  }, [host, shown, browseView]);

  // Counts follow what is shown and not the filter — a new repo set or state
  // split really is a different question, so the row goes quiet while the
  // new numbers are asked. "Review 0 · Mine 0 · All 0" was one of those
  // asked once, for THIS reason, and then never again: a pull-to-refresh or
  // a live tick changes what a filter counts (a new review request, a check
  // going red) without host/shown/view moving, so this effect never re-fires
  // for either — the list refetched on both and the header did not.
  useEffect(() => {
    if (!host || !shown.length) return;
    setCounts(null);
    void loadCounts();
  }, [host, shown, browseView, loadCounts]);

  // The same signals `load` re-reads the list on. Re-asks the SAME question,
  // so it must not flash to null while it waits — the numbers on screen are
  // still true until told otherwise, and a background refresh that blanked
  // them for a second was worse than the stale ones it was fixing.
  useReloadOnTick(useTalkTick(), loadCounts);

  useEffect(() => { setAllKnown(null); }, [shown, browseView]);
  // A search's rows are not the tab's, so they are not its count.
  useEffect(() => { if (filter === "all" && groups && !searching) setAllKnown(allCount(groups)); }, [filter, groups, searching]);

  // The check rollup lands on a second pass, so one re-read a moment later is
  // the difference between "checks…" forever and the row settling.
  useEffect(() => {
    if (!loading) return;
    const timer = setTimeout(() => { void load(true); }, 2500);
    return () => clearTimeout(timer);
  }, [loading, load]);

  // The same for the board, whose own read is `loadBoard`: the list's effect
  // above returns early on it, so without this a first-pass board stayed that
  // way until the next talk tick or another pull.
  useEffect(() => {
    if (!boardReading) return;
    const timer = setTimeout(() => { void loadBoard(true); }, 2500);
    return () => clearTimeout(timer);
  }, [boardReading, loadBoard]);

  const onRefresh = useCallback((): void => {
    setPulling(true);
    forgetPrCards(host);
    // "Ask again for what is in front of me" reaches the compares too: a branch
    // somebody just synced must not keep claiming to be behind for five minutes.
    forgetBehind(host);
    // The views are the server's file, so the pull re-reads them as well.
    if (host && repoSlug) void loadViews(host, repoSlug, true);
    void loadCounts();
    // Both reads are the pull's. `load` is the one whose promise the spinner
    // follows (it is the list's, and the board's own `boardLoading` covers its
    // half), so a pull on either screen re-reads the other.
    void load(true).finally(() => setPulling(false));
    void loadBoard(true);
  }, [host, load, loadBoard, loadCounts, repoSlug]);

  /* The state split and the sheet's filters are applied here, on what the
     server sent, so narrowing never asks GitHub anything. A repository with
     nothing left loses its heading rather than showing an empty one. */
  const inState = useMemo(() => (groups ?? []).map((g) => ({ ...g, items: byState(g.items, view) })), [groups, view]);
  const narrowed = useMemo(() => inState.map((g) => ({
    ...g, items: g.items.filter((p) => matchesFilters(p, filters)),
  })).filter((g) => g.items.length), [inState, filters]);
  const rows = useMemo(() => flatten(narrowed), [narrowed]);
  const loadedRows = useMemo(() => (groups ?? []).flatMap((g) => g.items), [groups]);
  const activeFilters = useMemo(() => activeChips(filters, (s) => STATE_LABEL[s]), [filters]);
  const shownRows = rows.filter((r) => !("heading" in r)).length;
  const inStateRows = inState.reduce((n, g) => n + g.items.length, 0);
  /* What a card filter leaves out: the rows with no card that every OTHER
     facet would keep. Zero unless a card filter is on without "No card". */
  const hiddenNoCard = useMemo(() => (
    filters.cardStatus.length && !filters.noCard
      ? withoutCard(inState.flatMap((g) => g.items).filter((p) => matchesFilters(p, { ...filters, noCard: true })))
      : 0
  ), [inState, filters]);
  /** "No merged pull request…" / "No pull request…" */
  const kind = view === "all" ? "" : `${view} `;
  const hasMore = (groups ?? []).some((g) => g.hasNext);
  const pageSize = (groups ?? []).find((g) => g.pageSize)?.pageSize ?? PAGE_DEFAULT;
  const now = Date.now();

  /*
   * The board is computed from what the filters left (`boardVisible`) while
   * the stake is read from the two unfiltered lists: a filter that hides the
   * `mine` copy of a pull request must not turn its author into a stranger.
   */
  const boardAll = useMemo(() => (boardData ? boardRows(boardData, everyone) : []), [boardData, everyone]);
  /* The desk's exemption, read from the row's own GitHub key: a pull request
     with something unread on it is never dropped by a saved view.
     Limit until `/marks` answers: `seenMarks` is empty on a cold start, so for
     the moments between the board's read and the marks' landing this phone
     drops a row the desk keeps. `seenMarks` is a dependency, so the board
     re-evaluates and the row comes back; there is no poll and no second read. */
  const isViewExempt = useCallback(
    (p: PrSummary) => !!unreadOf(p, prRepoKey(p), seenMarks),
    [seenMarks],
  );
  /* What the phone's own facets leave, before the view: both the board and the
     "N hidden by this view" note read this one list, so the note counts rows
     the board was going to draw. */
  const boardNarrowed = useMemo(
    () => byState(boardAll, view).filter((p) => matchesFilters(p, filters)),
    [boardAll, view, filters],
  );
  const boardVisible = useMemo(() => {
    /* The view is the server's saved rules over the same rows the desk narrows;
       the facets above are this phone's own and stay on top of it. */
    return activeView ? inView(boardNarrowed, activeView, { exempt: isViewExempt }) : boardNarrowed;
  }, [boardNarrowed, activeView, isViewExempt]);
  const lanes = useMemo(
    () => (boardData ? laneBoard(boardData, boardVisible, rules) : []),
    [boardData, boardVisible, rules],
  );
  const viewRow = useMemo(
    () => viewChips(boardAll, savedViews, { exempt: isViewExempt }),
    [boardAll, savedViews, isViewExempt],
  );
  const hiddenByView = useMemo(
    () => (activeView ? viewHiddenCount(boardNarrowed, activeView, { exempt: isViewExempt }) : 0),
    [boardNarrowed, activeView, isViewExempt],
  );
  /** Picking the chip that is already on takes it off again: with no view there
   *  is nothing to remove, so the lit chip is the only way back to the whole board. */
  const applyView = useCallback((next: PrView): void => {
    setActiveView(activeView?.id === next.id ? null : next.id);
  }, [activeView, setActiveView]);
  const editFilters = useCallback((next: PrFilters): void => {
    setFilters(next);
  }, []);
  /* The lane's drawn cards, no more: past LANE_CAP the sheet cannot reach the
     rest, and saying "all of them" over twenty of twenty-four would be false.
     A board is one repository, but not necessarily one base — "the base" when
     the lane mixes targets. */
  const laneBase = useMemo(() => {
    const bases = new Set((laneSync?.cards ?? []).map((c) => c.pr.baseRefName));
    return bases.size === 1 ? [...bases][0]! : "the base";
  }, [laneSync]);
  const laneTargets = useMemo<SyncTarget[]>(
    () => (laneSync?.cards ?? []).map((c) => ({
      number: c.pr.number,
      head: c.pr.headRefName,
      conflict: c.pr.mergeable === "CONFLICTING",
    })),
    [laneSync],
  );

  const openOnBoard = useCallback((pr: PrSummary): void => {
    if (!boardRepo) return;
    router.push({ pathname: "/pr/[number]", params: { number: String(pr.number), root: boardRepo.root } });
  }, [boardRepo, router]);

  /* ── what a card can do without being opened (mock 62) ─────────────────── */
  /** The card whose actions sheet is up. */
  const [acting, setActing] = useState<PrSummary | null>(null);
  /** A re-run's own line, over the board for a moment. */
  const [said, setSaid] = useState<string | null>(null);
  /** One card's branch, for the sync sheet the actions sheet hands to. */
  const [singleSync, setSingleSync] = useState<PrSummary | null>(null);
  /** One card's "Tell me when…", through the sheet the inbox and the pull request use. */
  const [watchFor, setWatchFor] = useState<PrSummary | null>(null);
  useEffect(() => {
    if (!said) return;
    const timer = setTimeout(() => setSaid(null), 2600);
    return () => clearTimeout(timer);
  }, [said]);

  /**
   * The card's footer press, with what its lane implies.
   *
   * A re-run is done HERE rather than one screen deeper: the lane's press says
   * "Rerun", and taking somebody to a pull request so they can press the same
   * word again is the round trip the mock removes. Merge still opens the
   * request with its merge sheet up, because the method, the arm and the hold
   * all live there — and it is the one write that must not be a bare tap.
   */
  const cardAction = useCallback(async (pr: PrSummary, action: Suggested): Promise<void> => {
    if (action === "open") { openOnBoard(pr); return; }
    if (!boardRepo) return;
    if (action === "merge") {
      router.push({
        pathname: "/pr/[number]",
        params: { number: String(pr.number), root: boardRepo.root, merge: "1" },
      });
      return;
    }
    if (!host) return;
    const answer = await ask<{ ok: boolean; detail?: string; error?: string }>(host, "/prs/rerun", {
      method: "POST",
      body: { root: boardRepo.root, number: pr.number },
    });
    setSaid(answer.ok
      ? rerunSaid(answer.value.ok, answer.value.ok ? answer.value.detail : answer.value.error)
      : rerunSaid(false, answer.error));
    if (answer.ok && answer.value.ok) void loadBoard(true);
  }, [boardRepo, host, openOnBoard, router, loadBoard]);

  if (!host) return null;

  const repoName = pick === ALL ? "all repositories" : (repos ?? []).find((r) => r.root === pick)?.name ?? "this repository";
  /** The repositories' contributors, for the sheet's people list. */
  const moreAuthors = async (): Promise<string[]> => {
    const answers = await Promise.all(shown.map((r) =>
      ask<{ ok: boolean; data?: { authors?: string[] } }>(host, `/prs/facets?root=${encodeURIComponent(r.root)}`)));
    return [...new Set(answers.flatMap((a) => (a.ok && a.value.ok ? a.value.data?.authors ?? [] : [])))];
  };

  const insets = useSafeAreaInsets();
  /** What the rules took out of the lanes: the filter button's count. */
  const hiddenByRules = lanes.reduce((n, l) => n + l.hidden.length, 0);

  const chips = [
    { id: ALL, label: "All repos" },
    ...(repos ?? []).map((r) => ({ id: r.root, label: r.name })),
  ];

  const filterTabs = (
    <Segmented
      value={filter}
      onChange={setFilter}
      options={FILTERS.map((id) => ({
        id,
        label: FILTER_LABEL[id],
        count: id === "all" ? allKnown ?? undefined : counts?.[id],
      }))}
    />
  );

  return (
    <View style={{ flex: 1, backgroundColor: C.bg, paddingTop: insets.top }}>
      {/*
        ONE row of chrome, and it is the mock's (screen 28): the repository,
        the search, the filter with the count of what the rules took out, the
        Inbox and the menu. The navigator's header is off for this screen (see
        app/(tabs)/_layout.tsx) because "Pull requests" is what the bar already
        says, and the computer's name — the one thing that header was for — is
        a row of the menu, beside the usage.
      */}
      <View style={{
        height: 52, flexDirection: "row", alignItems: "center", gap: 2,
        paddingHorizontal: SPACE.sm, borderBottomWidth: 1, borderBottomColor: C.border,
      }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Repository: ${repoName}. Change it`}
          onPress={() => setRepoSheet(true)}
          style={({ pressed }) => ({
            minHeight: TAP, maxWidth: 190, flexDirection: "row", alignItems: "center", gap: SPACE.sm,
            paddingHorizontal: 2, borderRadius: 10, opacity: pressed ? 0.7 : 1,
          })}
        >
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: C.primary }} />
          <Text numberOfLines={1} style={{ color: C.text, fontSize: 15, fontWeight: "600", letterSpacing: -0.2, flexShrink: 1 }}>
            {pick === ALL ? "All repos" : repoName}
          </Text>
          <Glyph name="down" color={C.text3} size={16} />
        </Pressable>
        <View style={{ flex: 1 }} />
        <HeadIcon label="Search the pull requests" onPress={() => setSearchOpen(true)}>
          <Glyph name="search" color={C.text2} size={20} />
        </HeadIcon>
        <HeadIcon
          label="Filters and rules"
          badge={hiddenByRules || undefined}
          onPress={() => setSheet(true)}
        >
          <Glyph name="filter" color={C.text2} size={20} />
        </HeadIcon>
        <InboxBell />
        <HeadIcon label="More: save this view, usage, settings" onPress={() => setMoreSheet(true)}>
          <Glyph name="more" color={C.text2} size={20} />
        </HeadIcon>
      </View>

      {searchOpen || searching ? (
        <View style={{ paddingHorizontal: SPACE.lg, paddingTop: SPACE.xs }}>
          <PrSearchRow
            value={text}
            onChange={setText}
            active={activeFilters.length}
            onFilters={() => setSheet(true)}
            onClose={() => { setSearchOpen(false); setText(""); }}
          />
        </View>
      ) : null}
        {/* A search leaves the tabs: it looks through the whole repository, and
            a tab still lit above a list that ignores it would say otherwise. */}
      {searching ? (
        <View style={{ minHeight: TAP, justifyContent: "center", paddingHorizontal: SPACE.lg }}>
          <Note>
            Searching all of {repoName} · title, description, #number, author, branch ·{" "}
            {groups === null ? "…" : `${shownRows}${hasMore ? "+" : ""} result${shownRows === 1 && !hasMore ? "" : "s"}`}
          </Note>
        </View>
      ) : null}
      {/* The board is the default; a list of every repository has no lane to
          file into, so its own tabs come back for it (and for the list the
          menu offers). */}
      {!searching && mode === "list" && pick !== ALL ? (
        <View style={{ paddingHorizontal: SPACE.lg, paddingTop: SPACE.xs }}>{filterTabs}</View>
      ) : null}
      <PrActiveFilters
        chips={activeFilters}
        onRemove={(id) => editFilters(removeChip(filters, id))}
        onClear={() => editFilters(NO_FILTERS)}
        shown={showingBoard ? boardVisible.length : shownRows}
        total={showingBoard ? boardAll.length : inStateRows}
        more={showingBoard ? false : hasMore}
        hidden={showingBoard ? 0 : hiddenNoCard}
        onShowHidden={() => editFilters({ ...filters, noCard: true })}
      />
      {/* Whose the lanes are: the desk's two queues until this is turned on.
          The row is the target, so the switch needs no padding of its own, and
          the words are the same value the filter sheet's switch writes. */}
      {showingBoard ? (
        <Pressable
          accessibilityRole="switch"
          accessibilityState={{ checked: everyone }}
          accessibilityLabel="Show everyone’s pull requests"
          onPress={() => setEveryone((v) => !v)}
          style={({ pressed }) => ({
            minHeight: TAP, flexDirection: "row", alignItems: "center", gap: SPACE.sm,
            paddingHorizontal: SPACE.lg, borderBottomWidth: 1, borderBottomColor: C.border,
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <Text numberOfLines={1} style={{ flex: 1, color: C.text2, fontSize: T.small }}>
            {everyone ? "Everyone’s pull requests" : "Mine and my review requests"}
          </Text>
          <Switch on={everyone} />
        </Pressable>
      ) : null}
      {showingBoard && activeMissing ? (
        <View style={{ paddingHorizontal: SPACE.lg, paddingTop: SPACE.xs }}>
          <Note>The view this phone had on is no longer saved on the desk; the board is not narrowed by it.</Note>
        </View>
      ) : null}
      {/* The repository, from the header's own button: a list rather than a
          row of chips, because the chips took a line the cards wanted and a
          machine with eight checkouts scrolls them off screen. */}
      <Sheet
        open={repoSheet}
        onClose={() => setRepoSheet(false)}
        title="Which repository"
        subtitle={`${(repos ?? []).length} on this computer · the board draws one at a time`}
      >
        <Group inset={44}>
          {chips.map((c) => {
            const on = c.id === pick;
            return (
              <Row
                key={c.id}
                title={c.label}
                lead={<Glyph name={c.id === ALL ? "grid" : "folder"} color={on ? C.primary : C.text2} size={20} weight={1.8} />}
                trail={on ? <Glyph name="check" color={C.primary} size={18} /> : undefined}
                onPress={() => { setPick(c.id); setRepoSheet(false); }}
              />
            );
          })}
        </Group>
        <View style={{ paddingTop: SPACE.md }}>
          <Note>Every repository keeps its own views, rules and cards; “All repos” is the grouped list.</Note>
        </View>
      </Sheet>

      {/* The `⋯` of the mock's header: the things that belong to the board but
          not to a card. The computer's name and the usage live here too, since
          the navigator's header — which carried them — is off on this screen. */}
      <Sheet
        open={moreSheet}
        onClose={() => setMoreSheet(false)}
        title="The board"
        subtitle={repoName}
      >
        <Group inset={52}>
          <Row
            title="Read the board again"
            sub="The lists the lanes are filed from"
            lead={<Glyph name="refresh" color={C.text2} size={22} weight={1.8} />}
            onPress={() => { setMoreSheet(false); onRefresh(); }}
          />
          {showingBoard && repoSlug ? (
            <Row
              title="Save this view"
              sub="Name the rules; the computer shows it too"
              lead={<Glyph name="plus" color={C.text2} size={22} weight={1.8} />}
              onPress={() => { setMoreSheet(false); setSaveSheet(true); }}
            />
          ) : null}
          {pick !== ALL ? (
            <Row
              title={mode === "board" ? "Show the rows instead" : "Show the board again"}
              sub={mode === "board" ? "One list, every state, with a Load more" : "Five lanes, swiped sideways"}
              lead={<Glyph name={mode === "board" ? "list" : "grid"} color={C.text2} size={22} weight={1.8} />}
              onPress={() => { setMoreSheet(false); setMode(mode === "board" ? "list" : "board"); }}
            />
          ) : null}
          <Row
            title="Settings"
            sub="Notifications, appearance, quiet hours"
            lead={<Glyph name="sliders" color={C.text2} size={22} weight={1.8} />}
            chevron
            onPress={() => { setMoreSheet(false); router.push("/settings"); }}
          />
        </Group>
        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm, paddingTop: SPACE.lg }}>
          <ComputerChip compact />
          <UsageChip />
        </View>
      </Sheet>

      {host && repoSlug ? (
        <SaveViewSheet
          open={saveSheet}
          onClose={() => setSaveSheet(false)}
          repo={repoSlug}
          rules={rules}
          everyone={everyone}
          onSave={(name) => saveNewView(host, repoSlug, name, rules)}
        />
      ) : null}
      <PrFilterSheet
        open={sheet}
        onClose={() => setSheet(false)}
        scope={searching ? `search · ${repoName}` : showingBoard ? `board · ${repoName}` : `${FILTER_LABEL[filter]} · ${repoName}`}
        filters={filters}
        onApply={editFilters}
        rows={showingBoard ? boardAll : loadedRows}
        loaded={view}
        searching={searching}
        hasMore={showingBoard ? false : hasMore}
        moreAuthors={moreAuthors}
        rules={rules}
        onRules={setRules}
        views={showingBoard ? viewRow : undefined}
        viewsCondition={showingBoard ? viewsCondition : undefined}
        onRetryViews={retryViews}
        activeMissing={showingBoard && activeMissing}
        hiddenByView={showingBoard ? hiddenByView : 0}
        viewId={activeView?.id}
        onView={applyView}
        everyone={everyone}
        onEveryone={setEveryone}
      />
      <PrActionsSheet
        open={acting !== null}
        onClose={() => setActing(null)}
        host={host}
        root={boardRepo?.root ?? ""}
        pr={acting}
        forMe={acting ? lanes.some((l) => l.id === "review" && l.cards.some((c) => c.pr.number === acting.number)) : false}
        mayWrite={host?.scope === "full"}
        blocked={blocked}
        onOpen={() => { if (acting) openOnBoard(acting); }}
        onSync={() => {
          if (acting) setSingleSync(acting);
        }}
        onReviewers={() => {
          /* The reviewers sheet reads the pull request's detail (who was asked,
             who said what), which the board does not hold: it opens there. */
          if (acting && boardRepo) {
            router.push({ pathname: "/pr/[number]", params: { number: String(acting.number), root: boardRepo.root, reviewers: "1" } });
          }
        }}
        onWatch={() => { if (acting) setWatchFor(acting); }}
        onMerge={() => { if (acting) void cardAction(acting, "merge"); }}
        onChanged={() => { void loadBoard(true); }}
      />
      {host && watchFor ? (
        <WatchRuleSheet
          open
          onClose={() => setWatchFor(null)}
          host={host}
          pr={{
            root: boardRepo?.root ?? "",
            repo: repoOf(watchFor.url) ?? watchFor.baseRefName,
            number: watchFor.number,
            title: watchFor.title,
          }}
          mayWrite={host.scope === "full"}
          onArmed={() => { void loadBoard(true); }}
        />
      ) : null}
      {/* One branch, through the sheet that already compares it and holds the
          write — not a second copy of that read. */}
      <SyncSheet
        open={singleSync !== null}
        onClose={() => setSingleSync(null)}
        host={host}
        root={boardRepo?.root ?? ""}
        base={singleSync?.baseRefName ?? "the base"}
        targets={singleSync ? [{
          number: singleSync.number,
          head: singleSync.headRefName,
          conflict: singleSync.mergeable === "CONFLICTING",
        }] : []}
        mayWrite={host?.scope === "full"}
        blocked={blocked}
        onDone={() => { void loadBoard(true); }}
      />
      <SyncSheet
        open={laneSync !== null}
        onClose={() => setLaneSync(null)}
        host={host}
        root={boardRepo?.root ?? ""}
        base={laneBase}
        targets={laneTargets}
        mayWrite={host?.scope === "full"}
        blocked={blocked}
        onDone={() => { void loadBoard(true); }}
      />

      {showingBoard ? (
        boardFailed ? (
          <View style={{ padding: SPACE.lg }}>
            <StateCard
              eyebrow="Offline"
              title="Showing what the computer last said"
              text={boardFailed.needsAuth
                ? "GitHub has not been signed in to on the computer. The lanes are the last answer it gave; a pull to refresh retries once it is."
                : `The board could not be read: ${boardFailed.error}. Pull to refresh retries; the cards below, if any, are the last answer.`}
            >
              {boardFailed.needsAuth ? <CommandLine line="gh auth login" /> : null}
              <Btn label="Retry" onPress={onRefresh} style={{ minHeight: 48, alignSelf: "flex-start", paddingHorizontal: SPACE.lg }} />
            </StateCard>
          </View>
        ) : boardData === null ? (
          <View style={{ padding: SPACE.lg, gap: SPACE.sm }}>
            <StateCard
              eyebrow="Loading"
              title="Reading the five lanes"
              text="The lane strip and the empty drawers keep their height; each card fills in where it will sit. Pull down while it reads and the strip says “Refreshing…” until the time it was read."
            />
            <CardSkeleton />
            <CardSkeleton />
          </View>
        ) : lanes.every((l) => !l.cards.length && !l.hidden.length) ? (
          <View style={{ flex: 1 }}>
            <View style={{ padding: SPACE.lg, paddingBottom: 0 }}>
              {blocked ? (
                <StateCard
                  eyebrow="Read-only"
                  quiet
                  title="This phone may look, not write"
                  text="Cards, checks and reviews are all here; Approve, Request changes, Sync and Merge are hidden rather than shown as dead buttons."
                />
              ) : (
                <StateCard
                  eyebrow="Empty view"
                  title="No pull request in this view"
                  text={`${activeFilters.length ? activeFilters.map((c) => c.label).join(" · ") : activeView ? `“${activeView.name}”` : "These rules"} leaves nothing in ${repoName}. The five lanes stay, every drawer keeps its height; clearing a rule brings the cards back.`}
                >
                  {activeFilters.length ? (
                    <Btn label={`Clear the ${activeFilters.length} rule${activeFilters.length === 1 ? "" : "s"}`} onPress={() => editFilters(NO_FILTERS)} style={{ minHeight: 48, alignSelf: "flex-start", paddingHorizontal: SPACE.lg }} />
                  ) : activeView ? (
                    <Btn label={`Take off “${activeView.name}”`} onPress={() => setActiveView(null)} style={{ minHeight: 48, alignSelf: "flex-start", paddingHorizontal: SPACE.lg }} />
                  ) : null}
                </StateCard>
              )}
            </View>
            <LaneBoard
              lanes={lanes}
              now={now}
              repo={boardRepo?.name}
              host={host}
              root={boardRepo?.root ?? ""}
              tracked={tracked}
              jira={jira}
              filtered={activeFilters.length > 0 || activeView !== null}
              refreshing={pulling || boardLoading}
              onRefresh={onRefresh}
              onOpen={openOnBoard}
              onMore={() => setMode("list")}
              onSyncLane={setLaneSync}
              onAction={(pr, action) => { void cardAction(pr, action); }}
              onMenu={setActing}
              mayWrite={host?.scope === "full"}
            />
          </View>
        ) : (
          <>
            <View style={{ flex: 1 }}>
              <LaneBoard
                lanes={lanes}
                now={now}
                repo={boardRepo?.name}
                host={host}
                root={boardRepo?.root ?? ""}
                tracked={tracked}
                jira={jira}
                filtered={activeFilters.length > 0 || activeView !== null}
                refreshing={pulling || boardLoading}
                onRefresh={onRefresh}
                onOpen={openOnBoard}
                onMore={() => setMode("list")}
                onSyncLane={setLaneSync}
                onAction={(pr, action) => { void cardAction(pr, action); }}
                onMenu={setActing}
                mayWrite={host?.scope === "full"}
              />
              {/* The pull's own line, over the cards and not above them: a row
                  that exists between two reads is a row taken from the cards. */}
              {pulling ? (
                <View
                  pointerEvents="none"
                  accessibilityLabel="Reading the board again"
                  style={{
                    position: "absolute", top: 0, left: 0, right: 0, height: 26,
                    alignItems: "center", justifyContent: "center", backgroundColor: C.bg,
                  }}
                >
                  <Text style={{ color: C.text3, fontSize: T.eyebrow }}>Refreshing…</Text>
                </View>
              ) : null}
            </View>
          </>
        )
      ) : (
        <FlatList
          data={rows}
          keyboardShouldPersistTaps="handled"
          keyExtractor={(row) => ("heading" in row ? `h:${row.heading}` : `${row.root}#${row.item.number}`)}
          contentContainerStyle={{ padding: SPACE.lg, paddingTop: SPACE.sm, paddingBottom: SPACE.xl }}
          refreshControl={<RefreshControl refreshing={pulling} onRefresh={onRefresh} tintColor={C.text3} />}
          ListEmptyComponent={
            groups === null && !failed ? null : (
              <Card>
                <Text style={{ color: failed ? C.error : C.text, fontSize: T.body, fontWeight: "600" }}>
                  {failed ? "Can't ask GitHub" : searching || activeFilters.length ? "No match" : view === "open" ? "Nothing open" : `Nothing ${view === "all" ? "here" : view}`}
                </Text>
                <Note tone={failed ? "bad" : "quiet"}>
                  {failed
                    ? (failed.needsAuth
                      ? "GitHub has not been signed in to on the computer. Run this there:"
                      : failed.error)
                    : searching
                      ? `No ${kind}pull request matches “${query}”${pick === ALL ? "" : " in this repository"}.${view === "all" ? "" : " Try State: Any, which includes the merged and the closed."}`
                      : filter === "review" && view === "open" && !activeFilters.length
                        ? "Nobody is waiting on your review."
                        : `No ${kind}pull request matches this filter${pick === ALL ? "" : " in this repository"}.`}
                </Note>
                {/* The fix is one command on the computer, and it is copied
                    rather than retyped: a phone is where it is read, the
                    computer is where it is run. */}
                {failed?.needsAuth ? <CommandLine line="gh auth login" /> : null}
              </Card>
            )
          }
          ListFooterComponent={hasMore ? (
            <View style={{ gap: SPACE.sm }}>
              {moreError ? <Note tone="bad">The next page did not load: {moreError}. Press the button to try again.</Note> : null}
              <Btn
                label={`Load ${nextPageCount(groups ?? [], pageSize)} more`}
                onPress={() => { void loadMore(); }}
                busy={more}
                style={{ minHeight: 48, marginTop: SPACE.xs }}
              />
            </View>
          ) : null}
          ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
          renderItem={({ item: row }) => (
            "heading" in row
              ? <GroupTitle text={row.heading} trailing={<Text style={{ color: C.text3, fontSize: 13 }}>{row.count}</Text>} />
              : (
                <Item
                  host={host}
                  pr={row.item}
                  tracked={tracked}
                  now={now}
                  forMe={filter === "review" && !searching}
                  query={query}
                  unread={unreadOf(row.item, prRepoKey(row.item), seenMarks)}
                  // The object form, not a built string: a checkout path is full
                  // of characters a URL segment has opinions about.
                  onOpen={() => router.push({
                    pathname: "/pr/[number]",
                    params: { number: String(row.item.number), root: row.root },
                  })}
                />
              )
          )}
        />
      )}
      {said ? <Snack text={said} /> : null}
    </View>
  );
}
