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
} from "react-native";
import * as Haptics from "expo-haptics";
import { useHeaderHeight } from "expo-router/react-navigation";
import type { GitBranch, GitCommit, GitFileStatus, GitRepoRef, GitStash, PrBranchSummary, RepoStatus } from "../../../shared/types.ts";
import { ask } from "../../src/lib/api.ts";
import { useAgentglass } from "../../src/state/host-context.tsx";
import { usePaletteTick } from "../../src/state/use-palette.ts";
import { Btn, Card, Chip, Label, Note, Segmented, TAP, groupEdge } from "../../src/ui.tsx";
import { C, MONO, RADIUS, SPACE, T, ink, tint } from "../../src/theme.ts";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { ChevronIcon } from "../../src/nav/icons.tsx";
import { branchLookup, checkoutFor } from "../../src/model/checkout.ts";
import { keepOrder, newBranchProblem, orderBranches, scmSuccessText, stashTitle, trackWords, VIEWS, type ScmView } from "../../src/model/scm.ts";
import { Glyph } from "../../src/nav/glyphs.tsx";
import { ReposIcon } from "../../src/nav/icons.tsx";

/** What happened to a file, as a letter on a tint of its colour. A letter as
 *  well as a colour: at small sizes outdoors, colour alone is not a signal to
 *  rely on, and for a good number of people it is not a signal at all. The
 *  letters are git's own, so the phone and `git status` say the same thing. */
