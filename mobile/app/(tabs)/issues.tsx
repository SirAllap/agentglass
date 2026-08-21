/*
 * Issues, per repository.
 *
 * The screen this app never had. `/issues/list` has been answering on the
 * machine the whole time and nothing on the phone ever asked it — so the one
 * kind of work that arrives without a branch behind it was the one kind you
 * could not see from a sofa.
 *
 * Two things get answered on the row itself, because between them they decide
 * whether to open it: whether anybody has STARTED it, and which pull request
 * will close it. An issue nobody has picked up is the one worth reading now;
 * one with a pull request against it is somebody else's afternoon.
 *
 * The strip and the filter row are `prs.tsx`'s, deliberately unchanged. They
 * are the wrong shape — two horizontal scrollers spend 150 points above the
 * first card — and they are wrong in the same way on three screens, so they
 * are worth fixing in one sweep rather than diverging here first.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import type { GitRepoRef, IssueRow, IssuesReport } from "../../../shared/types.ts";
import { ask } from "../../src/lib/api.ts";
import { useAgentglass } from "../../src/state/host-context.tsx";
import { usePaletteTick } from "../../src/state/use-palette.ts";
import { Card, Label, Note } from "../../src/ui.tsx";
import { mainCheckouts } from "../../src/model/prRows.ts";
import { since } from "../../src/lib/dates.ts";
import { C, MONO, RADIUS, SPACE, T } from "../../src/theme.ts";

type Filter = "mine" | "open" | "all";

const FILTERS: { id: Filter; label: string }[] = [
  // Yours first, for the same reason "My review" leads the pull requests: it
  // is the only one of the three that is about you.
  { id: "mine", label: "Mine" },
  { id: "open", label: "Open" },
  { id: "all", label: "All" },
];

/** A label, in the colour the repository gave it, with a floor.
 *
 *  GitHub stores these as six hex digits and no `#`, and some of them are
 *  chosen against a white page — the same problem the board's statuses have in
 *  tasks.tsx, solved the same way rather than a second way. */
function labelInk(hex: string): string {
  const clean = (hex || "").replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return C.text3;
  return `#${clean}`;
}

function Row({ issue, now, onOpen }: {
  issue: IssueRow;
  now: number;
  onOpen: () => void;
}): React.ReactNode {
  const closed = issue.state.toLowerCase() === "closed";
  return (
    <Pressable onPress={onOpen} accessibilityRole="button">
      <Card style={{ gap: SPACE.sm }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
          {/* A ring for open, a filled one for closed. A letter would be
              wrong here — the state is binary and the shape carries it — but
              colour alone would not: see the dot rules in repos.tsx. */}
          <View style={{
            width: 9, height: 9, borderRadius: 5,
            borderWidth: 1.5, borderColor: closed ? C.text4 : C.success,
            backgroundColor: closed ? C.text4 : "transparent",
          }} />
          <Text style={{ color: C.text4, fontSize: T.eyebrow, fontFamily: MONO }}>#{issue.number}</Text>
          <Text style={{ color: C.text4, fontSize: T.eyebrow }}>{issue.author}</Text>
          <View style={{ flex: 1 }} />
          <Text style={{ color: C.text4, fontSize: T.eyebrow }}>{since(issue.updatedAt, now)}</Text>
        </View>

        <Text style={{ color: C.text, fontSize: T.body, lineHeight: 19 }}>{issue.title}</Text>

        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm, flexWrap: "wrap" }}>
          {issue.labels.slice(0, 3).map((l) => {
            const ink = labelInk(l.color);
            return (
              <View
                key={l.name}
                style={{
                  paddingHorizontal: SPACE.sm, paddingVertical: 2, borderRadius: RADIUS.sm,
                  borderWidth: 1, borderColor: ink,
                }}
              >
                <Text style={{ color: ink, fontSize: T.eyebrow }}>{l.name}</Text>
              </View>
            );
          })}
          {/* The one thing a row can say that the title cannot: whether this is
              still nobody's. `work` lives on the detail, so the row uses what
              it has — an assignee is the cheapest honest proxy for it. */}
          {issue.assignees.length === 0 ? (
            <Text style={{ color: C.text4, fontSize: T.eyebrow }}>nobody has picked it up</Text>
          ) : (
            <Text style={{ color: C.text4, fontSize: T.eyebrow }}>{issue.assignees.join(", ")}</Text>
          )}
          {issue.comments > 0 ? (
            <Text style={{ color: C.text4, fontSize: T.eyebrow, fontFamily: MONO }}>
              {issue.comments}c
            </Text>
          ) : null}
        </View>
      </Card>
    </Pressable>
  );
}

