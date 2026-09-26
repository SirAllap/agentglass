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
 * "Hand to Claude" is why any of this exists. It does NOT post a prompt: it
 * puts `{cmd:"review", number, root, recipe}` on the terminal's socket, the
 * server looks that recipe id up in its own catalogue, builds the text, opens
 * a tmux window running the agent, and switches the pane. The socket carries an
 * intent and never a command line — see src/model/reviewMenu.ts for why that
 * shape is load-bearing rather than incidental.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Linking, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import type { PrDetail, ReviewRecipe, ReviewRecipesResponse } from "../../../shared/types.ts";
import { ask } from "../../src/lib/api.ts";
import { Md, outline } from "../../src/md/Md.tsx";
import { useAgentglass } from "../../src/state/host-context.tsx";
import { usePaletteTick } from "../../src/state/use-palette.ts";
import { usePrDetail } from "../../src/state/pr-detail.ts";
import { prMarkKey } from "../../../shared/prUnread.ts";
import { usePrTalkTick, useReloadOnTick } from "../../src/state/pr-talk.ts";
import { useReadOnOpen } from "../../src/state/read-marks.ts";
import { useTaskProvider, useTracksWork } from "../../src/state/use-tracks-work.ts";
import { TaskChip } from "../../src/review/TaskChip.tsx";
import { FilesPane } from "../../src/review/FilesPane.tsx";
import { ThreadsPane } from "../../src/review/ThreadsPane.tsx";
import { Timeline } from "../../src/review/Timeline.tsx";
import { conversation } from "../../../shared/prConversation.ts";
import { RECIPES_PATH, menuFor, situationOf } from "../../src/model/reviewMenu.ts";
import { requestHandoff } from "../../src/terminal/handoff.ts";
import { clearDraft, draft, forWire } from "../../src/model/reviewDraft.ts";
import { since } from "../../src/lib/dates.ts";
import { mergeVerdict } from "../../../shared/mergeReason.ts";
import {
  MERGE_LABEL, MERGE_OPTION, allowedMethods, mergeSubject, pickMergeMethod,
  type MergeMethod,
} from "../../../shared/mergeMethod.ts";
import { Btn, Card, Chip, Group, GroupTitle, Label, Note, Row, Segmented, Sheet, SheetRow, TAP, Toggle } from "../../src/ui.tsx";
import { mergeObstacles } from "../../src/model/mergeObstacles.ts";
import { Glyph, type GlyphName } from "../../src/nav/glyphs.tsx";
import { ChevronIcon } from "../../src/nav/icons.tsx";
import { C, MONO, RADIUS, SPACE, T, ink } from "../../src/theme.ts";

/** How much of a description shows before the fold. */
const BODY_BLOCKS = 6;

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

/** What GitHub decided, in the words the list already uses — so a row and its
 *  detail cannot describe the same pull request differently (see
 *  model/prLook.ts). */
