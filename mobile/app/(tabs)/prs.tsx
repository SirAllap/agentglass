/*
 * Pull requests, per repository.
 *
 * Three questions get answered on the row itself, because they are the ones
 * that decide whether you open it at all: is CI red, has somebody approved it,
 * and how big is it. A row that makes you tap to find out CI failed is a row
 * that sends you to a browser.
 *
 * The check rollup arrives on a SECOND pass — it costs about four times the
 * rest of the row — so a row that has not had it says "checks…" rather than
 * "no checks". Those are different claims and only one of them is true at that
 * moment.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { FlatList, Linking, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import type { GitRepoRef, PrSummary } from "../../../shared/types.ts";
import { ask } from "../../src/lib/api.ts";
import { useAgentglass } from "../../src/state/host-context.tsx";
import { usePaletteTick } from "../../src/state/use-palette.ts";
import { Card, Label, Note } from "../../src/ui.tsx";
import { mainCheckouts } from "../../src/model/prRows.ts";
import { since } from "../../src/lib/dates.ts";
import { C, MONO, RADIUS, SPACE, T } from "../../src/theme.ts";

type Filter = "mine" | "review" | "all";

const FILTERS: { id: Filter; label: string }[] = [
  // "review" first is deliberate: somebody is blocked on you in that one.
  { id: "review", label: "My review" },
  { id: "mine", label: "Mine" },
  { id: "all", label: "All" },
];

interface PrList {
  ok: boolean;
  error?: string;
  prs: PrSummary[];
  needsAuth?: boolean;
  loading?: boolean;
  total?: number;
}

/** What CI is saying, in one chip. Null when there is genuinely nothing to say. */
function checkChip(pr: PrSummary): { text: string; ink: string } | null {
  if (pr.checksLoaded === false) return { text: "checks…", ink: C.text4 };
  const { total, failure, pending, verdict } = pr.checks ?? { total: 0, failure: 0, pending: 0, verdict: null };
  if (!total) return null;
  if (failure > 0) return { text: `${failure} failed`, ink: C.error };
  if (pending > 0) return { text: `${pending} running`, ink: C.warning };
  if (verdict === "green") return { text: "green", ink: C.success };
  return null;
}

/** Approved, or blocked on a review. Draft outranks both — a draft is nobody's
 *  problem yet, and colouring it "review required" adds a queue entry that is
 *  not real. */
function reviewChip(pr: PrSummary): { text: string; ink: string } | null {
  if (pr.isDraft) return { text: "draft", ink: C.text4 };
  if (pr.reviewDecision === "APPROVED") return { text: "approved", ink: C.success };
  if (pr.reviewDecision === "CHANGES_REQUESTED") return { text: "changes asked", ink: C.error };
  if (pr.reviewDecision === "REVIEW_REQUIRED") return { text: "needs review", ink: C.warning };
  return null;
}

function Chip({ text, ink }: { text: string; ink: string }): React.ReactNode {
  return (
    <View style={{
      paddingHorizontal: SPACE.sm, paddingVertical: 2, borderRadius: RADIUS.sm,
      borderWidth: 1, borderColor: ink,
    }}>
      <Text style={{ color: ink, fontSize: T.eyebrow }}>{text}</Text>
    </View>
  );
}

function Row({ pr, now }: { pr: PrSummary; now: number }): React.ReactNode {
  const checks = checkChip(pr);
  const review = reviewChip(pr);
  return (
    <Pressable onPress={() => { if (pr.url) void Linking.openURL(pr.url); }}>
      <Card style={{ gap: SPACE.sm }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
          <Text style={{ color: C.text4, fontSize: T.eyebrow, fontFamily: MONO }}>#{pr.number}</Text>
          <Text style={{ color: C.text4, fontSize: T.eyebrow }}>{pr.author}</Text>
          <View style={{ flex: 1 }} />
          <Text style={{ color: C.text4, fontSize: T.eyebrow }}>{since(pr.updatedAt, now)}</Text>
        </View>

        <Text style={{ color: C.text, fontSize: T.body, lineHeight: 19 }}>{pr.title}</Text>

        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm, flexWrap: "wrap" }}>
          {review ? <Chip {...review} /> : null}
          {checks ? <Chip {...checks} /> : null}
          {/* Size, because "is this ten minutes or an afternoon" is the other
              thing that decides whether you open it now. */}
          <Text style={{ color: C.text4, fontSize: T.eyebrow, fontFamily: MONO }}>
            {pr.changedFiles}f <Text style={{ color: C.success }}>+{pr.additions}</Text>{" "}
            <Text style={{ color: C.error }}>−{pr.deletions}</Text>
          </Text>
        </View>

        <Text style={{ color: C.text4, fontSize: T.eyebrow, fontFamily: MONO }} numberOfLines={1}>
          {pr.headRefName} → {pr.baseRefName}
        </Text>
      </Card>
    </Pressable>
  );
}

