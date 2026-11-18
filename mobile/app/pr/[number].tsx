/*
 * One pull request, read and acted on without leaving the app.
 *
 * This screen is the answer to the thing the phone did instead: tapping a row
 * called `Linking.openURL` and handed you to Safari, signed out, on a page
 * built for a mouse. Everything below arrives in ONE call to `/prs/detail` —
 * body, checks, files, threads, commits — which the server already answered
 * and nothing on the phone ever asked.
 *
 * ── what it does not try to be ────────────────────────────────────────────
 * Not the diff, and not the whole conversation. Both are real screens and both are
 * bigger than this one; what belongs here is the question you open a pull
 * request to answer on a phone — is this alright, and if not, what is wrong
 * with it. Files are a list with their weights, threads are a count, and the
 * way to the whole thing on GitHub is at the bottom rather than the top.
 *
 * ── the button that matters ───────────────────────────────────────────────
 * "Send to terminal" is why any of this exists. It does NOT post a prompt: it
 * puts `{cmd:"review", number, root, recipe}` on the terminal's socket, the
 * server looks that recipe id up in its own catalogue, builds the text, opens
 * a tmux window running the agent, and switches the pane. The socket carries an
 * intent and never a command line — see src/model/reviewMenu.ts for why that
 * shape is load-bearing rather than incidental.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { repoOf } from "../../src/model/prRef.ts";
import { checksMoved, jobsPassedLine, nextDetailPoll, runLine, runSquares, runningCheckLine } from "../../src/model/checkJobs.ts";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, TextInput, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import type { PrCheckRollup, PrDetail, PrLocalHead, ReviewRecipe, ReviewRecipesResponse } from "../../../shared/types.ts";
import { ask } from "../../src/lib/api.ts";
import { Md, outline } from "../../src/md/Md.tsx";
import { useAgentglass } from "../../src/state/host-context.tsx";
import { usePaletteTick } from "../../src/state/use-palette.ts";
import { usePrDetail } from "../../src/state/pr-detail.ts";
import { prMarkKey } from "../../../shared/prUnread.ts";
import { usePrTalkTick, useReloadOnTick } from "../../src/state/pr-talk.ts";
import { useReadOnOpen } from "../../src/state/read-marks.ts";
import { useTaskProvider, useTracksWork } from "../../src/state/use-tracks-work.ts";
import { useJiraReach } from "../../src/state/use-jira-reach.ts";
import { TaskChip } from "../../src/review/TaskChip.tsx";
import { FilesPane } from "../../src/review/FilesPane.tsx";
import { ThreadsPane } from "../../src/review/ThreadsPane.tsx";
import { Timeline } from "../../src/review/Timeline.tsx";
import { conversation } from "../../../shared/prConversation.ts";
import { RECIPES_PATH, menuFor, situationOf } from "../../src/model/reviewMenu.ts";
import { requestHandoff } from "../../src/terminal/handoff.ts";
import { clearDraft, draft, forWire } from "../../src/model/reviewDraft.ts";
import { since } from "../../src/lib/dates.ts";
import { ago } from "../../src/model/cardStatus.ts";
import { openHttp } from "../../src/lib/openHttp.ts";
import { mergeVerdict } from "../../../shared/mergeReason.ts";
import { mergeGate } from "../../src/model/prMergeGate.ts";
import {
  MERGE_OPTION, allowedMethods, mergeSubject, pickMergeMethod,
  type MergeMethod,
} from "../../../shared/mergeMethod.ts";
import { Btn, Card, Chip, Eyebrow, Group, GroupTitle, HoldButton, Label, LabelChip, Note, Row, Segmented, Sheet, SheetRow, Switch, TAP } from "../../src/ui.tsx";
import { changesRequestedWarning, mergeObstacles } from "../../src/model/mergeObstacles.ts";
import { mergeBanner, reviewerRows, lastSaid } from "../../src/model/prOverview.ts";
import { labelsOf, reviewersOf, writeBlocked } from "../../src/model/prManage.ts";
import { behindLine, type SyncTarget } from "../../src/model/prSync.ts";
import { PrActionsSheet } from "../../src/review/PrActionsSheet.tsx";
import { LabelsSheet } from "../../src/review/LabelsSheet.tsx";
import { ReviewersSheet } from "../../src/review/ReviewersSheet.tsx";
import { SyncSheet } from "../../src/review/SyncSheet.tsx";
import { WatchRuleSheet } from "../../src/inbox/WatchRuleSheet.tsx";
import { ChecksSheet } from "../../src/review/ChecksSheet.tsx";
import { LinkedCard, MergeBannerCard, ReviewersCard } from "../../src/review/Overview.tsx";
import { Glyph, type GlyphName } from "../../src/nav/glyphs.tsx";
import { ChevronIcon } from "../../src/nav/icons.tsx";
import { Avatar } from "../../src/Avatar.tsx";
import { C, MONO, RADIUS, SPACE, T, ink, tint } from "../../src/theme.ts";

/** How much of a description shows before the fold. */
const BODY_BLOCKS = 6;

/** One square of the checks strip, in the ink it is drawn with. The words and
 *  the order are model/checkJobs.ts's. */
const SQUARE = {
  pass: () => C.success,
  fail: () => C.error,
  run: () => C.warning,
  skip: () => "transparent",
} as const;

/** The rollup as one word and one colour. `pending` beats `failure` on purpose:
 *  a run still going has not failed yet, and calling it red is how a screen
 *  tells you to go and look at something that is about to go green. */
function checksLook(pr: PrDetail): { word: string; ink: string; mark: GlyphName } {
  const { total, failure, pending, success } = pr.checks;
  if (!total) return { word: "No checks", ink: C.text4, mark: "circle" };
  if (pending) return { word: `${pending} running`, ink: C.warning, mark: "run_circle" };
  if (failure) return { word: `${failure} failed`, ink: C.error, mark: "x_circle" };
  return { word: `${success} passed`, ink: C.success, mark: "ok_circle" };
}

function FileRow({ file, onOpen }: {
  file: PrDetail["files"][number];
  onOpen: () => void;
}): React.ReactNode {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onOpen}
      style={{
      // At the floor even though nothing here is tappable. There is no
      // argument for 40 beyond saving four points, and test/tap-floor.test.ts
      // is deliberately blunt: a smaller row has to be worth explaining.
      flexDirection: "row", alignItems: "center", gap: SPACE.sm, minHeight: TAP,
    }}>
      {/* Cut at the HEAD, so the file name survives and the directory is what
          goes. `src/…/indexer.ts` answers "which file" and
          `src/search/index…` does not. */}
      <Text
        numberOfLines={1}
        ellipsizeMode="head"
        style={{ color: C.text2, fontSize: T.small, fontFamily: MONO, flex: 1 }}
      >{file.path}</Text>
      <Text style={{ fontSize: T.eyebrow, fontFamily: MONO }}>
        {file.additions ? <Text style={{ color: C.success }}>+{file.additions} </Text> : null}
        {file.deletions ? <Text style={{ color: C.error }}>−{file.deletions}</Text> : null}
      </Text>
    </Pressable>
  );
}

/** The mock's section head (32): an uppercase eyebrow, and at most one text
 *  button beside it. Uppercase rather than `Label`'s sentence case because on
 *  this screen the head is a signpost, not a row of prose. */
