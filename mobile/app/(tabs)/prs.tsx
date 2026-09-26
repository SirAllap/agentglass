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
 * Three lines, each answering one of the questions that decide whether it is
 * opened: the title beside a mark that says what CI thinks; the review and
 * the checks as chips, with the size; and whose it is, how old, and its
 * number. The words and tones are decided in model/prLook.ts.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { useRouter } from "expo-router";
import type { GitRepoRef, PrSummary } from "../../../shared/types.ts";
import { prRepoKey, unreadOf, unreadTitle, type Unread } from "../../../shared/prUnread.ts";
import { ask } from "../../src/lib/api.ts";
import { useAgentglass } from "../../src/state/host-context.tsx";
import { useReloadOnTick, useTalkTick } from "../../src/state/pr-talk.ts";
import { usePaletteTick } from "../../src/state/use-palette.ts";
import { useSeenMarks } from "../../src/state/read-marks.ts";
import { Card, Chip, CommandLine, Field, FilterChips, GroupTitle, Note, Segmented, groupEdge } from "../../src/ui.tsx";
import { mainCheckouts } from "../../src/model/prRows.ts";
import { byState, stateQuery, STATE_LABEL, STATE_VIEWS, type StateView } from "../../src/model/prState.ts";
import { prTextMatch } from "../../../shared/prSearch.ts";
import { ciLook, flatten, reviewLook, type CiMark, type RepoGroup } from "../../src/model/prLook.ts";
import { Glyph, type GlyphName } from "../../src/nav/glyphs.tsx";
import { since } from "../../src/lib/dates.ts";
import { C, MONO, SPACE, T } from "../../src/theme.ts";

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
}

/** What `/prs/counts` answers with. Same reason as `PrList`. The one field
 *  this screen reads is named after a filter, which is what keeps the two in
 *  step: a rename on either side stops matching `FILTERS`. */
interface PrViewCounts { review: number; mine: number; failing: number; ready: number; all: number }

const MARK: Record<CiMark, { glyph: GlyphName; ink: () => string; says: string }> = {
  fail: { glyph: "x_circle", ink: () => C.error, says: "Checks failed" },
  run: { glyph: "run_circle", ink: () => C.warning, says: "Checks running" },
  ok: { glyph: "ok_circle", ink: () => C.success, says: "Checks passed" },
  draft: { glyph: "draft_circle", ink: () => C.text3, says: "Draft" },
  none: { glyph: "circle", ink: () => C.text4, says: "No checks" },
  loading: { glyph: "circle", ink: () => C.text4, says: "Checks not read yet" },
};

function Row({ pr, now, forMe, unread, onOpen }: {
  pr: PrSummary;
  now: number;
  forMe: boolean;
  /** Something said on it since this person last looked — see shared/prUnread.ts. */
  unread: Unread | null;
  onOpen: () => void;
}): React.ReactNode {
  const ci = ciLook(pr);
  const review = reviewLook(pr, forMe);
  const mark = MARK[ci.mark];
  const gone = pr.state === "OPEN" ? null : pr.state === "MERGED" ? "Merged" : "Closed";
  return (
    <Pressable
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={`${pr.title}. ${gone ? `${gone}. ` : ""}${mark.says}${ci.label ? `, ${ci.label}` : ""}. ${review?.label ?? ""}. #${pr.number} by ${pr.author}${unread ? `. ${unreadTitle(unread)}` : ""}`}
    >
      {({ pressed }) => (
        /* Padding, not a card. The surface and the border belong to the group
           this row sits in — see groupEdge in src/ui.tsx. */
        <View style={{
          flexDirection: "row", gap: SPACE.md, paddingHorizontal: SPACE.lg, paddingVertical: 14,
          backgroundColor: pressed ? C.bg3 : "transparent",
        }}>
          <View style={{ paddingTop: 1 }}><Glyph name={mark.glyph} color={mark.ink()} size={20} weight={1.9} /></View>
          <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
            <Text numberOfLines={2} style={{ color: C.text, fontSize: 15, fontWeight: "500", lineHeight: 20 }}>
              {pr.title}
            </Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              {/* First: the one chip that says "go and look", where the rest
                  describe the state. */}
              {unread ? <Chip label={`${unread.count} new`} tone="accent" /> : null}
              {/* An open one says nothing: it is the default, and the list is
                  mostly it. A merged or closed one has to say so, or under
                  "Any" it reads as one still waiting on somebody. */}
              {gone ? <Chip label={gone} tone={gone === "Merged" ? "accent" : "neutral"} /> : null}
              {review ? <Chip label={review.label} tone={review.tone} /> : null}
              {ci.label ? <Chip label={ci.label} tone={ci.tone} /> : null}
              <View style={{ flex: 1 }} />
              {/* Size, because "is this ten minutes or an afternoon" is the other
                  thing that decides whether you open it now. */}
              <Text style={{ fontSize: T.small, fontFamily: MONO }}>
                <Text style={{ color: C.success }}>+{pr.additions}</Text>
                <Text style={{ color: C.error }}> −{pr.deletions}</Text>
              </Text>
            </View>
            <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.small }}>
              #{pr.number} · {pr.author} · {since(pr.updatedAt, now)}
            </Text>
          </View>
        </View>
      )}
    </Pressable>
  );
}

