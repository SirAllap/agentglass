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
import { FlatList, RefreshControl, Text, View } from "react-native";
import { useRouter } from "expo-router";
import type { GitRepoRef, PrSummary } from "../../../shared/types.ts";
import { prRepoKey, unreadOf, type Unread } from "../../../shared/prUnread.ts";
import { ask, askCached } from "../../src/lib/api.ts";
import { useAgentglass, PR_READ_TTL_MS } from "../../src/state/host-context.tsx";
import { useReloadOnTick, useTalkTick } from "../../src/state/pr-talk.ts";
import { usePaletteTick } from "../../src/state/use-palette.ts";
import { useSeenMarks } from "../../src/state/read-marks.ts";
import { Btn, Card, CommandLine, FilterChips, GroupTitle, Note, Segmented } from "../../src/ui.tsx";
import { PrCard } from "../../src/review/PrCard.tsx";
import { PrActiveFilters } from "../../src/review/PrActiveFilters.tsx";
import { PrFilterSheet } from "../../src/review/PrFilterSheet.tsx";
import { PrSearchRow } from "../../src/review/PrSearchRow.tsx";
import { forgetPrCards, usePrCard } from "../../src/state/pr-cards.ts";
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
import { mergeFresh, nextPageCount } from "../../src/model/prPaging.ts";
import type { Host } from "../../src/lib/host.ts";
import { C, SPACE, T } from "../../src/theme.ts";

type Filter = "mine" | "review" | "all";

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
  const { state, find } = usePrCard(host, pr, tracked);
  return <PrCard pr={pr} now={now} forMe={forMe} unread={unread} card={state} query={query} onFind={find} onOpen={onOpen} />;
}

export default function PrsScreen(): React.ReactNode {
  usePaletteTick(); // a scene repaints only if it asks — see use-palette.ts
  const { host } = useAgentglass();
  const router = useRouter();
  const [repos, setRepos] = useState<GitRepoRef[] | null>(null);
  /** A repository's root, or ALL. */
  const [pick, setPick] = useState<string>(ALL);
  const [filter, setFilter] = useState<Filter>("review");
  /** What the sheet narrows by. Its state is Open unless asked — the list
   *  answers "what is waiting", and a closed pull request is a thing you go
   *  looking for — and Any while searching. */
  const [filters, setFilters] = useState<PrFilters>(NO_FILTERS);
  const [sheet, setSheet] = useState(false);
  const [text, setText] = useState("");
  /** What was typed, once typing paused: the words the server is asked. */
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);
  const searching = query.length > 0;
  /** The state the tab's own list is read in, and the state shown: a search
   *  looks at every state unless one was chosen. */
  const browseView = effectiveState(filters, false);
  const view = effectiveState(filters, searching);
  const [groups, setGroups] = useState<PrGroup[] | null>(null);
  const [more, setMore] = useState(false);
  /** Why the last "Load more" brought nothing, when it failed. */
  const [moreError, setMoreError] = useState<string | null>(null);
  /** The "All" tab's number — the server sends none, see allCount. */
  const [allKnown, setAllKnown] = useState<number | null>(null);
  const tracked = useTracksWork(host);
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
      setRepos(mainCheckouts(Array.isArray(answer.value.repos) ? answer.value.repos : []));
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
    if (!host || !shown.length) return;
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
  }, [host, shown, filter, view, browseView, query, listPath]);

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

  const onRefresh = useCallback((): void => {
    setPulling(true);
    forgetPrCards(host);
    void loadCounts();
    void load(true).finally(() => setPulling(false));
  }, [host, load, loadCounts]);

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

  if (!host) return null;

  const repoName = pick === ALL ? "all repositories" : (repos ?? []).find((r) => r.root === pick)?.name ?? "this repository";
  /** The repositories' contributors, for the sheet's people list. */
  const moreAuthors = async (): Promise<string[]> => {
    const answers = await Promise.all(shown.map((r) =>
      ask<{ ok: boolean; data?: { authors?: string[] } }>(host, `/prs/facets?root=${encodeURIComponent(r.root)}`)));
    return [...new Set(answers.flatMap((a) => (a.ok && a.value.ok ? a.value.data?.authors ?? [] : [])))];
  };

  const chips = [
    { id: ALL, label: "All repos" },
    ...(repos ?? []).map((r) => ({ id: r.root, label: r.name })),
  ];

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={{ paddingHorizontal: SPACE.lg, paddingTop: SPACE.xs, gap: SPACE.sm, paddingBottom: SPACE.md }}>
        <PrSearchRow value={text} onChange={setText} active={activeFilters.length} onFilters={() => setSheet(true)} />
        {/* A search leaves the tabs: it looks through the whole repository, and
            a tab still lit above a list that ignores it would say otherwise. */}
        {searching ? (
          <View style={{ minHeight: 48, justifyContent: "center" }}>
            <Note>
              Searching all of {repoName} · title, description, #number, author, branch ·{" "}
              {groups === null ? "…" : `${shownRows}${hasMore ? "+" : ""} result${shownRows === 1 && !hasMore ? "" : "s"}`}
            </Note>
          </View>
        ) : (
          <Segmented
            value={filter}
            onChange={setFilter}
            options={FILTERS.map((id) => ({
              id,
              label: FILTER_LABEL[id],
              count: id === "all" ? allKnown ?? undefined : counts?.[id],
            }))}
          />
        )}
      </View>
      <PrActiveFilters
        chips={activeFilters}
        onRemove={(id) => setFilters((f) => removeChip(f, id))}
        onClear={() => setFilters(NO_FILTERS)}
        shown={shownRows}
        total={inStateRows}
        more={hasMore}
        hidden={hiddenNoCard}
        onShowHidden={() => setFilters((f) => ({ ...f, noCard: true }))}
      />
      <PrFilterSheet
        open={sheet}
        onClose={() => setSheet(false)}
        scope={searching ? `search · ${repoName}` : `${FILTER_LABEL[filter]} · ${repoName}`}
        filters={filters}
        onApply={setFilters}
        rows={loadedRows}
        loaded={view}
        searching={searching}
        hasMore={hasMore}
        moreAuthors={moreAuthors}
      />
      {/* Only with more than one repository: a single chip is a label. */}
      {(repos?.length ?? 0) > 1 ? <FilterChips label="Repository" options={chips} value={pick} onChange={setPick} /> : null}

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
    </View>
  );
}