export default function IssuesScreen(): React.ReactNode {
  usePaletteTick(); // a scene repaints only if it asks — see use-palette.ts
  const { host } = useAgentglass();
  const router = useRouter();
  const [repos, setRepos] = useState<GitRepoRef[] | null>(null);
  const [root, setRoot] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("mine");
  const [list, setList] = useState<IssuesReport | null>(null);
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
      const found = mainCheckouts(Array.isArray(answer.value.repos) ? answer.value.repos : []);
      setRepos(found);
      setRoot((current) => current ?? found[0]?.root ?? null);
    })();
  }, [host]);

  const load = useCallback(async (): Promise<void> => {
    if (!host || !root) return;
    // `@me` is gh's own spelling and the server passes it through to
    // `gh issue list --assignee`, so the phone does not need to know who you
    // are — which it otherwise would have to ask for and keep in step.
    const query = `root=${encodeURIComponent(root)}`
      + (filter === "mine" ? "&assignee=%40me&state=open" : filter === "all" ? "&state=all" : "&state=open");
    const answer = await ask<IssuesReport>(host, `/issues/list?${query}`);
    if (!answer.ok) { setError(answer.error); setList(null); return; }
    setError(null);
    setList(answer.value);
  }, [host, root, filter]);

  useEffect(() => { setList(null); void load(); }, [load]);

  const onRefresh = useCallback((): void => {
    setPulling(true);
    void load().finally(() => setPulling(false));
  }, [load]);

  const issues = useMemo(() => (Array.isArray(list?.issues) ? list.issues : []), [list]);
  const now = Date.now();

  if (!host) return null;

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={{ borderBottomWidth: 1, borderBottomColor: C.border }}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: SPACE.sm, paddingVertical: SPACE.sm, gap: SPACE.xs }}
        >
          {(repos ?? []).map((repo) => {
            const on = repo.root === root;
            return (
              <Pressable
                key={repo.root}
                onPress={() => setRoot(repo.root)}
                style={{
                  paddingHorizontal: SPACE.md, minHeight: 44, justifyContent: "center",
                  borderRadius: RADIUS.md,
                  backgroundColor: on ? C.bg3 : "transparent",
                  borderWidth: 1, borderColor: on ? C.border2 : "transparent",
                }}
              >
                <Text style={{ color: on ? C.text : C.text3, fontSize: T.small, fontWeight: on ? "600" : "400" }}>
                  {repo.name}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      <View style={{
        flexDirection: "row", gap: SPACE.xs, paddingHorizontal: SPACE.lg, paddingVertical: SPACE.sm,
        borderBottomWidth: 1, borderBottomColor: C.border,
      }}>
        {FILTERS.map((f) => {
          const on = f.id === filter;
          return (
            <Pressable
              key={f.id}
              onPress={() => setFilter(f.id)}
              style={{
                paddingHorizontal: SPACE.md, minHeight: 36, justifyContent: "center",
                borderRadius: RADIUS.sm, backgroundColor: on ? C.bg3 : "transparent",
              }}
            >
              <Text style={{ color: on ? C.text : C.text4, fontSize: T.small }}>{f.label}</Text>
            </Pressable>
          );
        })}
      </View>

      <FlatList
        data={issues}
        keyExtractor={(issue) => String(issue.number)}
        contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md, paddingBottom: SPACE.xl }}
        refreshControl={<RefreshControl refreshing={pulling} onRefresh={onRefresh} tintColor={C.text3} />}
        ListEmptyComponent={
          list === null && !error ? null : (
            <Card>
              <Label text={error || list?.error ? "Cannot ask GitHub" : "Nothing open"} />
              <Note tone={error || list?.error ? "bad" : "quiet"}>
                {error
                  ?? list?.error
                  ?? (filter === "mine"
                    ? "No open issue is assigned to you in this repository."
                    : "No issue matches this filter in this repository.")}
              </Note>
            </Card>
          )
        }
        renderItem={({ item }) => (
          <Row
            issue={item}
            now={now}
            // The object form, not a built string: a checkout path is full of
            // characters a URL segment has opinions about, and `root` is one.
            onOpen={() => router.push({
              pathname: "/issue/[number]",
              params: { number: String(item.number), root: root ?? "" },
            })}
          />
        )}
      />
    </View>
  );
}
