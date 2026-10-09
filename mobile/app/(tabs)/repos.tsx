/*
 * The working tree, from a sofa.
 *
 * Every checkout, not one per repository — and that is the opposite of the
 * rule the pull-request screen follows, deliberately. Linked worktrees of one
 * repository answer with the SAME pull requests, so asking six of them draws
 * one card six times; but each has its OWN uncommitted work, so collapsing
 * them would hide exactly the thing this screen exists to show.
 *
 * A switch per file IS the staging — there is no separate "add" step, because
 * on a phone a two-step commit is a step people forget half of. Then a title
 * and Commit, and Push if the branch is ahead.
 *
 * Writing needs the `full` scope. A phone paired to answer gates gets the list
 * and no buttons, which is the honest shape: the grant was chosen at the
 * computer by somebody looking at the request.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator, FlatList, KeyboardAvoidingView, Pressable, RefreshControl, ScrollView, Text, TextInput, View,
  type RefreshControlProps,
} from "react-native";
import * as Haptics from "expo-haptics";
import { useHeaderHeight } from "expo-router/react-navigation";
import type { GitBranch, GitCommit, GitRepoRef, GitStash, PrBranchSummary, RepoStatus } from "../../../shared/types.ts";
import { ask } from "../../src/lib/api.ts";
import { useAgentglass } from "../../src/state/host-context.tsx";
import { usePaletteTick } from "../../src/state/use-palette.ts";
import { Btn, Card, Chip, Label, Note, Segmented, Sheet, TAP, groupEdge } from "../../src/ui.tsx";
import { C, MONO, RADIUS, SPACE, T, ink, tint } from "../../src/theme.ts";
import { useFocusEffect, useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { ChevronIcon } from "../../src/nav/icons.tsx";
import { branchLookup, checkoutFor } from "../../src/model/checkout.ts";
import { keepOrder, newBranchProblem, orderBranches, scmSuccessText, stashTitle, trackWords, VIEWS, type ScmView } from "../../src/model/scm.ts";
import { Glyph } from "../../src/nav/glyphs.tsx";
import { ReposIcon } from "../../src/nav/icons.tsx";
import { PullHint, StatusBadge, mark } from "../../src/git-ui.tsx";
import { parseRefs, pushState, switchWarning, unpushedHashes } from "../../src/model/gitReview.ts";

/** One pull request, as a row that opens the detail this app already has.
 *
 *  A link out to GitHub was the alternative and it is the thing this whole
 *  branch of work removed: the pull request screen reads the body, the checks,
 *  the files and the threads, and arriving at it from the checkout you are
 *  standing in is the shortest path there is. */
function PrLine({ pr, root, router, first, last }: {
  pr: PrBranchSummary;
  root: string | null;
  router: ReturnType<typeof useRouter>;
  first: boolean;
  last: boolean;
}): React.ReactNode {
  const tint = pr.isDraft ? C.text4
    : pr.reviewDecision === "APPROVED" ? C.success
    : pr.reviewDecision === "CHANGES_REQUESTED" ? C.error
    : C.text3;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.push({
        pathname: "/pr/[number]",
        params: { number: String(pr.number), root: root ?? "" },
      })}
      style={({ pressed }) => [
        groupEdge(first, last),
        {
          flexDirection: "row", alignItems: "center", gap: SPACE.md,
          paddingHorizontal: SPACE.lg, paddingVertical: SPACE.md,
          opacity: pressed ? 0.6 : 1,
        },
      ]}
    >
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text numberOfLines={2} style={{ color: C.text, fontSize: T.small }}>{pr.title}</Text>
        <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.eyebrow, fontFamily: MONO }}>
          #{pr.number} · {pr.author} · {pr.headRefName} → {pr.baseRefName}
        </Text>
      </View>
      <Text style={{ color: tint, fontSize: T.eyebrow }}>
        {pr.isDraft ? "draft"
          : pr.reviewDecision === "APPROVED" ? "approved"
          : pr.reviewDecision === "CHANGES_REQUESTED" ? "changes"
          : pr.state.toLowerCase()}
      </Text>
      <ChevronIcon color={C.text4} size={17} />
    </Pressable>
  );
}

/** What `/prs/for-branch` answers with. Declared here rather than in shared/
 *  for the same reason PrViewCounts is — it is one route's reply and nothing
 *  else reads it. `needsAuth` is deliberately its own field: "gh is logged
 *  out" and "there is no pull request for this branch" are different answers
 *  and were once the same silence. */
interface BranchPrs {
  ok: boolean;
  repo?: string;
  from?: PrBranchSummary;
  into: PrBranchSummary[];
  needsAuth?: boolean;
  /** Said here, without asking GitHub: there was nothing to ask about. */
  local?: boolean;
  error?: string;
}