function decisionLook(pr: PrDetail): { word: string; ink: string; mark: GlyphName } | null {
  if (pr.reviewDecision === "APPROVED") return { word: "Approved", ink: C.success, mark: "check" };
  if (pr.reviewDecision === "CHANGES_REQUESTED") return { word: "Changes requested", ink: C.error, mark: "comment" };
  if (pr.reviewDecision === "REVIEW_REQUIRED") {
    return { word: pr.viewerDidAuthor ? "Needs review" : "Needs your review", ink: C.warning, mark: "eye" };
  }
  return null;
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

/** The three verdicts, with what each one does — the words GitHub's own
 *  review form uses. */
const VERDICTS: { id: "approve" | "request_changes" | "comment"; label: string; what: string }[] = [
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

  const router = useRouter();
  const { number, root, review, pane: wanted, ask: asked } = useLocalSearchParams<{
    number: string; root: string; review?: string; pane?: string; ask?: string;
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

  const setPane = useCallback((next: Pane): void => {
    setPaneState(next);
    setSeen((was) => (was[next] ? was : { ...was, [next]: true }));
  }, []);

  /* Submitting a review writes to GitHub. A phone paired to answer gates does
     not get to, and the control is not drawn rather than drawn and refused —
     the rule repos.tsx set. Reading the diff and handing it to Claude both
     stay available, because neither writes anything. */
  const mayWrite = host?.scope === "full";

  /* One read for the whole review — the two panes below are looking at the
     same pull request, and a write in either of them re-reads this. Before
     that, resolving a thread left the count on this screen saying what it said
     when you arrived. See state/pr-detail.ts. */
  const { detail, error, reload: load, refresh } = usePrDetail(host, root ?? "", String(number ?? ""));
  /* Opening it is reading it: the mark moves to now, and what it was BEFORE is
     what the Talk pane draws its divider against. See state/read-marks.ts. */
  const lastLooked = useReadOnOpen(host, detail);

  // A live comment or review on THIS pull request. The key comes off the
  // detail's own URL, as the read marks' does: the route only carries a
  // checkout root and a number. Empty until the detail loads, which
  // subscribes to nothing.
  const talkKey = detail?.url ? prMarkKey(detail) : "";
  useReloadOnTick(usePrTalkTick(talkKey), refresh, talkKey);

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
        auto,
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
  }, [host, detail, root, method, deleteBranch, auto, load]);

  const now = Date.now();
  const checks = detail ? checksLook(detail) : null;
  const decision = detail ? decisionLook(detail) : null;
  const files = detail?.files ?? [];
  const shownFiles = allFiles ? files : files.slice(0, 6);
  const openThreads = (detail?.threads ?? []).filter((t) => !t.isResolved).length;
  /* The rollup's own list, not a second filter over `checksAll`. `failing` is
     computed on the server and is what the list rows already draw from, so a
     detail that disagreed with the row it was opened from would be this app
     answering one question two ways. */
  const failing = detail?.checks.failing ?? [];

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Stack.Screen options={{ title: `#${number}` }} />

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
        <View style={{ paddingHorizontal: SPACE.lg, paddingTop: SPACE.sm }}>
          <Segmented
            options={[
              { id: "overview", label: "Overview" },
              { id: "conversation", label: "Talk", count: conversation(detail).length || undefined },
              { id: "files", label: "Files", count: files.length },
              { id: "threads", label: "Threads", count: openThreads || undefined },
            ]}
            value={pane}
            onChange={setPane}
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
      <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.lg, paddingBottom: SPACE.xl }}>
        {error ? (
          <Card>
            <Label text="Cannot read it" />
            <Note tone="bad">{error}</Note>
          </Card>
        ) : null}

        {!detail && !error ? <ActivityIndicator color={C.text3} /> : null}

        {detail ? (
          <>
            <View style={{ gap: SPACE.sm }}>
              <Text style={{ color: C.text, fontSize: T.head, fontWeight: "700", lineHeight: 26 }}>
                {detail.title}
              </Text>
              <Text
                numberOfLines={1}
                style={{ color: C.text3, fontSize: T.eyebrow, fontFamily: MONO }}
              >{detail.headRefName} → {detail.baseRefName}</Text>
              <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm, flexWrap: "wrap" }}>
                {/* First, because it is the only chip that says what this pull
                    request is ABOUT — the rest say what state it is in. It
                    draws nothing at all on a machine that tracks work nowhere,
                    or on a pull request that names no item. */}
                <TaskChip
                  pr={detail}
                  tracked={tracked}
                  onFind={(query) => router.push({ pathname: "/(tabs)/tasks", params: { q: query } })}
                  onOpenCard={provider?.id === "clickup"
                    ? (id) => router.push({ pathname: "/card/[id]", params: { id } })
                    : undefined}
                />
                {detail.isDraft ? <Chip label="Draft" /> : null}
                <Text style={{ color: C.text3, fontSize: T.small }}>
                  {detail.author} · {since(detail.updatedAt, now)}
                </Text>
              </View>
              {detail.forcePushedSinceReview ? (
                <Note>The author force-pushed after a review — anything already said may be stale.</Note>
              ) : null}
            </View>

            {/*
              Is it all right: three rows, each a question with its answer.

              The detail used to say this as three outlined chips in a line
              under the title — "approved", "2 failed" — and a separate Failing
              card further down. The questions somebody opens a pull request on
              a phone with are exactly three, and each has a place to go for the
              rest: the checks, the threads, the merge. So each is a row, and
              the row is the door.
            */}
            <Group inset={52}>
              <Row
                title={checks?.word ?? "No checks"}
                sub={failing.length
                  ? failing.slice(0, 2).map((c) => c.name).join(", ") + (failing.length > 2 ? ` and ${failing.length - 2} more` : "")
                  : detail.checks.pending ? "Still running" : detail.checks.total ? "Every check passed" : "This repository runs none here"}
                lead={<Glyph name={checks?.mark ?? "circle"} color={checks?.ink ?? C.text4} size={22} weight={1.9} />}
                chevron={detail.checks.total > 0}
                /* Every failing check opens the same screen. The job list
                   there is the whole run, not one check: a failing `test` is
                   routinely a `build` that fell over first, and arriving
                   filtered to one row hides the job that actually broke. */
                onPress={detail.checks.total > 0 ? () => router.push({
                  pathname: "/pr/checks",
                  params: { number: String(number), root: root ?? "" },
                }) : undefined}
              />
              <Row
                title={decision?.word ?? "No review asked for"}
                sub={openThreads
                  ? `${openThreads} open ${openThreads === 1 ? "thread" : "threads"}`
                  : (detail.threads ?? []).length ? "Every thread resolved" : "No threads"}
                lead={<Glyph name={decision?.mark ?? "comment"} color={decision?.ink ?? C.text3} size={22} weight={1.9} />}
                chevron
                onPress={() => setPane("threads")}
              />
              <Row
                title={detail.state !== "OPEN" ? (detail.state === "MERGED" ? "Merged" : "Closed")
                  : detail.mergeable === "CONFLICTING" ? `Conflicts with ${detail.baseRefName}` : gate?.line ?? "Merge"}
                sub={detail.state === "OPEN" ? `${detail.headRefName} into ${detail.baseRefName}` : undefined}
                lead={<Glyph
                  name="merge"
                  color={detail.state === "MERGED" ? C.primary : gate && !gate.blocked && detail.mergeable !== "CONFLICTING" ? C.success : C.text3}
                  size={22}
                  weight={1.9}
                />}
                /* A conflict is a different need from a red check, and the list
                   carries `mergeable` for exactly that reason. UNKNOWN is
                   GitHub still computing it and must not be drawn as "fine",
                   which is why only CONFLICTING is named. */
                chevron={mayWrite && detail.state === "OPEN"}
                onPress={mayWrite && detail.state === "OPEN" ? () => { setMergeErr(null); setMerging(true); } : undefined}
              />
            </Group>

            {detail.body.trim() ? (
              <Card style={{ gap: SPACE.md }}>
                {/* Rendered, and folded by BLOCKS rather than by characters.
                    A cut at 1,200 characters landed mid-word and mid-checkbox;
                    a cut after six blocks lands between two things somebody
                    wrote, and the expander below can say what the rest is. */}
                <Md text={detail.body.trim()} host={host} limit={bodyOpen ? undefined : BODY_BLOCKS} />
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
              </Card>
            ) : null}

            <View style={{ gap: SPACE.sm }}>
              <Label text={`Files · ${files.length}`} />
              <Card style={{ gap: SPACE.xs, padding: SPACE.md }}>
                {shownFiles.map((f) => (
                  <FileRow
                    key={f.path}
                    file={f}
                    // The segment, not a push. This is the back gesture the
                    // whole rearrangement exists to remove.
                    onOpen={() => { setFile(f.path); setPane("files"); }}
                  />
                ))}
                {files.length > shownFiles.length ? (
                  <Pressable onPress={() => setAllFiles(true)} style={{ minHeight: 44, justifyContent: "center" }}>
                    <Text style={{ color: C.primary, fontSize: T.small, fontWeight: "600" }}>
                      Show {files.length - shownFiles.length} more
                    </Text>
                  </Pressable>
                ) : null}
                {files.length === 0 ? <Note>No files reported.</Note> : null}
              </Card>
            </View>

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

            <Btn label="Open on GitHub" onPress={() => { void Linking.openURL(detail.url); }} />
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
          flexDirection: "row", gap: SPACE.sm,
          paddingHorizontal: SPACE.lg, paddingTop: SPACE.md, paddingBottom: SPACE.lg,
          borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.bg2,
        }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Ask Claude about #${number}`}
            onPress={() => setHanding(true)}
            style={({ pressed }) => ({
              flex: 1.3, minHeight: 48, borderRadius: RADIUS.pill, flexDirection: "row", gap: SPACE.sm,
              alignItems: "center", justifyContent: "center", backgroundColor: C.primary,
              transform: [{ scale: pressed ? 0.97 : 1 }],
            })}
          >
            <Glyph name="spark" color={ink(C.primary)} size={18} />
            <Text style={{ color: ink(C.primary), fontSize: T.body, fontWeight: "600" }}>Ask Claude</Text>
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
            style={{ flex: 1 }}
            disabled={detail.state !== "OPEN"}
            onPress={() => { setMergeErr(null); setMerging(true); }}
          />
        </View>
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

      <Sheet open={merging} onClose={() => setMerging(false)} title={`Merge #${number}`}>
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

            {/* Only what the repository permits. A repository that forbids
                squash used to be offered it anyway, which is a button that
                fails after you have chosen. */}
            {methods.map((m) => (
              <SheetRow
                key={m}
                label={MERGE_OPTION[m].label}
                sub={MERGE_OPTION[m].hint}
                on={m === method}
                onPress={() => setMethod(m)}
              />
            ))}

            <Toggle
              on={auto}
              label="Merge when it goes green"
              sub={
                detail.mergePolicy && !detail.mergePolicy.auto
                  ? "This repository does not allow auto-merge."
                  : "GitHub holds it and lands it once the checks pass."
              }
              disabled={!!detail.mergePolicy && !detail.mergePolicy.auto}
              onPress={() => setAuto((v) => !v)}
            />
            <Toggle
              on={deleteBranch}
              label="Delete the branch after"
              sub={
                detail.mergePolicy?.deletesBranch
                  ? "This repository already does it — leave it off."
                  : "The head branch goes with it."
              }
              onPress={() => setDeleteBranch((v) => !v)}
            />

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

            {mergeErr ? <Note tone="bad">{mergeErr}</Note> : null}

            <Btn
              label={auto ? "Arm it" : method ? MERGE_LABEL[method] : "Merge"}
              tone="good"
              busy={mergeBusy}
              // Blocked is not disabled. GitHub is the authority on whether it
              // will take it, `mergeState` can be stale by minutes, and a
              // BLOCKED that is really "a required reviewer approved thirty
              // seconds ago" would leave the only way through on the desktop.
              // It refuses on the server if it must, and the reason lands above.
              disabled={!method || detail.state !== "OPEN"}
              onPress={() => { void doMerge(); }}
            />
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
    </View>
  );
}