export default function PrsScreen(): React.ReactNode {
  usePaletteTick(); // a scene repaints only if it asks — see use-palette.ts
  const { host } = useAgentglass();
  const router = useRouter();
  const [repos, setRepos] = useState<GitRepoRef[] | null>(null);
  /** A repository's root, or ALL. */
  const [pick, setPick] = useState<string>(ALL);
  const [filter, setFilter] = useState<Filter>("review");
  /** Open unless asked: the list answers "what is waiting", and a closed
   *  pull request is a thing you go looking for, with the chips or the box. */
  const [view, setView] = useState<StateView>("open");
  const [text, setText] = useState("");
  const [groups, setGroups] = useState<RepoGroup<PrSummary>[] | null>(null);
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
      const answer = await ask<{ repos: GitRepoRef[] }>(host, "/git/repos");
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
  const load = useCallback(async (): Promise<void> => {
    if (!host || !shown.length) return;
    const mine = ++asked.current;
    const answers = await Promise.all(shown.map(async (repo) => ({
      repo,
      answer: await ask<PrList>(host, `/prs/list?root=${encodeURIComponent(repo.root)}&filter=${filter}&state=${stateQuery(view)}`),
    })));
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
    setGroups(good.map(({ repo, answer }) => ({
      root: repo.root,
      name: repo.name,
      items: answer.ok && Array.isArray(answer.value.prs) ? answer.value.prs : [],
    })));
  }, [host, shown, filter, view]);

  useEffect(() => { setGroups(null); void load(); }, [load]);

  // A live comment or review landed on one of these pull requests.
  useReloadOnTick(useTalkTick(), load);

  // Counts follow what is shown and not the filter — they are the counts OF
  // the filters, so re-asking when one is tapped would be asking the same
  // question again.
  useEffect(() => {
    if (!host || !shown.length) return;
    let gone = false;
    setCounts(null);
    // "Merged" is asked as "closed", so its counts would count the closed ones
    // too: no number is truer than a wrong one.
    if (view === "merged") return;
    void (async () => {
      const answers = await Promise.all(shown.map((r) =>
        ask<{ ok: boolean; counts?: PrViewCounts }>(host, `/prs/counts?root=${encodeURIComponent(r.root)}&state=${stateQuery(view)}`)));
      if (gone) return;
      const got = answers.flatMap((a) => (a.ok && a.value.ok && a.value.counts ? [a.value.counts] : []));
      if (!got.length) return;
      setCounts(got.reduce((sum, c) => ({
        review: sum.review + c.review, mine: sum.mine + c.mine, failing: sum.failing + c.failing,
        ready: sum.ready + c.ready, all: sum.all + c.all,
      })));
    })();
    return () => { gone = true; };
  }, [host, shown, view]);

  // The check rollup lands on a second pass, so one re-read a moment later is
  // the difference between "checks…" forever and the row settling.
  useEffect(() => {
    if (!loading) return;
    const timer = setTimeout(() => { void load(); }, 2500);
    return () => clearTimeout(timer);
  }, [loading, load]);

  const onRefresh = useCallback((): void => {
    setPulling(true);
    void load().finally(() => setPulling(false));
  }, [load]);

  /* The state split and the search are both applied here, on what the server
     sent, so typing never asks GitHub anything. A repository with nothing left
     loses its heading rather than showing an empty one. */
  const narrowed = useMemo(() => (groups ?? []).map((g) => ({
    ...g, items: byState(g.items, view).filter((p) => prTextMatch(p, text)),
  })).filter((g) => g.items.length), [groups, view, text]);
  const rows = useMemo(() => flatten(narrowed), [narrowed]);
  const searching = text.trim().length > 0;
  /** "No merged pull request…" / "No pull request…" */
  const kind = view === "all" ? "" : `${view} `;
  const isItem = (r: (typeof rows)[number] | undefined): boolean => !!r && "item" in r;
  const now = Date.now();

  if (!host) return null;

  const chips = [
    { id: ALL, label: "All repos" },
    ...(repos ?? []).map((r) => ({ id: r.root, label: r.name })),
  ];

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={{ paddingHorizontal: SPACE.lg, paddingTop: SPACE.xs, gap: SPACE.sm, paddingBottom: SPACE.md }}>
        <Field value={text} onChangeText={setText} placeholder="Search title, #number, author, branch" />
        <Segmented
          value={filter}
          onChange={setFilter}
          options={FILTERS.map((id) => ({
            id,
            label: FILTER_LABEL[id],
            count: counts ? counts[id] : undefined,
          }))}
        />
      </View>
      <FilterChips
        label="State"
        options={STATE_VIEWS.map((id) => ({ id, label: STATE_LABEL[id] }))}
        value={view}
        onChange={setView}
      />
      {/* Only with more than one repository: a single chip is a label. */}
      {(repos?.length ?? 0) > 1 ? <FilterChips label="Repository" options={chips} value={pick} onChange={setPick} /> : null}

      <FlatList
        data={rows}
        keyboardShouldPersistTaps="handled"
        keyExtractor={(row) => ("heading" in row ? `h:${row.heading}` : `${row.root}#${row.item.number}`)}
        /* No gap between rows: they are one card divided by hairlines, not a
           stack of cards. See groupEdge in src/ui.tsx. */
        contentContainerStyle={{ padding: SPACE.lg, paddingTop: SPACE.sm, paddingBottom: SPACE.xl }}
        refreshControl={<RefreshControl refreshing={pulling} onRefresh={onRefresh} tintColor={C.text3} />}
        ListEmptyComponent={
          groups === null && !failed ? null : (
            <Card>
              <Text style={{ color: failed ? C.error : C.text, fontSize: T.body, fontWeight: "600" }}>
                {failed ? "Can't ask GitHub" : searching ? "No match" : view === "open" ? "Nothing open" : `Nothing ${view === "all" ? "here" : view}`}
              </Text>
              <Note tone={failed ? "bad" : "quiet"}>
                {failed
                  ? (failed.needsAuth
                    ? "GitHub has not been signed in to on the computer. Run this there:"
                    : failed.error)
                  : searching
                    ? `No ${kind}pull request matches “${text.trim()}”${pick === ALL ? "" : " in this repository"}.${view === "all" ? "" : " Try Any, which includes the merged and the closed."}`
                    : filter === "review" && view === "open"
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
        renderItem={({ item: row, index }) => (
          "heading" in row
            ? <GroupTitle text={row.heading} trailing={<Text style={{ color: C.text3, fontSize: 13 }}>{row.count}</Text>} />
            : (
              <View style={groupEdge(!isItem(rows[index - 1]), !isItem(rows[index + 1]))}>
                <Row
                  pr={row.item}
                  now={now}
                  forMe={filter === "review"}
                  unread={unreadOf(row.item, prRepoKey(row.item), seenMarks)}
                  // The object form, not a built string: a checkout path is full
                  // of characters a URL segment has opinions about.
                  onOpen={() => router.push({
                    pathname: "/pr/[number]",
                    params: { number: String(row.item.number), root: row.root },
                  })}
                />
              </View>
            )
        )}
      />
    </View>
  );
}