function Head({ text, action, onAction }: { text: string; action?: string; onAction?: () => void }): React.ReactNode {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", paddingTop: SPACE.md, paddingHorizontal: 2 }}>
      <Text accessibilityRole="header" style={{
        flex: 1, color: C.text3, fontSize: 12, fontWeight: "700", letterSpacing: 0.8, textTransform: "uppercase",
      }}>{text}</Text>
      {action && onAction ? (
        <Pressable
          accessibilityRole="button"
          onPress={onAction}
          style={({ pressed }) => ({
            minHeight: 44, justifyContent: "center", paddingHorizontal: 4, opacity: pressed ? 0.6 : 1,
          })}
        >
          <Text style={{ color: C.primary, fontSize: 12, fontWeight: "600" }}>{action}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** The three verdicts, with what each one does — the words GitHub's own
 *  review form uses. */const VERDICTS: { id: "approve" | "request_changes" | "comment"; label: string; what: string }[] = [
  { id: "comment", label: "Comment", what: "Feedback, without a verdict" },
  { id: "approve", label: "Approve", what: "Good to merge as it is" },
  { id: "request_changes", label: "Request changes", what: "Must be addressed before it merges" },
];

/** The three faces of a review. Overview is what a pull request IS; the other
 *  two are what it changed and what was said about it. */
type Pane = "overview" | "conversation" | "files" | "threads";

/** A parameter is a stranger's string. Anything that is not one of the three
 *  is the overview, which is where somebody arriving with a broken link should
 *  land rather than on a blank pane. */
const asPane = (raw: string | undefined): Pane =>
  raw === "conversation" || raw === "files" || raw === "threads" ? raw : "overview";

export default function PrScreen(): React.ReactNode {
  usePaletteTick(); // a scene repaints only if it asks — see use-palette.ts
  const { host } = useAgentglass();
  /* Whether this machine tracks work in ANYTHING — the catalogue's question,
     not a product's. It decides only whether an id read from a branch may be
     offered as something to look up; an address in the body opens either way. */
  const tracked = useTracksWork(host);
  const provider = useTaskProvider(host);
  /* The connected Jira site's project keys: what turns `ORBIT-1042` in a branch
     into that card rather than into a ClickUp id of the same shape. */
  const jira = useJiraReach(host);

  const router = useRouter();
  const { number, root, review, pane: wanted, ask: asked, merge: wantMerge, reviewers: wantReviewers } = useLocalSearchParams<{
    number: string; root: string; review?: string; pane?: string; ask?: string; merge?: string; reviewers?: string;
  }>();
  /*
   * Which pane, and which file it was opened on.
   *
   * `pane` comes in as a parameter as well as being state, so a link can point
   * at a segment — `/pr/12?pane=threads` — the same way `/pr/threads` used to
   * point at a screen. Both still work; this is the one that does not push.
   *
   * `seen` is the mount-once rule: a pane the reader never opened costs
   * nothing, and one they did keeps its scroll position for the rest of the
   * review. Recorded rather than derived, because "is it showing" is not the
   * same question as "has it ever shown".
   */
  const [pane, setPaneState] = useState<Pane>(asPane(wanted));
  const [seen, setSeen] = useState<Record<Pane, boolean>>(() => ({
    overview: true, conversation: asPane(wanted) === "conversation",
    files: asPane(wanted) === "files", threads: asPane(wanted) === "threads",
  }));
  /** The file the Files pane should land on, when it was opened by tapping one. */
  const [file, setFile] = useState<string | null>(null);
  /** The files preview sheet (mock 35), before the diff pane. */
  const [filesOpen, setFilesOpen] = useState(false);

  const setPane = useCallback((next: Pane): void => {
    setPaneState(next);
    setSeen((was) => (was[next] ? was : { ...was, [next]: true }));
  }, []);

  /* Submitting a review writes to GitHub. A phone paired to answer gates does
     not get to, and the control is not drawn rather than drawn and refused —
     the rule repos.tsx set. Reading the diff and handing it to Claude both
     stay available, because neither writes anything. */
  const mayWrite = host?.scope === "full";
  /** Why the manage sheet's rows are disabled, or null on a full pairing. */
  const blocked = host ? writeBlocked(host.scope) : null;

  /* The manage door and the three sheets it opens. One Modal visible at a
     time: opening a child closes the menu first, because two presented at once
     is the arrangement the review sheet's own comment says is unreliable. */
  const [managing, setManaging] = useState(false);
  /** The bell in the header: the rules that watch this run (mock 40). */
  const [watching, setWatching] = useState(false);
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [reviewersOpen, setReviewersOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);

  /* How far behind its base the branch is. Asked beside the detail rather than
     inside it: the comparison costs a GitHub request the rest of the screen
     does not need, and a branch that is closed has no answer to give. */
  const [behind, setBehind] = useState<SyncTarget | null>(null);
  const [behindErr, setBehindErr] = useState<string | null>(null);

  /* One read for the whole review — the two panes below are looking at the
     same pull request, and a write in either of them re-reads this. Before
     that, resolving a thread left the count on this screen saying what it said
     when you arrived. See state/pr-detail.ts. */
  const { detail, error, reload: load, refresh } = usePrDetail(host, root ?? "", String(number ?? ""));
  /* Opening it is reading it: the mark moves to now, and what it was BEFORE is
     what the Talk pane draws its divider against. See state/read-marks.ts. */
  const lastLooked = useReadOnOpen(host, detail);

  /* The behind row (s32): one comparison, re-asked when the head moves. Its
     two numbers are the whole of "what main brings" — see model/prSync.ts. */
  const headSha = detail?.headSha ?? "";
  const detailState = detail?.state;
  const headRef = detail?.headRefName;
  const mergeable = detail?.mergeable;
  useEffect(() => {
    if (!host || !root || !number || detailState !== "OPEN") { setBehind(null); setBehindErr(null); return; }
    let gone = false;
    void (async () => {
      const answer = await ask<{ ok: boolean; behind?: number; ahead?: number; local?: PrLocalHead; error?: string }>(
        host, `/prs/behind?root=${encodeURIComponent(root)}&number=${encodeURIComponent(String(number))}`,
      );
      if (gone) return;
      if (!answer.ok) { setBehindErr(answer.error); return; }
      if (!answer.value.ok) { setBehindErr(answer.value.error ?? "GitHub would not compare the branches."); return; }
      setBehindErr(null);
      setBehind({
        number: Number(number),
        behind: Number(answer.value.behind ?? 0),
        ahead: Number(answer.value.ahead ?? 0),
        head: headRef,
        conflict: mergeable === "CONFLICTING",
        syncLocal: answer.value.local?.sync === "ff",
      });
    })();
    return () => { gone = true; };
  }, [host, root, number, detailState, headSha, headRef, mergeable]);

  /* Stable identity for the sync sheet: its read runs when this list changes.
     The number and the comparison are what matter; the branch name is a label. */
  const syncTargets = useMemo<SyncTarget[]>(() => [{
    number: Number(number),
    behind: behind?.behind,
    ahead: behind?.ahead,
    head: headRef,
    conflict: mergeable === "CONFLICTING",
    syncLocal: behind?.syncLocal,
  }], [number, behind?.behind, behind?.ahead, behind?.syncLocal, headRef, mergeable]);

  // A live comment or review on THIS pull request. The key comes off the
  // detail's own URL, as the read marks' does: the route only carries a
  // checkout root and a number. Empty until the detail loads, which
  // subscribes to nothing.
  const talkKey = detail?.url ? prMarkKey(detail) : "";
  useReloadOnTick(usePrTalkTick(talkKey), refresh, talkKey);

  /* The checks move without anybody speaking, and a `ci` frame only comes when
     a run finishes: while one is still going, ask again (see nextDetailPoll),
     and let the pull down do the same by hand. */
  const [pollTick, setPollTick] = useState(0);
  const stillRunning = detail?.checks.pending;
  useEffect(() => {
    const wait = nextDetailPoll(stillRunning);
    if (wait === null || !host || !root || !detail) return;
    const timer = setTimeout(() => {
      void (async () => {
        const answer = await ask<{ ok: boolean; checks?: PrCheckRollup }>(
          host, `/prs/rollup?root=${encodeURIComponent(root)}&number=${encodeURIComponent(String(number))}&force=1`,
        );
        const now = answer.ok && answer.value.ok ? answer.value.checks : undefined;
        // Nothing moved: the same timer is armed again by the next render only
        // if the detail changes, so re-arm here by re-reading nothing but the
        // rollup's own verdict. A move is what the full read is for.
        if (now && checksMoved(now, detail.checks)) await refresh();
        else setPollTick((n) => n + 1);
      })();
    }, wait);
    return () => clearTimeout(timer);
  }, [detail, stillRunning, host, root, number, refresh, pollTick]);
  const [pulling, setPulling] = useState(false);
  const pull = useCallback((): void => {
    setPulling(true);
    void refresh().finally(() => setPulling(false));
  }, [refresh]);

  const [handing, setHanding] = useState(false);
  /* `ask=1` opens the Claude menu: Checks sends you back here with it, so a
     red job is one tap from the recipes rather than a back and a hunt for the
     bar. Cleared once read, or the menu would reopen on every later visit that
     happens to carry the same params. Only where `hand` would go anyway. */
  useEffect(() => {
    if (asked !== "1") return;
    router.setParams({ ask: undefined });
    if (mayWrite) setHanding(true);
  }, [asked, mayWrite, router]);
  /* A card's "Merge" press on the board lands here with the sheet already up:
     the method, the arm and the hold all live on this screen, and a board card
     is not the place to make a permanent commit from. Cleared once read, like
     `ask` above, or the sheet would reopen on every later visit. */
  useEffect(() => {
    if (wantMerge !== "1") return;
    router.setParams({ merge: undefined });
    if (mayWrite) setMerging(true);
  }, [wantMerge, mayWrite, router]);
  /* A card's "Request a review…" on the board lands here with the reviewers
     sheet up: it reads this screen's detail. Cleared once read, like `merge`. */
  useEffect(() => {
    if (wantReviewers !== "1") return;
    router.setParams({ reviewers: undefined });
    if (mayWrite) setReviewersOpen(true);
  }, [wantReviewers, mayWrite, router]);
  const [allFiles, setAllFiles] = useState(false);
  /* The description folds after six blocks. Six is where this project's own
     template stops being the checklist and starts being the CU reference —
     which is exactly the point a reader decides whether to read on. */
  const [bodyOpen, setBodyOpen] = useState(false);
  /* What the fold is hiding, named rather than counted: "CU reference and 2
     more" tells you whether to open it; "Show more" does not. */
  const rest = useMemo(
    () => (detail?.body ? outline(detail.body.trim(), BODY_BLOCKS) : { hidden: 0, nextHeading: null }),
    [detail?.body],
  );
  /** The menu, as the computer has it — built-ins with the user's own edits
   *  merged in. Null until it answers, which is why the sheet says so rather
   *  than drawing an empty list that reads as "no options". */
  const [catalogue, setCatalogue] = useState<ReviewRecipe[] | null>(null);
  /*
   * The prompt a recipe would send, read back before it is sent.
   *
   * ── this does NOT change what the socket carries ─────────────────────────
   * `cmd: "review"` still carries a number, a directory and a recipe ID, and
   * the words are still built on the computer from its own catalogue — the
   * property src/model/reviewMenu.ts describes as load-bearing, which it is: a
   * socket reachable from the UI must not be a way to choose what an agent is
   * told. This is a separate, read-only call to `/prs/review-prompt`, which
   * writes nothing and starts nothing. It answers "what am I about to ask" and
   * the answer is not editable here, deliberately — an editable preview would
   * be that socket by another route, and whether the phone should be allowed
   * to send words of its own is a decision about what this app is, not a
   * detail of a preview.
   */
  const [preview, setPreview] = useState<
    | { recipe: string; title: string; state: "asking" }
    | { recipe: string; title: string; state: "read"; prompt: string; cwd: string }
    | { recipe: string; title: string; state: "failed"; error: string }
    | null
  >(null);
  /* Opened straight away when the diff sent you here with comments queued —
     `review=1` on the route. Otherwise it is the second button below. */
  const [reviewing, setReviewing] = useState(review === "1");
  const [verdict, setVerdict] = useState<"approve" | "request_changes" | "comment" | null>(null);
  /** The verdict picked in the sheet, before it is sent. Comment by default:
   *  the one that commits nobody to anything. */
  const [choice, setChoice] = useState<"approve" | "request_changes" | "comment">("comment");
  const [summary, setSummary] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  /*
   * The review GitHub is already holding for you.
   *
   * A review can be STARTED anywhere — on github.com, at the desk, in an
   * editor — and until it is submitted its line comments sit on GitHub,
   * pending, visible to nobody. The phone could not see them, so the sheet
   * said "no line comments" while three were queued, and sending a verdict
   * from here submitted them along with it without ever having shown them.
   *
   * Null means "not asked yet", which is not the same as an empty list, and
   * the sheet says which of the two it is.
   */
  const [pending, setPending] = useState<
    { path: string; line: number | null; body: string }[] | "asking" | "unknown"
  >("unknown");

  /* A comment on the conversation, which is not a review and not a reply. It
     is the only thing you can say on your OWN pull request — GitHub refuses a
     review there, so the Review button is off and this is what is left. */
  const [commenting, setCommenting] = useState(false);
  const [comment, setComment] = useState("");
  const [commentBusy, setCommentBusy] = useState(false);
  const [commentErr, setCommentErr] = useState<string | null>(null);

  /* Merging. `method` is null until the detail lands, because the repository is
     what decides which three are on offer and opening on a guess is the bug
     shared/mergeMethod.ts was written to end. */
  const [merging, setMerging] = useState(false);
  const [method, setMethod] = useState<MergeMethod | null>(null);
  /* Both default OFF, and neither is remembered. A phone is where somebody
     merges one thing in a corridor, and a toggle that carried yesterday's
     answer into today's branch deletion is not a convenience. */
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [auto, setAuto] = useState(false);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [mergeErr, setMergeErr] = useState<string | null>(null);


  // Fetched beside the detail rather than after it: they are independent
  // questions, and the sheet is not opened in the first instant anyway.
  useEffect(() => {
    if (!host) return;
    let gone = false;
    void (async () => {
      const answer = await ask<ReviewRecipesResponse>(host, RECIPES_PATH);
      if (gone || !answer.ok || !answer.value.ok) return;
      setCatalogue(answer.value.recipes ?? []);
    })();
    return () => { gone = true; };
  }, [host]);

  /** The menu, and which entry sits on top. Held apart from the render so the
   *  sheet does not re-sort itself while it is open. */
  const menu = useMemo(
    () => (detail && catalogue ? menuFor(situationOf(detail), catalogue) : null),
    [detail, catalogue],
  );

  /** Ask the computer what it would say, without asking it to say it. A GET in
   *  everything but method: `prepareReviewPrompt` builds the text and returns
   *  it, and starts nothing. */
  const look = useCallback(async (recipe: ReviewRecipe): Promise<void> => {
    if (!host || !detail || !root) return;
    /* The menu closes as this opens. `Sheet` is a react-native `Modal`, and two
       visible at once is not a layout choice — presenting the second over the
       first is unreliable on iOS and flickers on Android. Back from the preview
       puts the menu back, so it still reads as a step rather than a jump. */
    setHanding(false);
    setPreview({ recipe: recipe.id, title: recipe.title, state: "asking" });
    const answer = await ask<{ ok: boolean; prompt?: string; cwd?: string; error?: string }>(
      host, "/prs/review-prompt",
      { method: "POST", body: { root, number: detail.number, recipe: recipe.id } },
    );
    if (!answer.ok) {
      setPreview({ recipe: recipe.id, title: recipe.title, state: "failed", error: answer.error });
      return;
    }
    if (!answer.value.ok || !answer.value.prompt) {
      setPreview({
        recipe: recipe.id, title: recipe.title, state: "failed",
        error: answer.value.error ?? "The computer could not build that prompt.",
      });
      return;
    }
    setPreview({
      recipe: recipe.id, title: recipe.title, state: "read",
      prompt: answer.value.prompt, cwd: answer.value.cwd ?? "",
    });
  }, [host, detail, root]);

  /**
   * Leave the request and go to the terminal.
   *
   * In that order, and it matters: the letterbox is read when the terminal has
   * a socket, so navigating first would race a screen that has nothing to
   * collect yet. See src/terminal/handoff.ts.
   */
  const hand = useCallback((recipe: string): void => {
    // The terminal needs `full` and so does the review it would run; a phone
    // without it is not offered this and, if it gets here, does not go.
    if (!detail || !root || !mayWrite) return;
    requestHandoff({
      t: "tmux",
      cmd: "review",
      number: detail.number,
      root,
      recipe,
    });
    setHanding(false);
    setPreview(null);
    router.push("/terminal");
  }, [detail, root, router, mayWrite]);

  const key = `${root}#${number}`;
  const notes = draft(key);

  /* Asked when the sheet opens rather than beside the detail: it is one more
     round trip to GitHub for a question nobody has while they are reading the
     files, and the answer is only ever looked at here. Re-asked on every
     opening, because a review can be started elsewhere between two of them. */
  useEffect(() => {
    if (!host || !reviewing || !root || !number) return;
    let gone = false;
    setPending("asking");
    void (async () => {
      const answer = await ask<{ ok: boolean; comments?: { path: string; line: number | null; body: string }[] }>(
        host, "/prs/pending-review", { method: "POST", body: { root, number: Number(number) } },
      );
      if (gone) return;
      /* A failure ends at "unknown" and NOT at "asking". Leaving it on the
         asking state was a spinner that never resolves — a screen saying it is
         still working when it has stopped, which is the one thing a status
         line must never do. Claiming zero would be worse still: the app
         inventing an answer about somebody else's queued comments. */
      setPending(answer.ok && answer.value.ok ? answer.value.comments ?? [] : "unknown");
    })();
    return () => { gone = true; };
  }, [host, reviewing, root, number]);

  /**
   * The verdict and every queued comment, in ONE call.
   *
   * `/prs/review-with` takes both together, which is what makes this atomic: a
   * phone that loses signal cannot leave three remarks and no conclusion on
   * somebody's pull request. The draft is cleared only on success — clearing
   * it on a failure would throw away what somebody typed because a network
   * dropped.
   */
  const send = useCallback(async (verb: "approve" | "request_changes" | "comment"): Promise<void> => {
    if (!host || !detail || !root) return;
    setVerdict(verb);
    const answer = await ask<{ ok: boolean; error?: string }>(host, "/prs/review-with", {
      method: "POST",
      body: { root, number: detail.number, verb, body: summary.trim(), comments: forWire(notes) },
    });
    setVerdict(null);
    if (!answer.ok) { setSent(answer.error); return; }
    if (!answer.value.ok) { setSent(answer.value.error ?? "GitHub refused that review."); return; }
    clearDraft(key);
    setSummary("");
    setReviewing(false);
    setSent(null);
    // Submitting takes the pending comments with it — that is what makes them
    // pending — so what is held next time is a fresh question.
    setPending("unknown");
    void load();
  }, [host, detail, root, summary, notes, key, load]);

  /** One comment on the conversation. Posted on its own, because that is what
   *  it is: not a verdict, not a remark about a line, and nothing GitHub
   *  batches. */
  const saySomething = useCallback(async (): Promise<void> => {
    if (!host || !detail || !root || !comment.trim()) return;
    setCommentBusy(true);
    setCommentErr(null);
    const answer = await ask<{ ok: boolean; error?: string }>(host, "/prs/comment", {
      method: "POST",
      body: { root, number: detail.number, body: comment.trim() },
    });
    setCommentBusy(false);
    if (!answer.ok) { setCommentErr(answer.error); return; }
    if (!answer.value.ok) { setCommentErr(answer.value.error ?? "GitHub refused that."); return; }
    setComment("");
    setCommenting(false);
    void load();
  }, [host, detail, root, comment, load]);

  /* Opened on what the repository would have checked, once — not on every
     render, or a tap on "Rebase" would be undone by the next repaint. */
  const methods = useMemo(() => allowedMethods(detail?.mergePolicy), [detail?.mergePolicy]);
  /** The parts of a blocked verdict, one row each. See src/model/mergeObstacles.ts. */
  const obstacles = useMemo(() => (detail ? mergeObstacles(detail) : []), [detail]);
  /** "Ready to merge" is GitHub's answer to "will it take it", not to "should
   *  you take it over this review" — see src/model/mergeObstacles.ts. */
  const changesRequested = useMemo(() => (detail ? changesRequestedWarning(detail) : null), [detail]);
  useEffect(() => {
    if (detail && method === null) setMethod(pickMergeMethod(undefined, detail.mergePolicy));
  }, [detail, method]);

  /**
   * Will GitHub take it, and if not, why — from the same ladder the desktop
   * uses.
   *
   * `mergeVerdict` is in shared/ rather than repeated here, and that is the
   * whole point: its own comment records that this ladder existed twice in the
   * web app and the two were a second opinion on two of three cases within the
   * day. A phone that reached its own verdict would be the third.
   */
  const gate = useMemo(
    () => (detail ? mergeVerdict(detail.mergeState, detail.checks) : null),
    [detail],
  );
  /** What GitHub's state cannot see (lock, draft, conflict, no rights), and
   *  whether the arm is an honest offer — the desktop box's own two answers. */
  const refusals = useMemo(() => (detail ? mergeGate(detail) : null), [detail]);
  // The switch may still be on from before a refresh brought a conflict or a
  // lock; what the gate refuses must not be armed by a stale tap.
  const autoOn = auto && !refusals?.autoRefusal && !(detail?.mergePolicy && !detail.mergePolicy.auto);

  /**
   * The merge, with the commit it is allowed to land from.
   *
   * `headSha` is not optional caution. This screen may have been open for
   * minutes and the author may have pushed in that time, so the checks that
   * were read — and that the button was believed on the strength of — are
   * about a commit that is no longer the head. `--match-head-commit` makes
   * GitHub refuse rather than merge something nobody looked at. When the
   * second pass has not landed there is no sha, and the server simply omits
   * the flag: a merge with no guard is what the desktop does too, and refusing
   * to merge at all would be a phone inventing a rule.
   */
  const doMerge = useCallback(async (): Promise<void> => {
    if (!host || !detail || !root || !method) return;
    setMergeBusy(true);
    setMergeErr(null);
    const answer = await ask<{ ok: boolean; error?: string; detail?: string }>(host, "/prs/merge", {
      method: "POST",
      body: {
        root,
        number: detail.number,
        method,
        deleteBranch,
        auto: autoOn,
        headSha: detail.headSha,
        // The subject GitHub itself would have written. Not editable here —
        // a permanent commit message is not a thing to compose with a thumb,
        // and the desktop's dialog is where that belongs.
        subject: mergeSubject(method, detail),
      },
    });
    setMergeBusy(false);
    if (!answer.ok) { setMergeErr(answer.error); return; }
    if (!answer.value.ok) {
      setMergeErr(answer.value.error || answer.value.detail || "GitHub refused that merge.");
      return;
    }
    setMerging(false);
    // Re-read rather than assume. With `auto` the pull request is still open
    // and now says so, and that is exactly the state somebody needs to see.
    void load();
  }, [host, detail, root, method, deleteBranch, autoOn, load]);

  const now = Date.now();
  /** The checkout's own name, for the terminal door the mock puts on the card:
   *  "Open in the terminal · orbit-1042". */
  const checkoutName = (root ?? "").split("/").filter(Boolean).pop() ?? "";
  /** The Checks tab and the Checks card open the run's summary (mock 34), in
   *  a sheet; the job list with its logs is one row down, unchanged. */
  const [checksOpen, setChecksOpen] = useState(false);
  const [checksBusy, setChecksBusy] = useState(false);
  const [checksSaid, setChecksSaid] = useState<string | null>(null);
  const openChecks = useCallback((): void => {
    setChecksSaid(null);
    setChecksOpen(true);
  }, []);
  const openRun = useCallback((_job?: string): void => {
    setChecksOpen(false);
    router.push({ pathname: "/pr/checks", params: { number: String(number), root: root ?? "" } });
  }, [router, number, root]);
  const rerunChecks = useCallback(async (): Promise<void> => {
    if (!host || !root || checksBusy) return;
    setChecksBusy(true);
    setChecksSaid(null);
    const answer = await ask<{ ok: boolean; detail?: string; error?: string }>(host, "/prs/rerun", {
      method: "POST", body: { root, number: Number(number) },
    });
    setChecksBusy(false);
    if (!answer.ok) { setChecksSaid(answer.error); return; }
    if (!answer.value.ok) { setChecksSaid(answer.value.error ?? "GitHub refused the re-run."); return; }
    setChecksOpen(false);
    void load();
  }, [host, root, number, checksBusy, load]);
  /** What the Overview's Talk preview draws: the newest entry, and the count
   *  behind "All N". Null when nobody has said anything. */
  const talkCount = detail ? conversation(detail).length : 0;
  const said = useMemo(() => (detail ? lastSaid(detail) : null), [detail]);
  /** What the Overview leads with: can it merge and whose move is it, and who
   *  has reviewed. See src/model/prOverview.ts. */
  const banner = useMemo(() => (detail ? mergeBanner(detail) : null), [detail]);
  const reviewers = useMemo(() => (detail ? reviewerRows(detail) : []), [detail]);
  const files = detail?.files ?? [];
  const openThreads = (detail?.threads ?? []).filter((t) => !t.isResolved).length;

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Stack.Screen
        options={{
          // The mock's header: the number and the title in one strong line,
          // then the repository, who wrote it and when under it.
          headerTitle: () => (
            <View style={{ maxWidth: 278 }}>
              <Text numberOfLines={1} style={{ color: C.text, fontSize: 17, fontWeight: "600" }}>
                {pane === "conversation" ? `Talk on #${number}` : `#${number}${detail ? ` · ${detail.title}` : ""}`}
              </Text>
              {detail ? (
                <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.small }}>
                  {pane === "conversation"
                    ? `${detail.reviews?.length ?? 0} review${(detail.reviews?.length ?? 0) === 1 ? "" : "s"} · ${detail.comments?.length ?? 0} comment${(detail.comments?.length ?? 0) === 1 ? "" : "s"} · ${repoOf(detail.url) ?? detail.baseRefName}`
                    : `${repoOf(detail.url) ?? detail.baseRefName} · ${detail.author} · ${since(detail.updatedAt, now)}`}
                </Text>
              ) : null}
            </View>
          ),
          headerRight: detail ? () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Tell me when this run changes`}
              onPress={() => setWatching(true)}
              style={({ pressed }) => ({
                width: TAP, height: TAP, borderRadius: TAP / 2, alignItems: "center", justifyContent: "center",
                backgroundColor: pressed ? C.bg3 : "transparent",
              })}
            >
              <Glyph name="bell" color={C.primary} size={20} />
            </Pressable>
          ) : undefined,
        }}
      />

      {/*
        One screen, three panes.

        Reading a pull request used to be three screens deep: the overview, then
        push for the diff, then back, then push for the threads, then back to
        approve. A review is a loop between those three — read the code, answer
        the remark it prompted, read the next file — and every turn of that loop
        was a back gesture.

        The segments are drawn only once the detail is in, because a control
        that appears a beat after the screen does is a control the thumb has
        already moved past.
      */}
      {detail ? (
        <View style={{ paddingHorizontal: 12, paddingTop: SPACE.sm }}>
          <Segmented
            options={[
              { id: "overview", label: "Overview" },
              { id: "conversation", label: "Talk", count: conversation(detail).length || undefined },
              // The mock's segment is a DOOR to the job list, not a fourth
              // pane: the run is a screen of its own because a log is hundreds
              // of lines somebody scrolls.
              { id: "checks", label: "Checks", count: detail.checks.total || undefined },
              { id: "files", label: "Files", count: files.length || undefined },
            ]}
            value={pane}
            onChange={(next) => {
              if (next === "checks") { openChecks(); return; }
              setPane(next as Pane);
            }}
          />
        </View>
      ) : null}

      {/*
        A pane is mounted the first time it is opened and never unmounted after
        that, which is the whole of "keeps its place". Losing your position in a
        600-line diff because you went to read a comment is the thing being
        fixed here, and a pane that re-mounts starts at the top.

        Hidden with `display: "none"` rather than by not rendering: the tree
        stays, its scroll offset with it, and React Native stops laying it out.
      */}
      <View style={{ flex: 1, display: pane === "overview" ? "flex" : "none" }}>
      <ScrollView
        contentContainerStyle={{ padding: 12, gap: 12, paddingBottom: SPACE.xl }}
        refreshControl={<RefreshControl refreshing={pulling} onRefresh={pull} tintColor={C.text3} />}
      >
        {error ? (
          <Card>
            <Label text="Cannot read it" />
            <Note tone="bad">{error}</Note>
          </Card>
        ) : null}

        {!detail && !error ? <ActivityIndicator color={C.text3} /> : null}

        {detail ? (
          <>
            {/* The title and its line live in the header (mock 32): "#184 · Add
                dark mode" over "acme/orbit · ana · 2 h ago". The body starts on
                the question the screen exists to answer — can this land. */}
            {detail.forcePushedSinceReview ? (
              <Note>The author force-pushed after a review — anything already said may be stale.</Note>
            ) : null}

            {/*
              Can it merge, who has said what, what is it for.

              The detail used to say this as three rows, one of them "Merge"
              with the verdict as its title: the answer a person opens a pull
              request on, drawn as a line among lines. It leads now as a strip
              that says why and whose move it is, and the strip is the door to
              the merge sheet. The checks keep a row, because that one opens
              the job list and the run is what it is about.
            */}
            {banner ? (
              <MergeBannerCard
                chip={{
                  label: jobsPassedLine(detail.checks),
                  tone: detail.checks.failure ? "bad" : detail.checks.total ? "good" : "neutral",
                  icon: detail.checks.total ? (
                    <View style={{
                      width: 6, height: 6, borderRadius: 3,
                      backgroundColor: detail.checks.failure ? C.error : C.success,
                    }} />
                  ) : undefined,
                }}
                when={runningCheckLine(detail.checksAll ?? [], now)}
                text={banner.text}
                onPress={banner.open && mayWrite ? () => { setMergeErr(null); setMerging(true); } : undefined}
              />
            ) : null}
            {/* The behind row (s32). Drawn only when there is something to
                say: an "up to date" line on every pull request is a line
                nobody reads. */}
            {detail.state === "OPEN" && behind && (behind.behind ?? 0) > 0 ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${behindLine(behind, detail.baseRefName)}. Opens the sync options.`}
                onPress={() => setSyncing(true)}
                style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
              >
                <Card style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 12, paddingHorizontal: 13 }}>
                  <View style={{
                    width: 30, height: 30, borderRadius: 9, alignItems: "center", justifyContent: "center",
                    backgroundColor: tint(C.warning, 0.14),
                  }}>
                    <Glyph name="refresh" color={C.warning} size={16} weight={1.9} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                    <Text numberOfLines={1} style={{ color: C.text, fontSize: 13.5, fontWeight: "600" }}>
                      {behindLine(behind, detail.baseRefName)}
                    </Text>
                    <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.small }}>
                      {detail.mergeable === "CONFLICTING" ? "Conflicts with the base"
                        : detail.mergeable === "MERGEABLE" ? "No conflicts"
                          : "Conflict state not known yet"} · {detail.headRefName}
                    </Text>
                  </View>
                  <Chip label={`${behind.behind ?? 0} behind`} tone="warn" />
                  <ChevronIcon color={C.text3} size={18} />
                </Card>
              </Pressable>
            ) : detail.state === "OPEN" && behindErr ? (
              <Note>{behindErr}</Note>
            ) : null}
            {/* The pull request itself: what it is, the branch, the card it
                belongs to, its size, the description, and the door to a window
                on the computer. The mock puts all of that in one card, and the
                terminal door in it rather than in the bottom bar — so it moved
                here rather than disappearing. */}
            <View style={{ gap: 2 }}>
              <Eyebrow text="The pull request" />
              <Card style={{ gap: SPACE.sm, paddingVertical: 12, paddingHorizontal: 13 }}>
                <Text style={{ color: C.text, fontSize: 16, fontWeight: "600", lineHeight: 21, letterSpacing: -0.2 }}>
                  {detail.title}
                </Text>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
                  <View style={{
                    height: 24, justifyContent: "center", paddingHorizontal: 7, borderRadius: 7,
                    borderWidth: 1, borderColor: C.border,
                  }}>
                    <Text numberOfLines={1} style={{ color: C.text2, fontSize: 11.5, fontWeight: "600", fontFamily: MONO }}>
                      {detail.headRefName}
                    </Text>
                  </View>
                  {/* The card it belongs to, where the mock draws it. It says
                      nothing at all on a machine that tracks work nowhere. */}
                  <TaskChip
                    pr={detail}
                    tracked={tracked}
                    jira={jira}
                    onFind={(query) => router.push({ pathname: "/(tabs)/tasks", params: { q: query } })}
                    onOpenCard={provider?.id === "clickup"
                      ? (id) => router.push({ pathname: "/card/[id]", params: { id } })
                      : undefined}
                    onOpenJira={jira
                      ? (key) => router.push({ pathname: "/jira/[key]", params: { key } })
                      : undefined}
                  />
                  {detail.isDraft ? <Chip label="Draft" /> : null}
                  <Text style={{ marginLeft: "auto", fontSize: T.small, fontFamily: MONO, color: C.text3 }}>
                    +{detail.additions} −{detail.deletions}
                  </Text>
                </View>
                {detail.body.trim() ? (
                  <>
                    {/* Rendered, and folded by BLOCKS rather than by characters.
                        A cut at 1,200 characters landed mid-word and mid-checkbox;
                        a cut after six blocks lands between two things somebody
                        wrote, and the expander below can say what the rest is. */}
                    <Md text={detail.body.trim()} host={host} repo={repoOf(detail.url) ?? undefined} limit={bodyOpen ? undefined : BODY_BLOCKS} />
                    {rest.hidden ? (
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => setBodyOpen((was) => !was)}
                        style={{ minHeight: TAP, flexDirection: "row", alignItems: "center", gap: SPACE.sm }}
                      >
                        <Text style={{ color: C.primary, fontSize: T.body, fontWeight: "600" }}>
                          {bodyOpen
                            ? "Show less"
                            : rest.nextHeading
                              ? `${rest.nextHeading}${rest.hidden > 1 ? ` and ${rest.hidden - 1} more` : ""}`
                              : `${rest.hidden} more`}
                        </Text>
                      </Pressable>
                    ) : null}
                  </>
                ) : null}
                {root ? (
                  <Btn
                    label={`Open in the terminal${checkoutName ? ` · ${checkoutName}` : ""}`}
                    onPress={() => router.push({ pathname: "/(tabs)/terminal", params: { where: root } })}
                  />
                ) : mayWrite ? (
                  <Btn
                    label="Ask Claude · opens a window on the computer"
                    onPress={() => setHanding(true)}
                  />
                ) : null}
              </Card>
            </View>

            {/* Checks: the run in one line and a strip of its squares, opening
                the job list. The mock's "All 3 jobs" is the same door, said
                with the count. */}
            <View style={{ gap: 2 }}>
              <Head
                text="Checks"
                action={detail.checks.total ? `All ${detail.checks.total} jobs` : undefined}
                onAction={detail.checks.total ? openChecks : undefined}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Checks: ${runLine(detail.checks)}`}
                disabled={!detail.checks.total}
                onPress={openChecks}
                style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
              >
                <Card style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 11, paddingHorizontal: 13 }}>
                  <View style={{ flex: 1, minWidth: 0, gap: SPACE.sm }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
                      <View style={{
                        width: 7, height: 7, borderRadius: 4,
                        backgroundColor: detail.checks.failure ? C.error : detail.checks.pending ? C.warning : C.success,
                      }} />
                      <Text numberOfLines={1} style={{ color: C.text, fontSize: 12.5, fontWeight: "600" }}>
                        {jobsPassedLine(detail.checks)}
                        {detail.checks.pending ? <Text style={{ color: C.warning }}>{` · ${detail.checks.pending} running`}</Text> : null}
                      </Text>
                      {detail.checks.total ? (
                        <Text style={{ marginLeft: "auto", color: C.text3, fontSize: T.small, fontVariant: ["tabular-nums"] }}>
                          shown {Math.min(detail.checks.total, 10)}
                        </Text>
                      ) : null}
                    </View>
                    {detail.checks.total ? (
                      <View style={{ flexDirection: "row", gap: 4, flexWrap: "wrap" }}>
                        {runSquares(detail.checks).map((square, i) => (
                          <View
                            key={i}
                            style={{
                              width: 12, height: 12, borderRadius: 3,
                              backgroundColor: SQUARE[square](),
                              borderWidth: square === "skip" ? 1 : 0,
                              borderColor: C.border2,
                            }}
                          />
                        ))}
                      </View>
                    ) : null}
                  </View>
                  {detail.checks.total ? <ChevronIcon color={C.text3} size={18} /> : null}
                </Card>
              </Pressable>
            </View>

            {reviewers.length || mayWrite ? (
              <View style={{ gap: 2 }}>
                <Head
                  text="Reviewers"
                  action={mayWrite ? "Request" : undefined}
                  onAction={mayWrite ? () => setReviewersOpen(true) : undefined}
                />
                {reviewers.length
                  ? <ReviewersCard rows={reviewers} now={now} />
                  : <Note>Nobody has been asked yet.</Note>}
              </View>
            ) : null}
            {/* Labels, as the mock draws them: chips in a row, with the sheet
                that writes them one press away. A read-only phone sees the
                labels and no Edit, rather than a dead one. */}
            <View style={{ gap: 2 }}>
              <Head
                text="Labels"
                action={mayWrite ? "Edit" : undefined}
                onAction={mayWrite ? () => setLabelsOpen(true) : undefined}
              />
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, paddingHorizontal: 2 }}>
                {detail.labels.length
                  ? detail.labels.map((l) => <LabelChip key={l.name} name={l.name} color={l.color} />)
                  : <Text style={{ color: C.text4, fontSize: T.small }}>No labels</Text>}
              </View>
            </View>
            {/* The files, as one row: the mock's overview does not list them,
                and the list is the Files segment's job — where every one of
                them, with its own diff, already lives. The row opens the mock's
                preview (35) first: three files fit in a sheet, and "Open the
                diff" is the door that used to be the only one. */}
            {files.length ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${files.length} files changed. Opens the list.`}
                onPress={() => setFilesOpen(true)}
                style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
              >
                <Card style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 12, paddingHorizontal: 13 }}>
                  <View style={{
                    width: 30, height: 30, borderRadius: 9, alignItems: "center", justifyContent: "center",
                    backgroundColor: C.bg3,
                  }}>
                    <Glyph name="file" color={C.text2} size={16} weight={1.8} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                    <Text style={{ color: C.text, fontSize: 13.5, fontWeight: "600" }}>
                      {files.length} file{files.length === 1 ? "" : "s"} changed
                    </Text>
                    <Text numberOfLines={1} ellipsizeMode="head" style={{ color: C.text3, fontSize: T.small }}>
                      {files[0]?.path}{files.length > 1 ? ` and ${files.length - 1} more` : ""}
                    </Text>
                  </View>
                  <Text style={{ fontSize: T.small, fontFamily: MONO, color: C.text3 }}>+{detail.additions}</Text>
                  <Text style={{ fontSize: T.small, fontFamily: MONO, color: C.error }}>−{detail.deletions}</Text>
                  <ChevronIcon color={C.text3} size={18} />
                </Card>
              </Pressable>
            ) : null}

            {/* The last thing said, where the mock puts it: the newest entry,
                with the count behind "All N" opening the conversation. */}
            {said ? (
              <View style={{ gap: 2 }}>
                <Head
                  text="Talk"
                  action={`All ${talkCount}`}
                  onAction={() => setPane("conversation")}
                />
                <Card style={{ gap: SPACE.sm, paddingVertical: 10, paddingHorizontal: 12 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
                    <Avatar name={said.who} login={said.who} size={22} />
                    <Text style={{ color: C.text, fontSize: 12.5, fontWeight: "600" }}>{said.who}</Text>
                    <View style={{ flex: 1 }} />
                    <Text style={{ color: C.text3, fontSize: T.small }}>
                      {ago(said.when, now).replace(/ ago$/, "")}
                    </Text>
                  </View>
                  <Text numberOfLines={3} style={{ color: C.text2, fontSize: 13, lineHeight: 19 }}>
                    {said.text}
                  </Text>
                </Card>
              </View>
            ) : null}

            {/* The card this belongs to. The mock's overview draws no row for
                it — its chip in the card above is the door — but the row says
                whose card it is and how many people are on it, and a door the
                mock does not have is kept rather than dropped: below the last
                thing the mock does draw. */}
            {host && tracked !== false ? (
              <LinkedCard
                host={host} pr={detail} tracked={tracked} jira={jira}
                onOpen={provider?.id === "clickup" || jira
                  ? (id, tracker) => router.push(tracker === "jira"
                    ? { pathname: "/jira/[key]", params: { key: id } }
                    : { pathname: "/card/[id]", params: { id } })
                  : undefined}
              />
            ) : null}

            {(detail.threads ?? []).length ? (
              <View style={{ gap: SPACE.sm }}>
                <Label text={`Threads · ${openThreads} open`} />
                <Card>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => setPane("threads")}
                    style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm, minHeight: TAP }}
                  >
                    <Text style={{ color: C.text2, fontSize: T.body, flex: 1 }}>
                      {openThreads === 0
                        ? "Every conversation is resolved"
                        : openThreads === 1
                          ? "One conversation is waiting on somebody"
                          : `${openThreads} conversations are waiting on somebody`}
                    </Text>
                    <ChevronIcon color={C.text4} size={17} />
                  </Pressable>
                </Card>
              </View>
            ) : null}

            {/* On somebody else's pull request, a comment that is not a review
                lives here rather than in the pinned bar: the bar holds the
                three things you open a pull request on a phone to DO, and a
                fourth button there would be in the way of those. On your own,
                Comment IS the bar's middle button. */}
            {mayWrite && !detail.viewerDidAuthor ? (
              <Btn
                label="Comment on it"
                onPress={() => { setCommentErr(null); setCommenting(true); }}
              />
            ) : null}

            <Btn label="Open on GitHub" onPress={() => { openHttp(detail.url); }} />
          </>
        ) : null}
      </ScrollView>
      </View>

      {/* Mounted on first visit and kept. `seen` is what makes that true: a
          pane the reader never opened costs nothing, and one they did keeps
          its scroll, its expanded threads and its half-typed remark. */}
      {seen.conversation ? (
        <View style={{ flex: 1, display: pane === "conversation" ? "flex" : "none" }}>
          <Timeline number={String(number)} root={root ?? ""} since={lastLooked ?? 0} onOpenThreads={() => setPane("threads")} />
          {/* The mock's Talk screen (33) ends on the verdict, not on a button
              that opens a sheet: approve, request changes or comment, a note,
              and one send. The note goes with the verdict in the same call. */}
          {mayWrite && !detail?.viewerDidAuthor ? (
            <View style={{
              gap: SPACE.sm, paddingHorizontal: SPACE.lg, paddingTop: SPACE.sm, paddingBottom: SPACE.lg,
              borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.bg2,
            }}>
              <Text style={{ color: C.text3, fontSize: T.small, lineHeight: 17 }}>
                <Text style={{ fontWeight: "700", color: C.text2 }}>The phone can review.</Text>
                {" "}Approve and Request changes are the same two writes the desktop makes; the note
                goes with them.
              </Text>
              <Segmented
                value={choice}
                onChange={setChoice}
                options={[
                  { id: "approve", label: "Approve" },
                  { id: "request_changes", label: "Request changes" },
                  { id: "comment", label: "Comment" },
                ]}
              />
              <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
                <TextInput
                  value={summary}
                  onChangeText={setSummary}
                  placeholder="A note with your review…"
                  placeholderTextColor={C.text4}
                  accessibilityLabel="A note with your review"
                  style={{
                    flex: 1, minHeight: TAP, borderWidth: 1, borderColor: C.border, borderRadius: TAP / 2,
                    backgroundColor: C.bg, color: C.text, paddingHorizontal: SPACE.md, fontSize: T.body,
                  }}
                />
                {/* The mock's send (33): one round button, the arrow already
                    saying what it does. The verdict it carries is the segment
                    above, so the button wears the same ink. */}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Send: ${choice === "approve" ? "approve" : choice === "request_changes" ? "request changes" : "comment"}`}
                  disabled={!!verdict}
                  onPress={() => { void send(choice); }}
                  style={({ pressed }) => ({
                    width: TAP, height: TAP, borderRadius: TAP / 2, alignItems: "center", justifyContent: "center",
                    backgroundColor: choice === "request_changes" ? C.error : C.primary,
                    opacity: verdict ? 0.5 : pressed ? 0.75 : 1,
                  })}
                >
                  <Glyph name="up" color={ink(choice === "request_changes" ? C.error : C.primary)} size={20} weight={2.2} />
                </Pressable>
              </View>
              {sent ? <Note tone="bad">{sent}</Note> : null}
            </View>
          ) : null}
        </View>
      ) : null}

      {seen.files ? (
        <View style={{ flex: 1, display: pane === "files" ? "flex" : "none" }}>
          <FilesPane number={String(number)} root={root ?? ""} path={file ?? undefined} bar={false} />
        </View>
      ) : null}

      {seen.threads ? (
        <View style={{ flex: 1, display: pane === "threads" ? "flex" : "none" }}>
          <ThreadsPane number={String(number)} root={root ?? ""} />
        </View>
      ) : null}

      {/*
        The bar, pinned: Ask Claude, Review, Merge. It is the reason to be on
        this screen, so it does not scroll away under a long description.

        Only for a phone that may write. "✦ Claude" used to be drawn for every
        pairing while `hand` returned early without the full grant — a button
        that did nothing on the phones most likely to press it. The scope rule
        everywhere else is "not drawn rather than drawn and refused", and this
        bar now keeps it.

        On your own pull request the middle button is Comment: GitHub will not
        let you review your own work, and a greyed Review there was a button
        that could only ever be a reason.
      */}
      {detail && mayWrite ? (
        <View style={{
          flexDirection: "row", gap: SPACE.sm, alignItems: "center",
          paddingHorizontal: SPACE.lg, paddingTop: SPACE.md, paddingBottom: SPACE.lg,
          borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.bg2,
        }}>
          {/* The mock's bar (32): More, Review, Merge. "Ask Claude" moved into
              the pull request card above, which is where the mock puts the door
              to a window on the computer — moved, not dropped. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`More on #${number}: labels, reviewers, edit, draft, close`}
            onPress={() => setManaging(true)}
            style={({ pressed }) => ({
              width: TAP, height: TAP, borderRadius: RADIUS.md, alignItems: "center", justifyContent: "center",
              borderWidth: 1, borderColor: C.border, opacity: pressed ? 0.6 : 1,
            })}
          >
            <Glyph name="more" color={C.text2} size={20} weight={2} />
          </Pressable>
          {detail.viewerDidAuthor ? (
            <Btn label="Comment" style={{ flex: 1 }} onPress={() => { setCommentErr(null); setCommenting(true); }} />
          ) : (
            <Btn
              label={notes.length ? `Review · ${notes.length}` : "Review"}
              style={{ flex: 1 }}
              onPress={() => setReviewing(true)}
            />
          )}
          {/*
            Merge is drawn when merging is blocked, greyed by its tone rather
            than hidden, because the reason is the useful part and a control
            that vanishes teaches nothing. That is the argument PrMergeState
            carries in shared/types.ts: "a disabled control that can't say why
            is the thing this panel exists to replace" — so the sheet says why.
          */}
          <Btn
            label="Merge"
            tone={gate && !gate.blocked ? "good" : "plain"}
            style={{ flex: 1.2 }}
            disabled={detail.state !== "OPEN"}
            onPress={() => { setMergeErr(null); setMerging(true); }}
          />
        </View>
      ) : null}

      <ChecksSheet
        open={checksOpen}
        onClose={() => setChecksOpen(false)}
        number={Number(number)}
        checks={detail?.checksAll ?? []}
        mayWrite={mayWrite}
        busy={checksBusy}
        said={checksSaid}
        onRerun={() => { void rerunChecks(); }}
        onOpenRun={openRun}
      />

      {/* The files, before the diff (mock 35): three rows with their own +/−,
          and one door into the pane that draws them. */}
      {detail && files.length ? (
        <Sheet
          open={filesOpen}
          onClose={() => setFilesOpen(false)}
          title={`${files.length} file${files.length === 1 ? "" : "s"} changed`}
          subtitle={`+${detail.additions} −${detail.deletions} · ${files[0]?.path?.split("/").slice(0, -1).join("/") || "the root"}${detail.headSha ? ` · ${detail.headSha.slice(0, 7)}` : ""}.`}
          footer={<Btn label="Open the diff" onPress={() => { setFilesOpen(false); setPane("files"); }} style={{ flex: 1 }} />}
        >
          <View style={{ paddingTop: SPACE.sm }}>
            {files.map((f) => (
              <Pressable
                key={f.path}
                accessibilityRole="button"
                accessibilityLabel={`${f.path}. Opens it in the diff.`}
                onPress={() => { setFilesOpen(false); setFile(f.path); setPane("files"); }}
                style={({ pressed }) => ({
                  minHeight: 58, flexDirection: "row", alignItems: "center", gap: SPACE.md,
                  paddingVertical: SPACE.sm, opacity: pressed ? 0.6 : 1,
                })}
              >
                <View style={{ width: 30, height: 30, borderRadius: 10, backgroundColor: C.bg3, alignItems: "center", justifyContent: "center" }}>
                  <Glyph name="file" color={C.text2} size={16} weight={1.8} />
                </View>
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <Text numberOfLines={1} style={{ color: C.text, fontSize: 12.5, fontWeight: "600", fontFamily: MONO }}>
                    {f.path.split("/").pop()}
                  </Text>
                  <Text numberOfLines={1} ellipsizeMode="head" style={{ color: C.text3, fontSize: T.small }}>{f.path}</Text>
                </View>
                <Text style={{ color: C.success, fontSize: T.small, fontWeight: "700", fontVariant: ["tabular-nums"] }}>+{f.additions}</Text>
                <Text style={{ color: C.error, fontSize: T.small, fontWeight: "700", fontVariant: ["tabular-nums"] }}>−{f.deletions}</Text>
              </Pressable>
            ))}
          </View>
          <Note>
            <Text style={{ fontWeight: "700", color: C.text2 }}>One row is one file.</Text>
            {" "}Test files stay where the diff puts them; the pane folds nothing away.
          </Note>
        </Sheet>
      ) : null}

      <Sheet open={reviewing} onClose={() => setReviewing(false)} title="Send your review">
        {/* What GitHub is already holding, first — because it is the half you
            did not write on this phone and would otherwise submit unseen. */}
        {pending === "asking" ? (
          <View style={{ paddingBottom: SPACE.md }}>
            <Note>Asking GitHub whether a review is already started…</Note>
          </View>
        ) : pending === "unknown" ? (
          <View style={{ paddingBottom: SPACE.md }}>
            <Note>
              Could not ask GitHub whether a review is already started here. If one is, the review
              you submit below takes it along.
            </Note>
          </View>
        ) : pending.length ? (
          <View style={{ gap: SPACE.xs, paddingBottom: SPACE.md }}>
            <Label text={`${pending.length} already on GitHub`} />
            {pending.map((c, i) => (
              <View key={`${c.path}:${c.line}:${i}`} style={{ paddingVertical: SPACE.xs }}>
                <Text numberOfLines={2} style={{ color: C.text2, fontSize: T.small }}>{c.body}</Text>
                <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.eyebrow, fontFamily: MONO }}>
                  {c.path}{c.line === null ? "" : `:${c.line}`}
                </Text>
              </View>
            ))}
            <Note>
              Started somewhere else and never sent. The review you submit below takes these along.
            </Note>
          </View>
        ) : null}

        {notes.length ? (
          <View style={{ gap: SPACE.xs, paddingBottom: SPACE.md }}>
            <Label text={`${notes.length} ${notes.length === 1 ? "comment" : "comments"} queued`} />
            {notes.map((n) => (
              <View key={`${n.path}:${n.line}`} style={{ paddingVertical: SPACE.xs }}>
                <Text numberOfLines={1} style={{ color: C.text2, fontSize: T.small }}>{n.body}</Text>
                <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.eyebrow, fontFamily: MONO }}>
                  {n.path}:{n.line}
                </Text>
              </View>
            ))}
          </View>
        ) : (
          <View style={{ paddingBottom: SPACE.md }}>
            <Note>
              {Array.isArray(pending) && pending.length
                ? "Nothing written on this phone. Open the files above to add to it."
                : "No line comments. Open the files above to write one."}
            </Note>
          </View>
        )}

        <TextInput
          value={summary}
          onChangeText={setSummary}
          placeholder="Summary — optional"
          placeholderTextColor={C.text3}
          multiline
          style={{
            minHeight: 72, borderWidth: 1, borderColor: C.border, borderRadius: RADIUS.md,
            backgroundColor: C.bg, color: C.text, padding: SPACE.md, fontSize: T.body,
          }}
        />

        {/*
          The verdict is chosen, then sent: one button. It was three pressed
          buttons side by side, Approve over Request changes beside Comment,
          and a verdict is the one thing on this sheet that cannot be taken
          back — three live targets a thumb-width apart is where the wrong one
          gets pressed.
        */}
        <View accessibilityRole="radiogroup" style={{ paddingTop: SPACE.md }}>
          {VERDICTS.map((v) => {
            const on = choice === v.id;
            return (
              <Pressable
                key={v.id}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
                onPress={() => setChoice(v.id)}
                style={({ pressed }) => ({
                  flexDirection: "row", alignItems: "center", gap: 14, minHeight: 56,
                  paddingVertical: SPACE.sm, backgroundColor: pressed ? C.bg3 : "transparent",
                })}
              >
                <View style={{
                  width: 22, height: 22, borderRadius: 11, borderWidth: 2,
                  borderColor: on ? C.primary : C.text4, alignItems: "center", justifyContent: "center",
                }}>
                  {on ? <View style={{ width: 11, height: 11, borderRadius: 6, backgroundColor: C.primary }} /> : null}
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={{ color: C.text, fontSize: 15, fontWeight: "500" }}>{v.label}</Text>
                  <Text style={{ color: C.text3, fontSize: T.small }}>{v.what}</Text>
                </View>
              </Pressable>
            );
          })}
        </View>
        <View style={{ paddingTop: SPACE.md }}>
          <Btn
            label="Submit review"
            tone={choice === "request_changes" ? "danger" : "primary"}
            busy={!!verdict}
            disabled={!!verdict}
            onPress={() => { void send(choice); }}
          />
        </View>

        {sent ? <View style={{ paddingTop: SPACE.sm }}><Note tone="bad">{sent}</Note></View> : null}

        <View style={{ paddingTop: SPACE.md }}>
          <Note>
            {/* The property this whole queue exists for, said where it is
                being relied on. */}
            The verdict and every comment go in one call, so a dropped connection cannot leave half
            a review on GitHub.
          </Note>
        </View>
      </Sheet>

      <Sheet open={commenting} onClose={() => setCommenting(false)} title={`Comment on #${number}`}>
        <TextInput
          value={comment}
          onChangeText={setComment}
          placeholder="What do you want to say?"
          placeholderTextColor={C.text4}
          multiline
          style={{
            minHeight: 96, borderWidth: 1, borderColor: C.border, borderRadius: RADIUS.md,
            backgroundColor: C.bg, color: C.text, padding: SPACE.md, fontSize: T.body,
          }}
        />
        <View style={{ paddingTop: SPACE.md, gap: SPACE.sm }}>
          <Btn
            label="Post it"
            tone="primary"
            busy={commentBusy}
            disabled={!comment.trim() || commentBusy}
            onPress={() => { void saySomething(); }}
          />
          {commentErr ? <Note tone="bad">{commentErr}</Note> : null}
          {/* The distinction, said once and where it is being made. */}
          <Note>
            Goes on the conversation, on its own. A remark about a LINE belongs in the diff, where
            it waits for a verdict and goes with it.
          </Note>
        </View>
      </Sheet>

      <Sheet
        open={merging}
        onClose={() => setMerging(false)}
        title={`Merge #${number}`}
        subtitle={detail ? `${detail.headRefName} into ${detail.baseRefName} · ${detail.checks.success} of ${detail.checks.total} check${detail.checks.total === 1 ? "" : "s"} passed.` : undefined}
      >
        {detail ? (
          <View style={{ gap: SPACE.md, paddingBottom: SPACE.md }}>
            {/* The verdict first, in both directions. "Ready to merge" is worth
                as much as the reason it is not: somebody who opened this sheet
                has already decided to press the button, and this is the last
                place to tell them the branch is behind. */}
            <Note tone={gate?.blocked ? "bad" : "quiet"}>{gate?.line ?? ""}</Note>

            {/* Then the parts of it, when it is blocked: the line above names
                the first problem, and a pull request that is red, behind and
                unreviewed is all three. A failed check opens the logs; the
                rest are fixed on GitHub or on the branch, and say where. */}
            {gate?.blocked && obstacles.length ? (
              <View>
                <GroupTitle text="What is in the way" />
                <Group inset={52}>
                  {obstacles.map((o) => (
                    <Row
                      key={o.title}
                      title={o.title}
                      sub={o.sub}
                      lead={<Glyph name={o.tone === "bad" ? "x_circle" : "alert"} color={o.tone === "bad" ? C.error : C.warning} size={22} weight={1.9} />}
                      chevron={!!o.opens}
                      onPress={o.opens ? () => {
                        setMerging(false);
                        router.push({ pathname: "/pr/checks", params: { number: String(number), root: root ?? "" } });
                      } : undefined}
                    />
                  ))}
                </Group>
              </View>
            ) : null}

            {/* The arm comes first (mock 36): "merge when it passes" is the
                question somebody opening this sheet has already answered. */}
            <Row
              title={detail.checks.pending ? "Merge when the run passes" : "Merge when it goes green"}
              sub={
                detail.mergePolicy && !detail.mergePolicy.auto
                  ? "This repository does not allow auto-merge."
                  : refusals?.autoRefusal
                  ? `${refusals.autoRefusal}.`
                  : `${detail.checks.pending ? "A check is still running. " : ""}Off merges now, without waiting.`
              }
              checked={autoOn}
              trail={<Switch on={autoOn} disabled={(!!detail.mergePolicy && !detail.mergePolicy.auto) || !!refusals?.autoRefusal} />}
              disabled={(!!detail.mergePolicy && !detail.mergePolicy.auto) || !!refusals?.autoRefusal}
              onPress={() => setAuto((v) => !v)}
            />

            {/* Only what the repository permits. A repository that forbids
                squash used to be offered it anyway, which is a button that
                fails after you have chosen. */}
            <View style={{ gap: SPACE.sm }}>
              <Label text="How it lands" />
              <Segmented
                value={method ?? methods[0]!}
                onChange={(m) => setMethod(m)}
                options={methods.map((m) => ({ id: m, label: MERGE_OPTION[m].label }))}
              />
              {method ? <Note>{MERGE_OPTION[method].hint}</Note> : null}
            </View>
            <Row
              title="Delete the branch after it lands"
              sub={
                detail.mergePolicy?.deletesBranch
                  ? "This repository already does it — leave it off."
                  : `${detail.headRefName} is only this pull request.`
              }
              checked={deleteBranch}
              trail={<Switch on={deleteBranch} />}
              onPress={() => setDeleteBranch((v) => !v)}
            />

            {/* GitHub's verdict above is about whether it will TAKE the merge,
                not about the review sitting under it — a required approval is
                the only kind `gate` refuses over, and branch protection can
                leave a CHANGES_REQUESTED review mergeable anyway. Said here so
                the button one screen down does not contradict the green line
                above it. */}
            {changesRequested ? (
              <Row
                title={changesRequested.who ? `${changesRequested.who} asked for changes` : "Changes were requested"}
                sub={`${changesRequested.at ? `${ago(changesRequested.at, now)}. ` : ""}GitHub still allows the merge.`}
                lead={<Glyph name="comment" color={C.error} size={16} weight={1.9} />}
                trail={<Chip label={changesRequested.threads ? `${changesRequested.threads} change${changesRequested.threads === 1 ? "" : "s"}` : "changes"} tone="bad" />}
              />
            ) : null}

            {detail.headSha ? (
              <Note>
                {/* Said out loud because it is the difference between a merge
                    and a merge of something nobody read. */}
                Merging {detail.headSha.slice(0, 7)} — the commit these checks are about. If the
                author has pushed since, GitHub will refuse rather than land it.
              </Note>
            ) : (
              <Note tone="bad">
                The checks for this commit have not arrived, so there is nothing to hold the merge
                to. It will land whatever the head is now.
              </Note>
            )}

            {refusals?.refusal ? <Note tone="bad">{refusals.refusal}</Note> : null}
            {mergeErr ? <Note tone="bad">{mergeErr}</Note> : null}

            {/* Blocked is not disabled. GitHub is the authority on whether it
                will take it, `mergeState` can be stale by minutes, and a
                BLOCKED that is really "a required reviewer approved thirty
                seconds ago" would leave the only way through on the desktop.
                It refuses on the server if it must, and the reason lands above.

                The press holds (model/confirmPolicy.ts): a merge writes a
                permanent commit on somebody's base branch, and it is the one
                write on this screen a second tap cannot undo. */}
            <HoldButton
              action="pr.merge"
              label={autoOn ? "Merge when green" : "Merge"}
              onConfirm={() => { void doMerge(); }}
              onRelease={(line) => setMergeErr(line)}
              disabled={!method || detail.state !== "OPEN" || mergeBusy || !!refusals?.refusal}
            />
            <Note>
              <Text style={{ fontWeight: "700", color: C.text2 }}>One write, the same one the desktop makes.</Text>
              {" "}The method is the one this repository allows, and the arm waits on the computer if this
              phone goes to sleep.
            </Note>
          </View>
        ) : null}
      </Sheet>

      <Sheet open={handing} onClose={() => setHanding(false)} title={`Ask Claude about #${number}`}>
        {menu === null ? (
          <Note>Reading the menu from the computer…</Note>
        ) : null}
        {menu?.recipes.length === 0 ? (
          <Note>
            Nothing in the catalogue applies to this pull request. The menu is edited on the
            computer, in Settings then Review prompts.
          </Note>
        ) : null}
        {(menu?.recipes ?? []).map((recipe) => (
          <SheetRow
            key={recipe.id}
            label={recipe.title}
            // A skill line is what actually runs, and it is worth showing: it
            // is the difference between prose and `/pr-resolve-reviews 482`.
            sub={[
              recipe.id === menu?.suggested ? "suggested" : "",
              recipe.skill ? recipe.skill.trim().split(/\s/)[0] : "",
            ].filter(Boolean).join(" · ") || undefined}
            on={recipe.id === menu?.suggested}
            onPress={() => { void look(recipe); }}
          />
        ))}
        <View style={{ paddingTop: SPACE.md, gap: SPACE.xs }}>
          <Note>
            Opens a tmux window on the computer with the agent already running, and takes you to it.
          </Note>
          {/* Still true, and now checkable: the words are the computer's, and
              the next screen shows you which words before anything runs. */}
          <Note>
            The phone sends the number and which question to ask. The prompt itself is written on
            the computer — you see it before it goes.
          </Note>
        </View>
      </Sheet>

      {/* What it would say, over the menu it was chosen from. A second sheet
          rather than a replaced one, so Back lands on the list and not on the
          pull request. */}
      <Sheet
        open={!!preview}
        onClose={() => { setPreview(null); setHanding(true); }}
        title={preview?.title ?? ""}
      >
        {preview?.state === "asking" ? (
          <Note>Building it on the computer…</Note>
        ) : null}

        {preview?.state === "failed" ? (
          <View style={{ gap: SPACE.sm }}>
            <Note tone="bad">{preview.error}</Note>
            <Note>
              Nothing was started. The window opens only when you press Send below, and there is
              nothing to send until this reads.
            </Note>
          </View>
        ) : null}

        {preview?.state === "read" ? (
          <View style={{ gap: SPACE.md }}>
            {/* No ScrollView of its own. The sheet already scrolls and is
                already capped at 75% of the screen; a second one nested inside
                it is the arrangement react-native does not reliably scroll. */}
            <Text style={{
              color: C.text2, fontSize: T.small, fontFamily: MONO, lineHeight: 18,
              backgroundColor: C.bg, padding: SPACE.md, borderRadius: RADIUS.md,
            }}>{preview.prompt}</Text>
            {preview.cwd ? (
              <Text numberOfLines={1} ellipsizeMode="head" style={{
                color: C.text3, fontSize: T.eyebrow, fontFamily: MONO,
              }}>in {preview.cwd}</Text>
            ) : null}
            <Btn label="Send it" tone="primary" onPress={() => hand(preview.recipe)} />
            {/* The one thing a preview cannot show, said rather than implied:
                what travels is the id above it, and the computer builds these
                words again for itself. So this is a faithful reading of what
                will be asked, not a copy that gets sent. */}
            <Note>
              Read from the computer, which writes it again when the window opens. The phone sends
              the pull request number and the name of the question — never these words.
            </Note>
          </View>
        ) : null}
      </Sheet>

      {detail ? (
        <>
          <PrActionsSheet
            open={managing}
            onClose={() => setManaging(false)}
            host={host}
            root={root ?? ""}
            pr={detail}
            detail={detail}
            forMe={false}
            mayWrite={mayWrite}
            blocked={blocked}
            onSync={() => { setManaging(false); setSyncing(true); }}
            onWatch={() => { setManaging(false); setWatching(true); }}
            onMerge={() => { setManaging(false); setMergeErr(null); setMerging(true); }}
            onLabels={() => { setManaging(false); setLabelsOpen(true); }}
            onReviewers={() => { setManaging(false); setReviewersOpen(true); }}
            onAskClaude={() => { setManaging(false); setHanding(true); }}
            onChanged={() => { void refresh(); }}
          />
          <LabelsSheet
            open={labelsOpen}
            onClose={() => setLabelsOpen(false)}
            host={host}
            root={root ?? ""}
            number={detail.number}
            current={labelsOf(detail)}
            mayWrite={mayWrite}
            blocked={blocked}
            onSaved={() => { void refresh(); }}
          />
          <ReviewersSheet
            open={reviewersOpen}
            onClose={() => setReviewersOpen(false)}
            host={host}
            root={root ?? ""}
            detail={detail}
            mayWrite={mayWrite}
            blocked={blocked}
            onSaved={() => { void refresh(); }}
          />
          {host && detail ? (
          <WatchRuleSheet
            open={watching}
            onClose={() => setWatching(false)}
            host={host}
            pr={{
              root: root ?? "",
              repo: repoOf(detail.url) ?? detail.baseRefName,
              number: detail.number,
              title: detail.title,
            }}
            mayWrite={mayWrite}
            checks={detail.checksAll ?? []}
            onArmed={() => { void refresh(); }}
          />
          ) : null}
          <SyncSheet
            open={syncing}
            onClose={() => setSyncing(false)}
            host={host}
            root={root ?? ""}
            base={detail.baseRefName}
            targets={syncTargets}
            mayWrite={mayWrite}
            blocked={blocked}
            onDone={() => { void refresh(); }}
            onAgent={() => setHanding(true)}
          />
        </>
      ) : null}
    </View>
  );
}
