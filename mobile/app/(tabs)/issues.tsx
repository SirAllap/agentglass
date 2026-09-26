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
import type { GitRepoRef, IssueRow, IssuesReport } from "../../../shared/types.ts";
import { ask } from "../../src/lib/api.ts";
import { useAgentglass } from "../../src/state/host-context.tsx";
import { usePaletteTick } from "../../src/state/use-palette.ts";
import { Chip, FilterChips, GroupTitle, LabelChip, ListEmpty, Segmented, groupEdge } from "../../src/ui.tsx";
import { mainCheckouts } from "../../src/model/prRows.ts";
import { flatten, type RepoGroup } from "../../src/model/prLook.ts";
import { IssuesIcon } from "../../src/nav/icons.tsx";
import { since } from "../../src/lib/dates.ts";
import { C, SPACE, T } from "../../src/theme.ts";

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

function Row({ issue, now, me, onOpen }: {
  issue: IssueRow;
  now: number;
  me: string;
  onOpen: () => void;
}): React.ReactNode {
  const closed = issue.state.toLowerCase() === "closed";
  const mine = !!me && issue.assignees.includes(me);
  return (
    <Pressable onPress={onOpen} accessibilityRole="button" accessibilityLabel={`${closed ? "Closed" : "Open"} issue: ${issue.title}. #${issue.number}`}>
      {({ pressed }) => (
        <View style={{
          flexDirection: "row", gap: SPACE.md, paddingHorizontal: SPACE.lg, paddingVertical: 14,
          backgroundColor: pressed ? C.bg3 : "transparent",
        }}>
          {/* GitHub's own mark, green while open and grey once closed: the
              shape says it is an issue and the colour says which state. */}
          <View style={{ paddingTop: 1 }}><IssuesIcon color={closed ? C.text3 : C.success} size={20} /></View>
          <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
            <Text numberOfLines={2} style={{ color: C.text, fontSize: 15, fontWeight: "500", lineHeight: 20 }}>
              {issue.title}
            </Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              {issue.labels.slice(0, 3).map((l) => <LabelChip key={l.name} name={l.name} color={l.color} />)}
              {issue.assignees.length === 0
                ? <Chip label="Unassigned" />
                : <Chip label={mine ? "You" : issue.assignees.join(", ")} tone={mine ? "accent" : "neutral"} />}
            </View>
            <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.small }}>
              #{issue.number} · {issue.author} · {since(issue.updatedAt, now)}
              {issue.comments > 0 ? ` · ${issue.comments} ${issue.comments === 1 ? "comment" : "comments"}` : ""}
            </Text>
          </View>
        </View>
      )}
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

  const onRefresh = useCallback((): void => {
    setPulling(true);
    void load().finally(() => setPulling(false));
  }, [load]);

  const rows = useMemo(() => flatten(groups ?? []), [groups]);
  const isItem = (r: (typeof rows)[number] | undefined): boolean => !!r && "item" in r;
  const now = Date.now();

  if (!host) return null;

  const chips = [{ id: ALL, label: "All repos" }, ...(repos ?? []).map((r) => ({ id: r.root, label: r.name }))];

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={{ paddingHorizontal: SPACE.lg, paddingTop: SPACE.xs, paddingBottom: SPACE.md }}>
        <Segmented value={filter} onChange={setFilter} options={FILTERS} />
      </View>
      {(repos?.length ?? 0) > 1 ? <FilterChips label="Repository" options={chips} value={pick} onChange={setPick} /> : null}

      <FlatList
        data={rows}
        keyExtractor={(row) => ("heading" in row ? `h:${row.heading}` : `${row.root}#${row.item.number}`)}
        /* No gap between rows: they are one card divided by hairlines, not a
           stack of cards. See groupEdge in src/ui.tsx. */
        contentContainerStyle={{ padding: SPACE.lg, paddingTop: SPACE.sm, paddingBottom: SPACE.xl }}
        refreshControl={<RefreshControl refreshing={pulling} onRefresh={onRefresh} tintColor={C.text3} />}
        ListEmptyComponent={
          groups === null && !error ? null : (
            <ListEmpty
              error={error}
              errorTitle="Can't ask GitHub"
              emptyTitle="Nothing open"
              emptyText={filter === "mine"
                ? `No open issue is assigned to you${pick === ALL ? "" : " in this repository"}.`
                : `No issue matches this filter${pick === ALL ? "" : " in this repository"}.`}
              onRetry={() => { void load(); }}
            />
          )
        }
        renderItem={({ item: row, index }) => (
          "heading" in row
            ? <GroupTitle text={row.heading} trailing={<Text style={{ color: C.text3, fontSize: 13 }}>{row.count}</Text>} />
            : (
              <View style={groupEdge(!isItem(rows[index - 1]), !isItem(rows[index + 1]))}>
                <Row
                  issue={row.item}
                  now={now}
                  me={fleet.me}
                  onOpen={() => router.push({
                    pathname: "/issue/[number]",
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
