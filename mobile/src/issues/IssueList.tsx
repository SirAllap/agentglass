/*
 * Issues, across every repository at once — drawn inside Tasks.
 *
 * It used to be its own destination, and it is a source now: the Tasks tab's
 * source pill switches to it (model/taskProviders.ts), because an issue is work
 * and work belongs in Tasks.
 *
 * ── the row is the mock's ────────────────────────────────────────────────
 * One label, the title, and the number with how many comments it has: the
 * three things that decide whether to open it. The row used to carry the author,
 * the age and an avatar as well, and at 360 points that made a card three lines
 * of furniture around a title nobody could finish reading. Who has an issue is
 * a question for the issue, not the list.
 *
 * The route `app/(tabs)/issues.tsx` still exists: it redirects here, because
 * links and notifications land on it.
 *
 * ── searching is the header's ────────────────────────────────────────────
 * The magnifier in the Tasks header opens this screen's field
 * (`searching`), so the list does not draw a search box of its own above a
 * list that has a header. Typing narrows what was loaded; it asks GitHub
 * nothing.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { useRouter } from "expo-router";
import type { GitRepoRef, IssueRow, IssueViewCounts, IssuesReport } from "../../../shared/types.ts";
import { ask } from "../../src/lib/api.ts";
import { useAgentglass } from "../../src/state/host-context.tsx";
import { usePaletteTick } from "../../src/state/use-palette.ts";
import { Chip, FilterChips, LabelChip, ListEmpty, Note, Segmented } from "../../src/ui.tsx";
import { issueMatches } from "../../src/model/issueList.ts";
import { mainCheckouts } from "../../src/model/prRows.ts";
import { flatten, type RepoGroup } from "../../src/model/prLook.ts";
import { since } from "../../src/lib/dates.ts";
import { sumIssueCounts } from "../../src/model/issueCounts.ts";
import { SearchField } from "../../src/tasks/TasksTop.tsx";
import { Glyph } from "../../src/nav/glyphs.tsx";
import { C, MONO, RADIUS, SPACE, T } from "../../src/theme.ts";
import { ComputerGone } from "../../src/nav/ComputerGone.tsx";

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

/** One issue as the mock draws it: what kind of thing it is, what it says, and
 *  the number that finds it. Closed ones are dimmed rather than hidden, so
 *  "did I close that?" is answerable in the All filter. */
function Row({ issue, now, onOpen }: {
  issue: IssueRow;
  now: number;
  onOpen: () => void;
}): React.ReactNode {
  const closed = issue.state.toLowerCase() === "closed";
  const first = issue.labels[0];
  return (
    <Pressable
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={`${closed ? "Closed" : "Open"} issue: ${issue.title}. #${issue.number}`}
      style={({ pressed }) => ({
        flexDirection: "row", alignItems: "center", gap: SPACE.md, minHeight: 60,
        paddingVertical: 11, paddingHorizontal: 14, borderRadius: RADIUS.lg, borderWidth: 1,
        borderColor: C.border, backgroundColor: pressed ? C.bg3 : C.bg2, opacity: closed ? 0.7 : 1,
      })}
    >
      {first ? <LabelChip name={first.name} color={first.color} /> : <Chip label={closed ? "closed" : "open"} />}
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Text numberOfLines={1} style={{ color: closed ? C.text2 : C.text, fontSize: 15, fontWeight: "600" }}>
          {issue.title}
        </Text>
        <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.small, fontFamily: MONO }}>
          #{issue.number}{issue.comments > 0 ? ` · ${issue.comments} ${issue.comments === 1 ? "comment" : "comments"}` : " · no comments"}
          {since(issue.updatedAt, now) ? ` · ${since(issue.updatedAt, now)}` : ""}
        </Text>
      </View>
      <Glyph name="down" color={C.text4} size={16} />
    </Pressable>
  );
}

/** The list, behind the card that says so when its computer is gone. */
export function IssueList({ search, searching, onSearch, onCloseSearch, onJira }: {
  /** The Tasks header's field, which this list is the subject of. */
  search: string;
  searching: boolean;
  onSearch: (text: string) => void;
  onCloseSearch: () => void;
  /** The board that also answers this repository, when the computer has one. */
  onJira?: () => void;
}): React.ReactNode {
  return (
    <ComputerGone>
      <IssuesListBody search={search} searching={searching} onSearch={onSearch} onCloseSearch={onCloseSearch} onJira={onJira} />
    </ComputerGone>
  );
}

function IssuesListBody({ search, searching, onSearch, onCloseSearch, onJira }: {
  search: string;
  searching: boolean;
  onSearch: (text: string) => void;
  onCloseSearch: () => void;
  onJira?: () => void;
}): React.ReactNode {
  usePaletteTick(); // a scene repaints only if it asks — see use-palette.ts
  const { host } = useAgentglass();
  const router = useRouter();
  const [repos, setRepos] = useState<GitRepoRef[] | null>(null);
  const [pick, setPick] = useState<string>(ALL);
  const [filter, setFilter] = useState<Filter>("mine");
  const [groups, setGroups] = useState<RepoGroup<IssueRow>[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pulling, setPulling] = useState(false);
  const [counts, setCounts] = useState<IssueViewCounts | null>(null);

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
      {searching ? (
        <View style={{ paddingHorizontal: SPACE.sm, paddingBottom: SPACE.sm }}>
          <SearchField
            value={search}
            onChange={onSearch}
            onClose={() => { onSearch(""); onCloseSearch(); }}
            placeholder="Search title, #number, label"
            label="Search issues"
          />
        </View>
      ) : null}
      <View style={{ paddingHorizontal: SPACE.md, paddingTop: SPACE.sm, paddingBottom: SPACE.sm }}>
        <Segmented value={filter} onChange={setFilter} options={filterOptions} />
      </View>
      {(repos?.length ?? 0) > 1 ? <FilterChips label="Repository" options={chips} value={pick} onChange={setPick} /> : null}

      <FlatList
        data={rows}
        keyExtractor={(row) => ("heading" in row ? `h:${row.heading}` : `${row.root}#${row.item.number}`)}
        contentContainerStyle={{ paddingHorizontal: SPACE.md, paddingTop: SPACE.sm, paddingBottom: SPACE.xl, gap: 6 }}
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
        ListFooterComponent={onJira ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open the Jira board"
            onPress={onJira}
            style={({ pressed }) => ({
              minHeight: 52, flexDirection: "row", alignItems: "center", gap: SPACE.sm, marginTop: SPACE.sm,
              paddingHorizontal: 14, borderRadius: RADIUS.lg, borderWidth: 1, borderStyle: "dashed",
              borderColor: C.border2, opacity: pressed ? 0.7 : 1,
            })}
          >
            <Chip label="Jira" tone="accent" />
            <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.small, flex: 1 }}>
              The board, also on for this repository
            </Text>
            <Text style={{ color: C.text2, fontSize: T.small, fontWeight: "600" }}>Open ›</Text>
          </Pressable>
        ) : (
          <Note>Issues come from each checkout's own GitHub remote.</Note>
        )}
        renderItem={({ item: row }) => (
          "heading" in row
            ? (
              <View style={{ flexDirection: "row", alignItems: "baseline", gap: SPACE.sm, paddingTop: SPACE.sm, paddingBottom: 2 }}>
                <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.eyebrow, fontWeight: "700", letterSpacing: 0.6, flex: 1 }}>
                  {(row.heading || "Issues").toUpperCase()} · {row.count}
                </Text>
                <Text style={{ color: C.text4, fontSize: T.small }}>newest first</Text>
              </View>
            )
            : (
              <Row
                issue={row.item}
                now={now}
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