function mark(file: GitFileStatus): { letter: string; ink: string; says: string } {
  switch (file.status) {
    case "added": return { letter: "A", ink: C.success, says: "Added" };
    case "untracked": return { letter: "U", ink: C.success, says: "Untracked" };
    case "deleted": return { letter: "D", ink: C.error, says: "Deleted" };
    case "unmerged": return { letter: "!", ink: C.error, says: "Conflicted" };
    case "renamed": return { letter: "R", ink: C.info, says: "Renamed" };
    case "copied": return { letter: "C", ink: C.info, says: "Copied" };
    default: return { letter: "M", ink: C.warning, says: "Modified" };
  }
}

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

  const load = useCallback(async (): Promise<void> => {
    if (!host || !root) return;
    const answer = await ask<{ repos: RepoStatus[]; commitEnabled: boolean }>(host, "/git/status", {
      method: "POST",
      // A path, not a repository name: this route takes the directories to look
      // at, which is what makes it answer for a worktree rather than for the
      // repository the worktree belongs to.
      body: { paths: [root] },
    });
    if (!answer.ok) { setSaid({ ok: false, text: answer.error }); return; }
    setCommitEnabled(answer.value.commitEnabled !== false);
    const first = Array.isArray(answer.value.repos) ? answer.value.repos[0] ?? null : null;
    setStatus(first);
    setNoRepo(first === null);
  }, [host, root]);

  useEffect(() => { setStatus(null); setNoRepo(false); setTitle(""); void load(); }, [load]);

  /*
   * The other two views, fetched only when they are LOOKED at.
   *
   * Both cost a round trip and neither is the view this screen opens on, so
   * asking for all three up front would spend two requests per checkout switch
   * to fill panels nobody has turned to. They are cleared when the checkout
   * changes, because a commit list belonging to another worktree drawn under
   * this one's name is the worst kind of wrong here: it is plausible.
   */
  useEffect(() => { setCommits(null); setBranches(null); setStashes(null); setBranchPrs(null); setNewName(""); }, [root]);

  useEffect(() => {
    if (!host || !root || view !== "log" || commits !== null) return;
    let gone = false;
    void (async () => {
      const answer = await ask<{ commits?: GitCommit[] }>(
        host, `/git/log?root=${encodeURIComponent(root)}&limit=40`,
      );
      if (gone) return;
      setCommits(answer.ok ? answer.value.commits ?? [] : []);
    })();
    return () => { gone = true; };
  }, [host, root, view, commits]);

  useEffect(() => {
    if (!host || !root || view !== "branches" || branches !== null) return;
    let gone = false;
    void (async () => {
      const answer = await ask<{ branches?: GitBranch[] }>(host, `/git/branches?root=${encodeURIComponent(root)}`);
      if (gone) return;
      if (!answer.ok) { setSaid({ ok: false, text: answer.error }); setBranches([]); return; }
      setBranches(answer.value.branches ?? []);
    })();
    return () => { gone = true; };
  }, [host, root, view, branches]);

  useEffect(() => {
    if (!host || !root || view !== "stash" || stashes !== null) return;
    let gone = false;
    void (async () => {
      const answer = await ask<{ stashes?: GitStash[] }>(host, `/git/stashes?root=${encodeURIComponent(root)}`);
      if (gone) return;
      if (!answer.ok) { setSaid({ ok: false, text: answer.error }); setStashes([]); return; }
      setStashes(answer.value.stashes ?? []);
    })();
    return () => { gone = true; };
  }, [host, root, view, stashes]);

  useEffect(() => {
    if (!host || !root || view !== "pr" || branchPrs !== null) return;
    const look = branchLookup(status?.branch);
    if (!look.ask) {
      if (look.reason) setBranchPrs({ ok: false, into: [], local: true, error: look.reason });
      return;
    }
    const branch = look.branch;
    let gone = false;
    void (async () => {
      const answer = await ask<BranchPrs>(
        host,
        `/prs/for-branch?root=${encodeURIComponent(root)}&branch=${encodeURIComponent(branch)}`,
      );
      if (gone) return;
      setBranchPrs(answer.ok ? answer.value : { ok: false, into: [], error: answer.error });
    })();
    return () => { gone = true; };
  }, [host, root, view, branchPrs, status?.branch]);

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
    // What a write can have moved. Cleared, not patched, so the view that is
    // open asks again. Staging moves neither the head line nor the pull request
    // (a GitHub round trip), so those are left alone for it.
    setBranches(null); setStashes(null); setCommits(null);
    if (path === "/git/stage" || path === "/git/unstage") { await load(); return; }
    setBranchPrs(null);
    await Promise.all([load(), refreshRepos()]);
  }, [host, load, refreshRepos]);

  const files = useMemo(() => status?.files ?? [], [status]);
  const staged = useMemo(() => files.filter((f) => f.staged), [files]);

  const repo = repos?.find((r) => r.root === root) ?? null;

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
              hitSlop={{ top: 8, bottom: 8 }}
              style={({ pressed }) => ({
                flexDirection: "row", alignItems: "center", gap: 6, height: 32, paddingHorizontal: 12,
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
      {repo ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm, paddingHorizontal: 20, paddingVertical: SPACE.md }}>
          <Glyph name="branch" color={C.text3} size={18} />
          <Text numberOfLines={1} style={{ color: C.text, fontSize: 13, fontWeight: "500", fontFamily: MONO, flexShrink: 1 }}>
            {repo.branch}
          </Text>
          {repo.ahead ? <Chip label={`↑${repo.ahead} to push`} tone="accent" /> : null}
          {repo.behind ? <Chip label={`↓${repo.behind} behind`} tone="warn" /> : null}
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
        refreshControl={
          <RefreshControl
            refreshing={pulling}
            onRefresh={() => { setPulling(true); void load().finally(() => setPulling(false)); }}
            tintColor={C.text3}
          />
        }
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
                  minHeight: TAP, justifyContent: "center", paddingHorizontal: SPACE.sm,
                  transform: [{ scale: pressed ? 0.97 : 1 }],
                })}
              >
                <Text style={{ color: C.primary, fontSize: T.body, fontWeight: "600" }}>Stage all</Text>
              </Pressable>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          status === null ? <ActivityIndicator color={C.text3} /> : null
        }
        renderItem={({ item, index }) => {
          const m = mark(item);
          return (
            <View style={[groupEdge(index === 0, index === files.length - 1), { flexDirection: "row", alignItems: "center" }]}>
            <Pressable
              disabled={!mayWrite || !!busy}
              onPress={() => {
                // The switch IS the staging. One tap, one git call, one re-read.
                void act(
                  `stage:${item.path}`,
                  item.staged ? "/git/unstage" : "/git/stage",
                  { root, paths: [item.path] },
                );
              }}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: item.staged, disabled: !mayWrite }}
              accessibilityLabel={`${m.says}: ${item.path}`}
              style={({ pressed }) => ({
                flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: SPACE.md,
                minHeight: 52, paddingLeft: SPACE.lg, backgroundColor: pressed ? C.bg3 : "transparent",
              })}
            >
              {/* A box, because staging is choosing — which files go in the
                  commit — and not turning something on. */}
              <View style={{
                width: 22, height: 22, borderRadius: 6,
                borderWidth: item.staged ? 0 : 2, borderColor: C.text4,
                backgroundColor: item.staged ? C.primary : "transparent",
                opacity: mayWrite ? 1 : 0.4,
                alignItems: "center", justifyContent: "center",
              }}>
                {item.staged ? <Glyph name="check" color={ink(C.primary)} size={16} weight={2.6} /> : null}
              </View>
              <View style={{
                width: 22, height: 22, borderRadius: 6, alignItems: "center", justifyContent: "center",
                backgroundColor: tint(m.ink, 0.16),
              }}>
                <Text style={{ color: m.ink, fontSize: T.small, fontWeight: "600", fontFamily: MONO }}>{m.letter}</Text>
              </View>
              <Text
                style={{ color: C.text, fontSize: 13, fontFamily: MONO, flex: 1 }}
                numberOfLines={1}
                ellipsizeMode="head"
              >
                {item.path}
              </Text>
            </Pressable>
            {/* What changed in it: its own control, so staging stays one tap on
                the name and reading the change is one tap on the chevron. */}
            <Pressable
              onPress={() => router.push({ pathname: "/git-diff", params: { root, path: item.path } })}
              accessibilityRole="button"
              accessibilityLabel={`See what changed in ${item.path}`}
              style={({ pressed }) => ({
                width: TAP, minHeight: 52, alignItems: "center", justifyContent: "center",
                backgroundColor: pressed ? C.bg3 : "transparent",
              })}
            >
              <ChevronIcon color={C.text3} size={16} />
            </Pressable>
            </View>
          );
        }}
      />
      ) : null}

      {/* ── the commits ────────────────────────────────────────────────── */}
      {view === "log" ? (
        <ScrollView contentContainerStyle={{ padding: SPACE.lg, paddingBottom: SPACE.xl }}>
          {commits === null ? (
            <View style={{ padding: SPACE.xl }}><ActivityIndicator color={C.text3} /></View>
          ) : commits.length === 0 ? (
            <Card><Note>No commits here yet.</Note></Card>
          ) : (
            commits.map((c, i) => (
              <View
                key={c.hash}
                style={[
                  groupEdge(i === 0, i === commits.length - 1),
                  { flexDirection: "row", gap: SPACE.md, paddingHorizontal: SPACE.lg, paddingVertical: SPACE.md },
                ]}
              >
                <View style={{ paddingTop: 1 }}><Glyph name="commit" color={C.text3} size={20} /></View>
                <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                  <Text numberOfLines={2} style={{ color: C.text, fontSize: 14.5, fontWeight: "500", lineHeight: 20 }}>{c.subject}</Text>
                  <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.small, fontFamily: MONO }}>
                    {c.shortHash} · {c.author} · {c.date}
                  </Text>
                  {/* The decorations, when git gave any. A tag or a branch head
                      on a commit is the thing that tells you WHERE you are in a
                      log of forty otherwise identical lines. */}
                  {c.refs ? (
                    <View style={{ flexDirection: "row" }}><Chip label={c.refs} tone="accent" /></View>
                  ) : null}
                </View>
              </View>
            ))
          )}
        </ScrollView>
      ) : null}

      {/* ── the branches ───────────────────────────────────────────────── */}
      {view === "branches" ? (
        <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md, paddingBottom: SPACE.xl }} keyboardShouldPersistTaps="handled">
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
                  onPress={() => { void act(`branch:${b.name}`, "/git/checkout", { root, name: b.name }, { branch: b.name }); }}
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
        </ScrollView>
      ) : null}

      {/* ── the stash ──────────────────────────────────────────────────── */}
      {view === "stash" ? (
        <ScrollView contentContainerStyle={{ padding: SPACE.lg, paddingBottom: SPACE.xl }}>
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
        </ScrollView>
      ) : null}

      {/* ── the pull request for this branch ───────────────────────────── */}
      {view === "pr" ? (
        <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md, paddingBottom: SPACE.xl }}>
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
        </ScrollView>
      ) : null}

      {mayWrite && commitEnabled && view === "changes" && files.length > 0 ? (
        <View style={{
          gap: SPACE.sm, padding: SPACE.lg,
          borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.bg2,
        }}>
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
          <View style={{ flexDirection: "row", gap: SPACE.sm }}>
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
            <Btn
              label={repo?.ahead ? `Push ${repo.ahead}` : "Push"}
              style={{ flex: 1 }}
              busy={busy === "push"}
              onPress={() => { void act("push", "/git/push", { root }, { branch: repo?.branch }); }}
            />
          </View>
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
    </KeyboardAvoidingView>
  );
}
