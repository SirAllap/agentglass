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
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { FlatList, Linking, Pressable, RefreshControl, Text, View } from "react-native";
import { useNavigation } from "expo-router";
import type { GitRepoRef, PrSummary } from "../../../shared/types.ts";
import { ask } from "../../src/lib/api.ts";
import { useAgentglass } from "../../src/state/host-context.tsx";
import { usePaletteTick } from "../../src/state/use-palette.ts";
import { Card, HeaderPick, Label, Note, Segmented, Sheet, SheetRow } from "../../src/ui.tsx";
import { mainCheckouts } from "../../src/model/prRows.ts";
import { since } from "../../src/lib/dates.ts";
import { C, MONO, RADIUS, SPACE, T } from "../../src/theme.ts";

type Filter = "mine" | "review" | "all";

/** "review" first is deliberate: somebody is blocked on you in that one. */
const FILTERS: Filter[] = ["review", "mine", "all"];
const FILTER_LABEL: Record<Filter, string> = {
  review: "My review",
  mine: "Mine",
  all: "All",
};

interface PrList {
  ok: boolean;
  error?: string;
  prs: PrSummary[];
  needsAuth?: boolean;
  loading?: boolean;
  total?: number;
}

/** What `/prs/counts` answers with.
 *
 *  Declared here rather than imported, the same way `PrList` above is, because
 *  the server's copy lives in `server/src/prs.ts` and not in `shared/types.ts`
 *  — this app compiles against the shared wire types and nothing else. The one
 *  field this screen reads is named after a filter, which is what keeps the two
 *  in step: a rename on either side stops matching `FILTERS`. */
interface PrViewCounts { review: number; mine: number; failing: number; ready: number; all: number }

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
  const navigation = useNavigation();
  const [repos, setRepos] = useState<GitRepoRef[] | null>(null);
  const [root, setRoot] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [filter, setFilter] = useState<Filter>("review");
  const [list, setList] = useState<PrList | null>(null);
  /**
   * The five numbers behind the segmented control.
   *
   * `/prs/counts` answers all of them in ONE GraphQL call and caches it, which
   * is the whole reason the control can carry counts at all: the alternative
   * was three list requests to label three segments.
   *
   * Null while it has not answered, and the control simply draws no numbers —
   * a zero on "My review" that means "we have not asked" is the kind of lie
   * this app spends comments avoiding elsewhere.
   */
  const [counts, setCounts] = useState<PrViewCounts | null>(null);
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

  // Counts follow the repository and not the filter — they are the counts OF
  // the filters, so re-asking when one is tapped would be asking the same
  // question again.
  useEffect(() => {
    if (!host || !root) return;
    let gone = false;
    setCounts(null);
    void (async () => {
      const answer = await ask<{ ok: boolean; counts?: PrViewCounts }>(
        host, `/prs/counts?root=${encodeURIComponent(root)}&state=open`,
      );
      if (gone || !answer.ok || !answer.value.ok) return;
      setCounts(answer.value.counts ?? null);
    })();
    return () => { gone = true; };
  }, [host, root]);

  const repo = repos?.find((r) => r.root === root) ?? null;

  /*
   * The repository moved into the header, and the strip under it is gone.
   *
   * setOptions rather than an inline options prop, for the reason the old
   * Review screen wrote down: that component's effect keys on the options
   * OBJECT, so a literal is a fresh reference every render and calls
   * setOptions on each one. This fires when the name changes and not
   * otherwise. The closure reads the palette at header render time, so a theme
   * change still repaints it.
   */
  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitleAlign: "center",
      headerTitle: () => (
        <HeaderPick label={repo?.name ?? "Pull requests"} onPress={() => setPicking(true)} />
      ),
    });
  }, [navigation, repo?.name]);

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
      <View style={{ paddingHorizontal: SPACE.lg, paddingTop: SPACE.md }}>
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

      <Sheet open={picking} onClose={() => setPicking(false)} title="Repository">
        {(repos ?? []).map((r) => (
          <SheetRow
            key={r.root}
            label={r.name}
            sub={`${r.branch}${r.ahead ? ` · ${r.ahead} to push` : ""}${r.behind ? ` · ${r.behind} behind` : ""}`}
            on={r.root === root}
            onPress={() => { setRoot(r.root); setPicking(false); }}
          />
        ))}
        {/* Said once, at the bottom, because a list of twenty-three that has
            silently become nine needs to account for the fourteen. */}
        <View style={{ paddingTop: SPACE.md }}>
          <Note>
            Worktrees are folded into the repository they belong to — several checkouts of one
            repository answer with the same pull requests.
          </Note>
        </View>
      </Sheet>

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
