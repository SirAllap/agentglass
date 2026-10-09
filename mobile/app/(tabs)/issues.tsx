/*
 * Issues, across every repository at once.
 *
 * The screen this app did not have for a long time. `/issues/list` has been
 * answering on the machine the whole time and nothing on the phone ever asked
 * it — so the one kind of work that arrives without a branch behind it was the
 * one kind you could not see from a sofa.
 *
 * The same shape as the pull requests, because a thumb moving between the two
 * should meet one gesture and not two: a segmented filter, a row of repository
 * chips opening on all of them, and rows grouped under each repository. The
 * cap is the same eight and for the same reason — see prs.tsx.
 *
 * Two things get answered on the row itself, because between them they decide
 * whether to open it: whether anybody has STARTED it, and what kind of thing it
 * is. An issue nobody has picked up is the one worth reading now. `work` lives
 * on the detail, so the row uses what it has — an assignee is the cheapest
 * honest proxy for it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { useRouter } from "expo-router";
import type { GitRepoRef, IssueRow, IssueViewCounts, IssuesReport } from "../../../shared/types.ts";
import { ask } from "../../src/lib/api.ts";
import { useAgentglass } from "../../src/state/host-context.tsx";
import { usePaletteTick } from "../../src/state/use-palette.ts";
import { Chip, FilterChips, GroupTitle, LabelChip, ListEmpty, Segmented } from "../../src/ui.tsx";
import { Avatar } from "../../src/Avatar.tsx";
import { issueMatches } from "../../src/model/issueList.ts";
import { Ghost } from "../../src/review/PrCard.tsx";
import { PrSearchRow } from "../../src/review/PrSearchRow.tsx";
import { mainCheckouts } from "../../src/model/prRows.ts";
import { flatten, type RepoGroup } from "../../src/model/prLook.ts";
import { IssuesIcon } from "../../src/nav/icons.tsx";
import { since } from "../../src/lib/dates.ts";
import { sumIssueCounts } from "../../src/model/issueCounts.ts";
import { C, RADIUS, SPACE, T } from "../../src/theme.ts";

type Filter = "mine" | "open" | "all";

/** Yours first, for the same reason Review leads the pull requests: it is the
 *  only one of the three that is about you. */
const FILTERS: { id: Filter; label: string }[] = [
  { id: "mine", label: "Mine" },
  { id: "open", label: "Open" },
  { id: "all", label: "All" },
];

const REPO_CAP = 8;
const ALL = "*";

/**
 * One issue as a card: the number and title, then what it is about (every
 * label, the comment count), then who has it. Closed ones are dimmed rather
 * than hidden, so "did I close that?" is answerable in the All filter.
 */
function Row({ issue, now, me, onOpen }: {
  issue: IssueRow;
  now: number;
  me: string;
  onOpen: () => void;
}): React.ReactNode {
  const closed = issue.state.toLowerCase() === "closed";
  const mine = !!me && issue.assignees.includes(me);
  const who = issue.assignees[0];
  return (
    <Pressable
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={`${closed ? "Closed" : "Open"} issue: ${issue.title}. #${issue.number}`}
      style={({ pressed }) => ({
        padding: SPACE.md, gap: SPACE.sm, borderRadius: RADIUS.lg, borderWidth: 1, borderColor: C.border,
        backgroundColor: pressed ? C.bg3 : C.bg2, opacity: closed ? 0.7 : 1,
      })}
    >
      <Text numberOfLines={2} style={{ color: closed ? C.text2 : C.text, fontSize: 15, fontWeight: "600", lineHeight: 20 }}>
        <Text style={{ color: C.text3, fontSize: T.small }}>#{issue.number}  </Text>{issue.title}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        {closed ? <Chip label="closed" tone="good" /> : null}
        {issue.labels.map((l) => <LabelChip key={l.name} name={l.name} color={l.color} />)}
        {issue.comments > 0 ? <Chip label={String(issue.comments)} /> : null}
        <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.small, flexShrink: 1 }}>
          {issue.author} · {since(issue.updatedAt, now)}
        </Text>
        <View style={{ flex: 1 }} />
        {who
          ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              {mine ? <Text style={{ color: C.primary, fontSize: T.small, fontWeight: "600" }}>You</Text> : null}
              <Avatar name={who} login={who} size={24} />
            </View>
          )
          : (
            // Dashed, because an empty slot is a different claim from a person.
            <Ghost text="unassigned" />
          )}
      </View>
    </Pressable>
  );
}