export default function PrsScreen(): React.ReactNode {
  usePaletteTick(); // a scene repaints only if it asks — see use-palette.ts
  const { host } = useAgentglass();
  const [repos, setRepos] = useState<GitRepoRef[] | null>(null);
  const [root, setRoot] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("review");
  const [list, setList] = useState<PrList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pulling, setPulling] = useState(false);

  useEffect(() => {
    if (!host) return;
    void (async () => {
      const answer = await ask<{ repos: GitRepoRef[] }>(host, "/git/repos");
      if (!answer.ok) { setError(answer.error); return; }
      /*
       * One entry per REPOSITORY, not per checkout.
       *
       * Measured against the real machine: 23 checkouts, six of them linked
       * worktrees of one repository, each answering with the same 19 pull
       * requests. A strip of six identical-looking tabs showing identical
       * lists is not a choice — it is the same answer six times, and it pushes
       * every other repository off the screen.
       *
       * `mainCheckouts` is the browser companion's, already tested: it drops a
       * worktree whose main checkout is present and KEEPS one whose main
       * checkout is not, because that repository's pull requests have to come
       * from somewhere.
       */
      const found = mainCheckouts(Array.isArray(answer.value.repos) ? answer.value.repos : []);
      setRepos(found);
      // Most recently touched first is what `/git/repos` already answers with,
      // so the default is the repository you were last in.
      setRoot((current) => current ?? found[0]?.root ?? null);
    })();
  }, [host]);

  const load = useCallback(async (): Promise<void> => {
    if (!host || !root) return;
    const query = `root=${encodeURIComponent(root)}&filter=${filter}&state=open`;
    const answer = await ask<PrList>(host, `/prs/list?${query}`);
    if (!answer.ok) { setError(answer.error); setList(null); return; }
    setError(null);
    setList(answer.value);
  }, [host, root, filter]);

  useEffect(() => { setList(null); void load(); }, [load]);

  // The check rollup lands on a second pass, so one re-read a moment later is
  // the difference between "checks…" forever and the row settling.
  useEffect(() => {
    if (!list?.loading) return;
    const timer = setTimeout(() => { void load(); }, 2500);
    return () => clearTimeout(timer);
  }, [list?.loading, load]);

  const onRefresh = useCallback((): void => {
    setPulling(true);
    void load().finally(() => setPulling(false));
  }, [load]);

  const prs = useMemo(() => (Array.isArray(list?.prs) ? list.prs : []), [list]);
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
                <Text style={{ color: C.text4, fontSize: T.eyebrow, fontFamily: MONO }} numberOfLines={1}>
                  {repo.branch}
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
        data={prs}
        keyExtractor={(pr) => String(pr.number)}
        contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md, paddingBottom: SPACE.xl }}
        refreshControl={<RefreshControl refreshing={pulling} onRefresh={onRefresh} tintColor={C.text3} />}
        ListEmptyComponent={
          list === null && !error ? null : (
            <Card>
              <Label text={error || list?.error ? "Cannot ask GitHub" : "Nothing open"} />
              <Note tone={error || list?.error ? "bad" : "quiet"}>
                {error
                  ?? list?.error
                  ?? (list?.needsAuth
                    ? "GitHub has not been signed in to on the computer — run `gh auth login` there."
                    : "No open pull request matches this filter in this repository.")}
              </Note>
            </Card>
          )
        }
        renderItem={({ item }) => <Row pr={item} now={now} />}
      />
    </View>
  );
}