export default function ReposScreen(): React.ReactNode {
  usePaletteTick(); // a scene repaints only if it asks — see use-palette.ts
  const { host } = useAgentglass();
  /** The checkout it was opened for — the terminal passes the pane's own
   *  directory. See model/checkout.ts for why this is not `found[0]`. */
  const asked = useLocalSearchParams<{ root?: string }>().root || null;
  const [repos, setRepos] = useState<GitRepoRef[] | null>(null);
  const [root, setRoot] = useState<string | null>(null);
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [commitEnabled, setCommitEnabled] = useState(true);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const [pulling, setPulling] = useState(false);
  /** The server answered, and the directory is in no repository. */
  const [noRepo, setNoRepo] = useState(false);
  /** The chip strip scrolls; the checkout in use must not sit off its edge. */
  const strip = useRef<ScrollView>(null);
  const chipAt = useRef(new Map<string, number>());
  /** The checkout the strip was last scrolled to, so a resize does not undo a manual scroll. */
  const revealed = useRef<string | null>(null);
  const reveal = useCallback((at: string, animated: boolean): void => {
    strip.current?.scrollTo({ x: Math.max(0, (chipAt.current.get(at) ?? 0) - SPACE.lg), animated });
  }, []);
  const router = useRouter();
  /*
   * Views of one checkout, which is the shape a person already has in their
   * head: what I have changed, what I have landed, where I can go, what I put
   * aside, and what is waiting to be reviewed. The server has answered all of
   * them the whole time; see model/scm.ts for what is deliberately not here.
   */
  const [view, setView] = useState<ScmView>("changes");
  const [commits, setCommits] = useState<GitCommit[] | null>(null);
  const [branches, setBranches] = useState<GitBranch[] | null>(null);
  const [stashes, setStashes] = useState<GitStash[] | null>(null);
  const [newName, setNewName] = useState("");
  /** The branch a switch is waiting to confirm, while the tree has changes. */
  const [switching, setSwitching] = useState<string | null>(null);
  const [branchPrs, setBranchPrs] = useState<BranchPrs | null>(null);

  const mayWrite = host?.scope === "full";

  useEffect(() => {
    if (!host) return;
    void (async () => {
      const answer = await ask<{ repos: GitRepoRef[] }>(host, "/git/repos");
      if (!answer.ok) { setSaid({ ok: false, text: answer.error }); return; }
      const found = Array.isArray(answer.value.repos) ? answer.value.repos : [];
      setRepos(found);
      const roots = found.map((r) => r.root);
      setRoot((current) => (asked ? checkoutFor(asked, roots) : current ?? found[0]?.root ?? null));
    })();
  }, [host, asked]);

  /** The chip strip and the branch line read /git/repos, which a checkout or a
   *  new branch has just made stale. Only the list is replaced: the choice of
   *  checkout stays where the person put it. */
  const refreshRepos = useCallback(async (): Promise<void> => {
    if (!host) return;
    const answer = await ask<{ repos: GitRepoRef[] }>(host, "/git/repos");
    if (!answer.ok || !Array.isArray(answer.value.repos)) return;
    const fresh = answer.value.repos;
    // The server orders by recent activity, so a write would shuffle the chip
    // under the finger. Keep the order the person was already looking at.
    setRepos((prev) => (prev ? keepOrder(prev, fresh) : fresh));
  }, [host]);

  /** The checkout the answers below belong to. A late answer for the one you
   *  just left must not fill the list of the one you are on. */
  const at = useRef(root);
  at.current = root;

  const loadLog = useCallback(async (): Promise<void> => {
    if (!host || !root) return;
    const answer = await ask<{ commits?: GitCommit[] }>(
      host, `/git/log?root=${encodeURIComponent(root)}&limit=40`,
    );
    if (at.current !== root) return;
    setCommits(answer.ok ? answer.value.commits ?? [] : []);
  }, [host, root]);

  /** The branches, and with them what the header needs to say whether the
   *  current one has anywhere to push to. A branch that was never pushed has no
   *  upstream and reads as 0 ahead, so for that one — and only that one — the
   *  log is read too: what a push would send is the commits no remote has. */
  const loadBranches = useCallback(async (): Promise<void> => {
    if (!host || !root) return;
    const answer = await ask<{ branches?: GitBranch[] }>(host, `/git/branches?root=${encodeURIComponent(root)}`);
    if (at.current !== root) return;
    if (!answer.ok) { setSaid({ ok: false, text: answer.error }); setBranches([]); return; }
    const list = answer.value.branches ?? [];
    setBranches(list);
    const here = list.find((b) => b.current);
    if (here && (!here.upstream || /gone/.test(here.track))) await loadLog();
  }, [host, root, loadLog]);

  /** The head of the checkout, read from git itself. The branch on the header
   *  used to come from the repository list — a cache that a checkout made at
   *  the computer, or by an agent, left a minute out of date. */
  const loadStatus = useCallback(async (): Promise<void> => {
    if (!host || !root) return;
    const answer = await ask<{ repos: RepoStatus[]; commitEnabled: boolean }>(host, "/git/status", {
      method: "POST",
      // A path, not a repository name: this route takes the directories to look
      // at, which is what makes it answer for a worktree rather than for the
      // repository the worktree belongs to.
      body: { paths: [root] },
    });
    if (at.current !== root) return;
    if (!answer.ok) { setSaid({ ok: false, text: answer.error }); return; }
    setCommitEnabled(answer.value.commitEnabled !== false);
    const first = Array.isArray(answer.value.repos) ? answer.value.repos[0] ?? null : null;
    setStatus(first);
    setNoRepo(first === null);
  }, [host, root]);

  const load = useCallback(async (): Promise<void> => {
    await Promise.all([loadStatus(), loadBranches()]);
  }, [loadStatus, loadBranches]);

  useEffect(() => { setStatus(null); setNoRepo(false); setTitle(""); }, [root]);
  useEffect(() => { setCommits(null); setBranches(null); setStashes(null); setBranchPrs(null); setNewName(""); }, [root]);
  /* On focus, not on mount: a tab stays mounted behind the diff and the
     terminal, so a branch checked out or a file committed while you were away
     would otherwise be what this screen goes on saying until a write of its own. */
  useFocusEffect(useCallback(() => { void load(); void refreshRepos(); }, [load, refreshRepos]));

  /*
   * The other views, fetched only when they are LOOKED at.
   *
   * Each costs a round trip and none is the view this screen opens on, so
   * asking for all of them up front would spend requests per checkout switch
   * to fill panels nobody has turned to. They are cleared when the checkout
   * changes, because a commit list belonging to another worktree drawn under
   * this one's name is the worst kind of wrong here: it is plausible.
   */

  useEffect(() => { if (view === "log" && commits === null) void loadLog(); }, [view, commits, loadLog]);
  useEffect(() => { if (view === "branches" && branches === null) void loadBranches(); }, [view, branches, loadBranches]);

  const loadStashes = useCallback(async (): Promise<void> => {
    if (!host || !root) return;
    const answer = await ask<{ stashes?: GitStash[] }>(host, `/git/stashes?root=${encodeURIComponent(root)}`);
    if (at.current !== root) return;
    if (!answer.ok) { setSaid({ ok: false, text: answer.error }); setStashes([]); return; }
    setStashes(answer.value.stashes ?? []);
  }, [host, root]);
  useEffect(() => { if (view === "stash" && stashes === null) void loadStashes(); }, [view, stashes, loadStashes]);

  const loadPrs = useCallback(async (): Promise<void> => {
    if (!host || !root) return;
    const look = branchLookup(status?.branch);
    if (!look.ask) {
      if (look.reason) setBranchPrs({ ok: false, into: [], local: true, error: look.reason });
      return;
    }
    const answer = await ask<BranchPrs>(
      host,
      `/prs/for-branch?root=${encodeURIComponent(root)}&branch=${encodeURIComponent(look.branch)}`,
    );
    if (at.current !== root) return;
    setBranchPrs(answer.ok ? answer.value : { ok: false, into: [], error: answer.error });
  }, [host, root, status?.branch]);
  useEffect(() => { if (view === "pr" && branchPrs === null) void loadPrs(); }, [view, branchPrs, loadPrs]);

  /** Every git write goes through here so there is one place that reports, one
   *  that re-reads, and one that cannot be pressed twice. */
  const act = useCallback(async (
    what: string, path: string, body: Record<string, unknown>,
    successInfo?: { files?: number; branch?: string; index?: number },
  ): Promise<void> => {
    if (!host) return;
    setBusy(what);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const answer = await ask<{ ok: boolean; error?: string }>(host, path, { method: "POST", body });
    setBusy(null);
    if (!answer.ok) { setSaid({ ok: false, text: answer.error }); return; }
    if (!answer.value.ok) { setSaid({ ok: false, text: answer.value.error ?? "git refused that" }); return; }
    const text = successInfo ? scmSuccessText(path, successInfo) : null;
    setSaid(text ? { ok: true, text } : null);
    // Staging moves neither the branches, the log, the stash nor the pull
    // request (a GitHub round trip), so it re-reads only the file list — and
    // leaves the log alone, which is what Push's count is made from.
    if (path === "/git/stage" || path === "/git/unstage") { await loadStatus(); return; }
    // What any other write can have moved. Cleared, not patched, so the view
    // that is open asks again.
    setBranches(null); setStashes(null); setCommits(null); setBranchPrs(null);
    await Promise.all([load(), refreshRepos()]);
  }, [host, load, loadStatus, refreshRepos]);

  const files = useMemo(() => status?.files ?? [], [status]);
  const staged = useMemo(() => files.filter((f) => f.staged), [files]);
  /** Null until git has answered: the confirm treats that as unknown, not as clean. */
  const dirtyCount = status ? files.length : null;

  const repo = repos?.find((r) => r.root === root) ?? null;
  /** The branch as git said it just now; the repository list's copy is only
   *  the fallback for the moment before the first answer. */
  const branchName = status?.branch ?? repo?.branch ?? null;
  const here = useMemo(() => branches?.find((b) => b.current) ?? null, [branches]);
  /** What Push can do. Until the branches have been read it cannot say, and a
   *  button that guesses "enabled" is the one that pushes the wrong thing. */
  const push = useMemo(() => pushState(here, commits), [here, commits]);
  const unpushed = useMemo(() => (here && !here.upstream && commits ? unpushedHashes(commits) : null), [here, commits]);
  /** What the dim Commit and Push buttons are waiting for, said once. The Push
   *  line is only for when it is the ONLY thing missing, so "nothing to push"
   *  does not crowd out what Commit needs while a commit is being written. */
  const commitNeeds = !staged.length ? "Stage a file to commit it."
    : !title.trim() ? "Write what this commit does." : null;
  const pushNeeds = branches && !push.canPush && push.ahead === 0 && !commitNeeds
    ? "Nothing to push: no commits ahead of the remote." : null;

  /** One refresh for every tab: the pull gesture, the spinner and the reset
   *  live here so a fifth list cannot be added without one. */
  const pullWith = (fn: () => Promise<unknown>): React.ReactElement<RefreshControlProps> => (
    <RefreshControl
      refreshing={pulling}
      onRefresh={() => { setPulling(true); void fn().finally(() => setPulling(false)); }}
      tintColor={C.text3}
    />
  );

  /* Browsing the checkout, from the screen that already knows which one you
     are in. In the header rather than as a fourth segment: the three segments
     are views of one question — what has changed here — and a file browser is
     a different errand that happens to start from the same place. */
  const navigation = useNavigation();
  const headerHeight = useHeaderHeight();
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Browse the files"
          disabled={!root}
          onPress={() => router.push({ pathname: "/files", params: { root: root ?? "" } })}
          style={({ pressed }) => ({
            width: TAP, height: TAP, marginRight: SPACE.xs, borderRadius: TAP / 2,
            alignItems: "center", justifyContent: "center",
            backgroundColor: pressed ? C.bg3 : "transparent", opacity: root ? 1 : 0.4,
          })}
        >
          <ReposIcon color={C.text2} size={22} />
        </Pressable>
      ),
    });
  }, [navigation, root, router]);

  if (!host) return null;

  const newProblem = newName.trim() ? newBranchProblem(newName, branches ?? []) : null;

  const chips = (
    <>
      {/* The checkouts, as chips: the one this screen is about is filled and
          ticked, and a dot marks uncommitted work — "there is something to
          commit here" is the thing you scan twenty checkouts for. */}
      <ScrollView
        ref={strip}
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0 }}
        contentContainerStyle={{ paddingHorizontal: SPACE.lg, paddingTop: SPACE.xs, gap: SPACE.sm }}
      >
        {(repos ?? []).map((r) => {
          const on = r.root === root;
          return (
            <Pressable
              key={r.root}
              onLayout={(e) => {
                chipAt.current.set(r.root, e.nativeEvent.layout.x);
                if (r.root === root && revealed.current !== root) { revealed.current = root; reveal(root, false); }
              }}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              accessibilityLabel={`${r.name}${r.dirty ? ", has changes" : ""}`}
              onPress={() => { revealed.current = r.root; setRoot(r.root); reveal(r.root, true); }}
              hitSlop={{ top: 6, bottom: 6 }}
              style={({ pressed }) => ({
                flexDirection: "row", alignItems: "center", gap: 6, height: 36, paddingHorizontal: 12,
                borderRadius: RADIUS.sm, backgroundColor: on ? tint(C.primary, 0.16) : "transparent",
                borderWidth: 1, borderColor: on ? "transparent" : C.border2,
                transform: [{ scale: pressed ? 0.97 : 1 }],
              })}
            >
              {on ? <Glyph name="check" color={C.primary} size={16} weight={2.4} /> : null}
              <Text style={{ color: on ? C.primary : C.text2, fontSize: 13, fontWeight: on ? "600" : "500" }}>{r.name}</Text>
              {r.dirty ? <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: C.warning }} /> : null}
            </Pressable>
          );
        })}
      </ScrollView>
    </>
  );

  if (noRepo) {
    return (
      <View style={{ flex: 1, backgroundColor: C.bg }}>
        {chips}
        <View style={{ padding: SPACE.lg }}>
          <Card>
            <Label text="Not a repository" />
            <Note>This folder is not in a git repository, so there is nothing to commit or compare. The folder button above still browses it.</Note>
          </Card>
        </View>
      </View>
    );
  }

  return (
    // The commit footer (message field + Commit/Push) sits below the file
    // list rather than pinned, so a screen-level avoider is what raises it —
    // unlike Sheet, this screen is not inside a Modal. "padding": the footer
    // itself has a fixed height, so there is nothing to resize, only room to
    // make above the keyboard.
    //
    // The offset is the header. The avoider pads by `frame.y + frame.height -
    // keyboardTop`, and its frame is measured from the top of the scene, which
    // starts BELOW this screen's header — so without it the padding came out
    // one header short and the footer stopped just under the keyboard's top
    // edge (measured: footer top at y≈1476, keyboard from y≈1510, 1080x2400).
    // The terminal needs none because it hides its header.
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: C.bg }}
      behavior="padding"
      keyboardVerticalOffset={headerHeight}
    >
      {chips}

      {/* Where you are in it: the branch, and what is waiting to go up or come
          down. It was the second line of every chip, which made each chip two
          lines tall and the strip the tallest thing on the screen. */}
      {branchName ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm, paddingHorizontal: SPACE.lg, paddingVertical: SPACE.md }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`On branch ${branchName}. Show the branches`}
            hitSlop={{ top: 6, bottom: 6 }}
            onPress={() => { setSaid(null); setView("branches"); }}
            style={({ pressed }) => ({
              flexShrink: 1, flexDirection: "row", alignItems: "center", gap: SPACE.sm, height: 36,
              paddingHorizontal: SPACE.md, borderRadius: RADIUS.md, borderWidth: 1, borderColor: C.border2,
              backgroundColor: pressed ? C.bg3 : C.bg2,
            })}
          >
            <Glyph name="branch" color={C.text3} size={16} />
            <Text numberOfLines={1} style={{ color: C.text, fontSize: 13, fontWeight: "500", fontFamily: MONO, flexShrink: 1 }}>
              {branchName}
            </Text>
          </Pressable>
          {push.chip ? <Chip label={push.chip} tone="accent" icon={<Glyph name="up" color={C.primary} size={13} weight={2.4} />} /> : null}
          {repo?.behind ? <Chip label={`↓${repo.behind} behind`} tone="warn" /> : null}
        </View>
      ) : null}

      {/* One control, full width, at the tap floor — the same `Segmented` the
          pull requests and the cards use. Counts where there is one to give:
          "Changes 6" is the reason to press it, and a bare word is not. */}
      <View style={{ paddingHorizontal: SPACE.lg, paddingTop: SPACE.md }}>
        <Segmented
          value={view}
          onChange={(next) => { setSaid(null); setView(next); }}
          options={VIEWS.map((v) => ({ id: v.id, label: v.label, count: v.id === "changes" ? files.length || undefined : undefined }))}
        />
      </View>

      {said ? (
        <View style={{ paddingHorizontal: SPACE.lg, paddingVertical: SPACE.xs, backgroundColor: C.bg2 }}>
          <Text style={{ color: said.ok ? C.success : C.error, fontSize: T.eyebrow }}>{said.text}</Text>
        </View>
      ) : null}

      {view === "changes" ? (
      <FlatList
        data={files}
        keyExtractor={(f) => f.path}
        /* No gap: the changed files are one card divided by hairlines, the same
           as every other list in the app. See groupEdge in src/ui.tsx. */
        contentContainerStyle={{ padding: SPACE.lg, paddingBottom: SPACE.xl }}
        refreshControl={pullWith(() => Promise.all([load(), refreshRepos()]))}
        ListHeaderComponent={
          <View style={{ flexDirection: "row", alignItems: "center", paddingBottom: SPACE.sm, paddingLeft: SPACE.xs }}>
            <Text style={{ color: C.text2, fontSize: 13, fontWeight: "600", flex: 1 }}>
              {files.length === 0 ? "Nothing changed here" : `${files.length} changed · ${staged.length} staged`}
            </Text>
            {/* One tap for the common case — commit everything — without
                taking the row-by-row choice away. */}
            {mayWrite && files.length > staged.length ? (
              <Pressable
                accessibilityRole="button"
                disabled={!!busy}
                onPress={() => {
                  void act("stage:all", "/git/stage", { root, paths: files.filter((f) => !f.staged).map((f) => f.path) });
                }}
                style={({ pressed }) => ({
                  minHeight: TAP, justifyContent: "center", paddingHorizontal: SPACE.md,
                  borderRadius: RADIUS.sm, backgroundColor: pressed ? C.bg3 : "transparent",
                })}
              >
                {busy === "stage:all"
                  ? <ActivityIndicator color={C.primary} />
                  : <Text style={{ color: C.primary, fontSize: T.body, fontWeight: "600" }}>Stage all</Text>}
              </Pressable>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          status === null ? <ActivityIndicator color={C.text3} /> : null
        }
        ListFooterComponent={<PullHint text="Pull down to refresh. The box stages a file; the rest of the row opens its diff." />}
        renderItem={({ item, index }) => {
          const m = mark(item.status);
          return (
            <View style={[groupEdge(index === 0, index === files.length - 1), { flexDirection: "row", alignItems: "center" }]}>
              {/* The box stages and nothing else. It is the small target on the
                  left because staging is choosing — which files go in the
                  commit — and a mis-tap on the NAME used to do it: the one
                  thing a finger lands on when it means to read the file. */}
              <Pressable
                disabled={!mayWrite || !!busy}
                onPress={() => {
                  void act(
                    `stage:${item.path}`,
                    item.staged ? "/git/unstage" : "/git/stage",
                    { root, paths: [item.path] },
                  );
                }}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: item.staged, disabled: !mayWrite }}
                accessibilityLabel={`${item.staged ? "Unstage" : "Stage"} ${item.path}`}
                style={({ pressed }) => ({
                  width: TAP, minHeight: 56, alignItems: "center", justifyContent: "center",
                  backgroundColor: pressed ? C.bg3 : "transparent",
                })}
              >
                <View style={{
                  width: 24, height: 24, borderRadius: 7,
                  borderWidth: item.staged ? 0 : 2, borderColor: C.text4,
                  backgroundColor: item.staged ? C.primary : "transparent",
                  opacity: mayWrite ? 1 : 0.4,
                  alignItems: "center", justifyContent: "center",
                }}>
                  {item.staged ? <Glyph name="check" color={ink(C.primary)} size={17} weight={2.6} /> : null}
                </View>
              </Pressable>
              {/* The rest of the row is the diff. */}
              <Pressable
                onPress={() => router.push({ pathname: "/git-diff", params: { root, path: item.path } })}
                accessibilityRole="button"
                accessibilityLabel={`See what changed in ${item.path}`}
                style={({ pressed }) => ({
                  flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: SPACE.md,
                  minHeight: 56, paddingRight: SPACE.md, backgroundColor: pressed ? C.bg3 : "transparent",
                })}
              >
                <StatusBadge status={item.status} />
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <Text style={{ color: C.text, fontSize: 13.5, fontFamily: MONO, fontWeight: "500" }} numberOfLines={1} ellipsizeMode="head">
                    {item.path}
                  </Text>
                  <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.small }}>
                    {`${m.says}${item.staged ? " · staged" : ""} · tap to see the diff`}
                  </Text>
                </View>
                <ChevronIcon color={C.text3} size={16} />
              </Pressable>
            </View>
          );
        }}
      />
      ) : null}

      {/* ── the commits ────────────────────────────────────────────────── */}
      {view === "log" ? (
        <ScrollView
          contentContainerStyle={{ padding: SPACE.lg, paddingBottom: SPACE.xl }}
          refreshControl={pullWith(() => Promise.all([loadLog(), load()]))}
        >
          {commits === null ? (
            <View style={{ padding: SPACE.xl }}><ActivityIndicator color={C.text3} /></View>
          ) : commits.length === 0 ? (
            <Card><Note>No commits here yet.</Note></Card>
          ) : (
            commits.map((c, i) => (
              /* A row opens its commit: the files it changed, then each file's
                 diff. It was a dead row, and the log is where a review starts. */
              <Pressable
                key={c.hash}
                accessibilityRole="button"
                accessibilityLabel={`Open commit ${c.shortHash}: ${c.subject}`}
                onPress={() => router.push({
                  pathname: "/git-commit",
                  params: { root, hash: c.hash, short: c.shortHash, subject: c.subject, author: c.author, date: c.date },
                })}
                style={({ pressed }) => [
                  groupEdge(i === 0, i === commits.length - 1),
                  {
                    flexDirection: "row", alignItems: "center", gap: SPACE.md, minHeight: 64,
                    paddingHorizontal: SPACE.lg, paddingVertical: SPACE.md,
                    backgroundColor: pressed ? C.bg3 : "transparent",
                  },
                ]}
              >
                <View style={{ width: 36, height: 36, borderRadius: RADIUS.md, backgroundColor: C.bg3, alignItems: "center", justifyContent: "center" }}>
                  <Glyph name="commit" color={C.text2} size={20} />
                </View>
                <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                  <Text numberOfLines={2} style={{ color: C.text, fontSize: 14.5, fontWeight: "600", lineHeight: 20 }}>{c.subject}</Text>
                  <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.small, fontFamily: MONO }}>
                    {c.shortHash} · {c.author} · {c.date}
                  </Text>
                  {/* Where this commit is: the branch heads and tags git put
                      on it, and — for the ones no remote has — "not pushed".
                      A tag or a head on a commit is the thing that tells you
                      WHERE you are in a log of forty otherwise identical lines. */}
                  {c.refs || unpushed?.has(c.hash) ? (
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACE.xs }}>
                      {parseRefs(c.refs).map((r) => (
                        <Chip key={`${r.kind}:${r.label}`} label={r.kind === "head" ? `HEAD → ${r.label}` : r.label} tone={r.kind === "head" ? "accent" : "neutral"} />
                      ))}
                      {unpushed?.has(c.hash) ? <Chip label="not pushed" tone="accent" /> : null}
                    </View>
                  ) : null}
                </View>
                <ChevronIcon color={C.text4} size={16} />
              </Pressable>
            ))
          )}
          <PullHint text="Pull down to refresh. Each row opens that commit's files." />
        </ScrollView>
      ) : null}

      {/* ── the branches ───────────────────────────────────────────────── */}
      {view === "branches" ? (
        <ScrollView
          contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md, paddingBottom: SPACE.xl }}
          keyboardShouldPersistTaps="handled"
          refreshControl={pullWith(() => Promise.all([load(), refreshRepos()]))}
        >
          {mayWrite ? (
            <View style={{ gap: SPACE.sm }}>
              <Label text="New branch, from here" />
              <View style={{ flexDirection: "row", gap: SPACE.sm }}>
                <TextInput
                  value={newName}
                  onChangeText={setNewName}
                  placeholder="feat/name"
                  placeholderTextColor={C.text3}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={{
                    flex: 1, minHeight: 48, borderRadius: RADIUS.md, backgroundColor: C.bg2,
                    borderWidth: 1, borderColor: C.border, color: C.text,
                    paddingHorizontal: SPACE.md, fontSize: T.body, fontFamily: MONO,
                  }}
                />
                <Btn
                  label="Create"
                  tone="primary"
                  disabled={!newName.trim() || newProblem !== null}
                  busy={busy === "branch:new"}
                  onPress={() => { void act("branch:new", "/git/branch-create", { root, name: newName.trim() }).then(() => setNewName("")); }}
                />
              </View>
              {newProblem ? <Text style={{ color: C.text3, fontSize: T.eyebrow }}>{newProblem}</Text> : null}
            </View>
          ) : null}
          {branches === null ? (
            <View style={{ padding: SPACE.xl }}><ActivityIndicator color={C.text3} /></View>
          ) : branches.length === 0 ? (
            <Card><Note>No branches yet. A repository gets its first one with its first commit.</Note></Card>
          ) : (
            <View>
              {repo?.branch === "(detached)" ? (
                <View style={{ paddingBottom: SPACE.sm }}>
                  <Note>HEAD is detached: no branch is checked out. Tap one to go back to it.</Note>
                </View>
              ) : null}
              {orderBranches(branches).map((b, i, all) => (
                <Pressable
                  key={b.name}
                  disabled={!mayWrite || !!busy || b.current}
                  onPress={() => {
                    // Work in the tree comes along on a switch; say so first.
                    if (switchWarning(dirtyCount, b.name)) setSwitching(b.name);
                    else void act(`branch:${b.name}`, "/git/checkout", { root, name: b.name }, { branch: b.name });
                  }}
                  accessibilityRole="button"
                  accessibilityState={{ selected: b.current, disabled: !mayWrite || b.current }}
                  accessibilityLabel={b.current ? `${b.name}, checked out` : `Switch to ${b.name}`}
                  style={({ pressed }) => [
                    groupEdge(i === 0, i === all.length - 1),
                    {
                      flexDirection: "row", alignItems: "center", gap: SPACE.md, minHeight: 56,
                      paddingHorizontal: SPACE.lg, paddingVertical: SPACE.sm,
                      backgroundColor: pressed ? C.bg3 : "transparent",
                    },
                  ]}
                >
                  {b.current
                    ? <Glyph name="check" color={C.primary} size={18} weight={2.4} />
                    : <Glyph name="branch" color={C.text3} size={18} />}
                  <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                    <Text numberOfLines={1} style={{ color: b.current ? C.primary : C.text, fontSize: 13.5, fontWeight: b.current ? "600" : "500", fontFamily: MONO }}>{b.name}</Text>
                    <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.eyebrow }}>{b.date} · {b.subject}</Text>
                  </View>
                  {b.track ? <Chip label={trackWords(b.track)} tone={b.track.includes("gone") ? "warn" : "neutral"} /> : null}
                  {busy === `branch:${b.name}` ? <ActivityIndicator color={C.text3} /> : null}
                </Pressable>
              ))}
            </View>
          )}
          <PullHint />
        </ScrollView>
      ) : null}

      {/* ── the stash ──────────────────────────────────────────────────── */}
      {view === "stash" ? (
        <ScrollView
          contentContainerStyle={{ padding: SPACE.lg, paddingBottom: SPACE.xl }}
          refreshControl={pullWith(loadStashes)}
        >
          {stashes === null ? (
            <View style={{ padding: SPACE.xl }}><ActivityIndicator color={C.text3} /></View>
          ) : stashes.length === 0 ? (
            <Card><Note>Nothing is stashed here.</Note></Card>
          ) : (
            stashes.map((st, i) => {
              const t = stashTitle(st.message);
              return (
                <View
                  key={st.ref}
                  style={[
                    groupEdge(i === 0, i === stashes.length - 1),
                    { flexDirection: "row", alignItems: "center", gap: SPACE.md, paddingLeft: SPACE.lg, paddingRight: SPACE.sm, paddingVertical: SPACE.sm, minHeight: 56 },
                  ]}
                >
                  <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                    <Text numberOfLines={2} style={{ color: C.text, fontSize: 14, fontWeight: "500" }}>{t.title}</Text>
                    <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.eyebrow, fontFamily: MONO }}>
                      {st.ref}{t.branch ? ` · ${t.branch}` : ""}
                    </Text>
                  </View>
                  {mayWrite ? (
                    <Btn
                      label="Apply"
                      disabled={!!busy}
                      busy={busy === `stash:${st.index}`}
                      onPress={() => { void act(`stash:${st.index}`, "/git/stash-apply", { root, index: st.index }, { index: st.index }); }}
                    />
                  ) : null}
                </View>
              );
            })
          )}
          <PullHint />
        </ScrollView>
      ) : null}

      {/* ── the pull request for this branch ───────────────────────────── */}
      {view === "pr" ? (
        <ScrollView
          contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md, paddingBottom: SPACE.xl }}
          refreshControl={pullWith(async () => { await loadStatus(); await loadPrs(); })}
        >
          {branchPrs === null ? (
            <View style={{ padding: SPACE.xl }}><ActivityIndicator color={C.text3} /></View>
          ) : branchPrs.needsAuth ? (
            /* Its own answer, not folded into "none". The two used to be the
               same silence, and they need opposite things doing about them. */
            <Card>
              <Label text="Cannot ask GitHub" />
              <Note tone="bad">The GitHub CLI is not signed in on that computer.</Note>
            </Card>
          ) : !branchPrs.ok ? (
            <Card>
              <Label text={branchPrs.local ? "No branch" : "Cannot ask GitHub"} />
              <Note tone="bad">{branchPrs.error ?? "That branch could not be looked up."}</Note>
            </Card>
          ) : (
            <>
              {/* FROM this branch — the one you opened. Named apart from the
                  ones landing INTO it, because on a base branch the second
                  list is long and the first is the answer. */}
              {branchPrs.from ? (
                <View style={{ gap: SPACE.sm }}>
                  <Label text="From this branch" />
                  <PrLine pr={branchPrs.from} root={root} router={router} first last />
                </View>
              ) : (
                <Card>
                  <Note>
                    Nothing is open from {status?.branch ?? "this branch"} yet.
                  </Note>
                </Card>
              )}

              {branchPrs.into.length ? (
                <View style={{ gap: SPACE.sm }}>
                  <Label text={`Into it · ${branchPrs.into.length}`} />
                  {branchPrs.into.map((pr, i) => (
                    <PrLine
                      key={pr.number}
                      pr={pr}
                      root={root}
                      router={router}
                      first={i === 0}
                      last={i === branchPrs.into.length - 1}
                    />
                  ))}
                </View>
              ) : null}
            </>
          )}
          <PullHint />
        </ScrollView>
      ) : null}

      {/* Push outlives the dirty tree: once every file is committed `files` is
          empty and a branch that was never published still needs its button. */}
      {mayWrite && commitEnabled && view === "changes" && (files.length > 0 || push.canPush) ? (
        <View style={{
          gap: SPACE.sm, padding: SPACE.lg,
          borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.bg2,
        }}>
          {files.length > 0 ? (
          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder="What this commit does"
            placeholderTextColor={C.text3}
            style={{
              minHeight: 48, borderRadius: RADIUS.md, backgroundColor: C.bg,
              borderWidth: 1, borderColor: C.border, color: C.text,
              paddingHorizontal: SPACE.md, fontSize: T.body,
            }}
          />
          ) : null}
          <View style={{ flexDirection: "row", gap: SPACE.sm }}>
            {files.length > 0 ? (
            <Btn
              label={staged.length ? `Commit ${staged.length} ${staged.length === 1 ? "file" : "files"}` : "Nothing staged"}
              tone="primary"
              style={{ flex: 1 }}
              disabled={!staged.length || !title.trim()}
              busy={busy === "commit"}
              onPress={() => {
                /*
                 * The title is typed and never inferred. `RepoStatus.suggested`
                 * looks like a suggested message and is not — it is the list of
                 * dirty paths from the request — and a commit named by a field
                 * nobody read is worse on a phone than anywhere else, because
                 * nobody is going to notice before it is pushed.
                 */
                void act("commit", "/git/commit-staged", {
                  root, title: title.trim(), body: "",
                }, { files: staged.length }).then(() => setTitle(""));
              }}
            />
            ) : null}
            <Btn
              label={push.label}
              style={{ flex: 1 }}
              disabled={!push.canPush}
              busy={busy === "push"}
              onPress={() => { void act("push", "/git/push", { root }, { branch: branchName ?? undefined }); }}
            />
          </View>
          {/* Why a button is dim, in words: two grey buttons that say nothing
              are the ones somebody taps again to see if they are broken. */}
          {commitNeeds || pushNeeds ? (
            <Note>{[commitNeeds, pushNeeds].filter(Boolean).join(" ")}</Note>
          ) : null}
        </View>
      ) : null}

      {!mayWrite ? (
        <View style={{ padding: SPACE.lg, borderTopWidth: 1, borderTopColor: C.border }}>
          <Note>
            This phone may look but not change anything. That was chosen at the computer while
            somebody was reading the request; to change it, forget this phone there and pair again.
          </Note>
        </View>
      ) : null}

      {/* Switching with work in the tree. git would carry it across, or stop if a
          file clashed; neither is something to find out after the tap. */}
      <Sheet open={switching !== null} onClose={() => setSwitching(null)} title={`Switch to ${switching ?? ""}?`}>
        <Text style={{ color: C.text2, fontSize: T.body, lineHeight: 20, paddingBottom: SPACE.lg }}>
          {switching ? switchWarning(dirtyCount, switching) : ""}
        </Text>
        <View style={{ flexDirection: "row", gap: SPACE.sm }}>
          <Btn label="Cancel" style={{ flex: 1 }} onPress={() => setSwitching(null)} />
          <Btn
            label="Switch anyway"
            tone="primary"
            style={{ flex: 1 }}
            onPress={() => {
              const name = switching;
              setSwitching(null);
              if (name) void act(`branch:${name}`, "/git/checkout", { root, name }, { branch: name });
            }}
          />
        </View>
      </Sheet>
    </KeyboardAvoidingView>
  );
}