export default function IssuesScreen(): React.ReactNode {
  usePaletteTick(); // a scene repaints only if it asks — see use-palette.ts
  const { host, fleet } = useAgentglass();
  const router = useRouter();
  const [repos, setRepos] = useState<GitRepoRef[] | null>(null);
  const [pick, setPick] = useState<string>(ALL);
  const [filter, setFilter] = useState<Filter>("mine");
  const [groups, setGroups] = useState<RepoGroup<IssueRow>[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pulling, setPulling] = useState(false);
  const [counts, setCounts] = useState<IssueViewCounts | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!host) return;
    void (async () => {
      const answer = await ask<{ repos: GitRepoRef[] }>(host, "/git/repos");
      if (!answer.ok) { setError(answer.error); return; }
      /* One entry per REPOSITORY, not per checkout — `mainCheckouts`, the same
         rule the pull requests follow and for the same reason: six worktrees
         of one repository answer with the same issues. */
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
    const query = filter === "mine" ? "&assignee=%40me&state=open" : filter === "all" ? "&state=all" : "&state=open";
    const answers = await Promise.all(shown.map(async (repo) => ({
      repo,
      answer: await ask<IssuesReport>(host, `/issues/list?root=${encodeURIComponent(repo.root)}${query}`),
    })));
    if (mine !== asked.current) return;
    const good = answers.filter((a) => a.answer.ok && a.answer.value.ok);
    // Said only when NOTHING answered: one repository without a GitHub remote
    // among eight is not a reason to hide the other seven.
    if (!good.length) {
      const first = answers[0]?.answer;
      setError(first && !first.ok ? first.error : (first?.ok && first.value.error) || "GitHub did not answer");
      setGroups(null);
      return;
    }
    setError(null);
    setGroups(good.map(({ repo, answer }) => ({
      root: repo.root,
      name: repo.name,
      items: answer.ok && Array.isArray(answer.value.issues) ? answer.value.issues : [],
    })));
  }, [host, shown, filter]);

  useEffect(() => { setGroups(null); void load(); }, [load]);

  /* The numbers on the three filters. They follow the repositories shown and
     not the filter: all three are one question, so switching tabs does not ask
     again. A pull-to-refresh asks again without blanking what is on screen —
     the old numbers stay true until the new ones land. Only the latest ask
     may paint, for the reason `asked` guards `load`. */
  const countsAsked = useRef(0);
  const loadCounts = useCallback(async (): Promise<void> => {
    if (!host || !shown.length) return;
    const mine = ++countsAsked.current;
    const answers = await Promise.all(shown.map((r) =>
      ask<{ ok: boolean; counts?: IssueViewCounts }>(host, `/issues/counts?root=${encodeURIComponent(r.root)}`)));
    if (mine !== countsAsked.current) return;
    const got = answers.flatMap((a) => (a.ok && a.value.ok && a.value.counts ? [a.value.counts] : []));
    const sum = sumIssueCounts(got);
    if (sum) setCounts(sum);
  }, [host, shown]);
  useEffect(() => { setCounts(null); void loadCounts(); }, [loadCounts]);

  const onRefresh = useCallback((): void => {
    setPulling(true);
    void Promise.all([load(), loadCounts()]).finally(() => setPulling(false));
  }, [load, loadCounts]);

  // Typing narrows what was loaded; a repository with no match drops its heading.
  const rows = useMemo(() => {
    if (!search.trim()) return flatten(groups ?? []);
    return flatten((groups ?? [])
      .map((g) => ({ ...g, items: g.items.filter((i) => issueMatches(i, search)) }))
      .filter((g) => g.items.length));
  }, [groups, search]);
  const filterOptions = useMemo(() => FILTERS.map((f) => ({ ...f, count: counts?.[f.id] })), [counts]);
  const now = Date.now();

  if (!host) return null;

  const chips = [{ id: ALL, label: "All repos" }, ...(repos ?? []).map((r) => ({ id: r.root, label: r.name }))];

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={{ paddingHorizontal: SPACE.lg, paddingTop: SPACE.xs, paddingBottom: SPACE.md, gap: SPACE.md }}>
        <PrSearchRow
          value={search} onChange={setSearch} placeholder="Search title, #number, label" label="Search issues"
        />
        <Segmented value={filter} onChange={setFilter} options={filterOptions} />
      </View>
      {(repos?.length ?? 0) > 1 ? <FilterChips label="Repository" options={chips} value={pick} onChange={setPick} /> : null}

      <FlatList
        data={rows}
        keyExtractor={(row) => ("heading" in row ? `h:${row.heading}` : `${row.root}#${row.item.number}`)}
        contentContainerStyle={{ padding: SPACE.lg, paddingTop: SPACE.sm, paddingBottom: SPACE.xl, gap: SPACE.sm }}
        refreshControl={<RefreshControl refreshing={pulling} onRefresh={onRefresh} tintColor={C.text3} />}
        ListEmptyComponent={
          groups === null && !error ? null : (
            <ListEmpty
              error={error}
              errorTitle="Can't ask GitHub"
              emptyTitle="Nothing open"
              emptyText={search.trim()
                ? "No issue on this list matches what is typed above. Clear the search to see the rest."
                : filter === "mine"
                ? `No open issue is assigned to you${pick === ALL ? "" : " in this repository"}.`
                : `No issue matches this filter${pick === ALL ? "" : " in this repository"}.`}
              onRetry={() => { void load(); }}
            />
          )
        }
        renderItem={({ item: row }) => (
          "heading" in row
            ? <GroupTitle text={row.heading} trailing={<Text style={{ color: C.text3, fontSize: 13 }}>{row.count}</Text>} />
            : (
              <Row
                issue={row.item}
                now={now}
                me={fleet.me}
                onOpen={() => router.push({
                  pathname: "/issue/[number]",
                  params: { number: String(row.item.number), root: row.root },
                })}
              />
            )
        )}
      />
    </View>
  );
}
