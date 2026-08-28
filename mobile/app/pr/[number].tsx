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
 * Not the diff, and not the conversation. Both are real screens and both are
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
import type { PrCheck, PrDetail, ReviewRecipe, ReviewRecipesResponse } from "../../../shared/types.ts";
import { ask } from "../../src/lib/api.ts";
import { useAgentglass } from "../../src/state/host-context.tsx";
import { usePaletteTick } from "../../src/state/use-palette.ts";
import { RECIPES_PATH, menuFor, situationOf } from "../../src/model/reviewMenu.ts";
import { requestHandoff } from "../../src/terminal/handoff.ts";
import { clearDraft, draft, forWire } from "../../src/model/reviewDraft.ts";
import { since } from "../../src/lib/dates.ts";
import { mergeVerdict } from "../../../shared/mergeReason.ts";
import {
  MERGE_LABEL, MERGE_OPTION, allowedMethods, mergeSubject, pickMergeMethod,
  type MergeMethod,
} from "../../../shared/mergeMethod.ts";
import { Btn, Card, Label, Note, Sheet, SheetRow, TAP, Toggle } from "../../src/ui.tsx";
import { ChevronIcon } from "../../src/nav/icons.tsx";
import { C, MONO, RADIUS, SPACE, T } from "../../src/theme.ts";

/** The rollup as one word and one colour. `pending` beats `failure` on purpose:
 *  a run still going has not failed yet, and calling it red is how a screen
 *  tells you to go and look at something that is about to go green. */
function checksLook(pr: PrDetail): { word: string; ink: string } {
  const { total, failure, pending, success } = pr.checks;
  if (!total) return { word: "no checks", ink: C.text4 };
  if (pending) return { word: `${pending} running`, ink: C.warning };
  if (failure) return { word: `${failure} failed`, ink: C.error };
  return { word: `${success} green`, ink: C.success };
}

/** What GitHub decided, in the words the list already uses — so a row and its
 *  detail cannot describe the same pull request differently. */
function decisionLook(pr: PrDetail): { word: string; ink: string } | null {
  if (pr.reviewDecision === "APPROVED") return { word: "approved", ink: C.success };
  if (pr.reviewDecision === "CHANGES_REQUESTED") return { word: "changes asked", ink: C.error };
  if (pr.reviewDecision === "REVIEW_REQUIRED") return { word: "needs review", ink: C.warning };
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

function CheckRow({ check, onOpen }: {
  check: PrCheck;
  /** Absent when there is nowhere to go. The row is a row either way — a
   *  control that is sometimes pressable and looks identical is worse than one
   *  that never is, so the chevron is what marks the difference. */
  onOpen?: () => void;
}): React.ReactNode {
  const bad = check.state === "failure";
  // `done` is the server's own word for "will not change without a push or a
  // re-run", and it is not the same question as the state: a check can read
  // `failure` and still be re-running.
  const running = !check.done;
  const ink = bad ? C.error : running ? C.warning : C.success;
  const Row = onOpen ? Pressable : View;
  return (
    <Row
      {...(onOpen ? { onPress: onOpen, accessibilityRole: "button" as const } : {})}
      style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm, minHeight: TAP }}
    >
      {/* A dot AND a word. Colour alone is not a signal to rely on at 11px
          outdoors — the same rule the repos screen states for its file marks. */}
      <View style={{
        width: 8, height: 8, borderRadius: 4,
        backgroundColor: running ? "transparent" : ink,
        borderWidth: running ? 1 : 0, borderColor: C.text4,
      }} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ color: C.text2, fontSize: T.small }}>{check.name}</Text>
        {/* The workflow, because two repositories' checks are called `test` and
            only the workflow says which one you are looking at. */}
        {check.workflow && check.workflow !== check.name ? (
          <Text numberOfLines={1} style={{ color: C.text4, fontSize: T.eyebrow }}>{check.workflow}</Text>
        ) : null}
      </View>
      <Text style={{ color: ink, fontSize: T.eyebrow }}>
        {running ? "running" : bad ? "failed" : check.state}
      </Text>
      {onOpen ? <ChevronIcon color={C.text4} size={16} /> : null}
    </Row>
  );
}

export default function PrScreen(): React.ReactNode {
  usePaletteTick(); // a scene repaints only if it asks — see use-palette.ts
  const { host } = useAgentglass();
  const router = useRouter();
  const { number, root, review } = useLocalSearchParams<{
    number: string; root: string; review?: string;
  }>();
  /* Submitting a review writes to GitHub. A phone paired to answer gates does
     not get to, and the control is not drawn rather than drawn and refused —
     the rule repos.tsx set. Reading the diff and handing it to Claude both
     stay available, because neither writes anything. */
  const mayWrite = host?.scope === "full";

  const [detail, setDetail] = useState<PrDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [handing, setHanding] = useState(false);
  const [allFiles, setAllFiles] = useState(false);
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

  const load = useCallback(async (): Promise<void> => {
    if (!host || !number || !root) return;
    const query = `root=${encodeURIComponent(root)}&number=${encodeURIComponent(number)}`;
    const answer = await ask<{ ok: boolean; detail?: PrDetail; error?: string }>(
      host, `/prs/detail?${query}`,
    );
    if (!answer.ok) { setError(answer.error); return; }
    if (!answer.value.ok || !answer.value.detail) {
      setError(answer.value.error || "That pull request could not be read.");
      return;
    }
    setError(null);
    setDetail(answer.value.detail);
  }, [host, number, root]);

  useEffect(() => { void load(); }, [load]);

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
    if (!detail || !root) return;
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
  }, [detail, root, router]);

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
                {detail.isDraft ? (
                  <View style={{
                    paddingHorizontal: SPACE.sm, paddingVertical: 2,
                    borderRadius: RADIUS.sm, borderWidth: 1, borderColor: C.text4,
                  }}>
                    <Text style={{ color: C.text4, fontSize: T.eyebrow }}>draft</Text>
                  </View>
                ) : null}
                {decision ? (
                  <View style={{
                    paddingHorizontal: SPACE.sm, paddingVertical: 2,
                    borderRadius: RADIUS.sm, borderWidth: 1, borderColor: decision.ink,
                  }}>
                    <Text style={{ color: decision.ink, fontSize: T.eyebrow }}>{decision.word}</Text>
                  </View>
                ) : null}
                {checks ? (
                  <View style={{
                    paddingHorizontal: SPACE.sm, paddingVertical: 2,
                    borderRadius: RADIUS.sm, borderWidth: 1, borderColor: checks.ink,
                  }}>
                    <Text style={{ color: checks.ink, fontSize: T.eyebrow }}>{checks.word}</Text>
                  </View>
                ) : null}
                <Text style={{ color: C.text4, fontSize: T.eyebrow }}>
                  {detail.author} · {since(detail.updatedAt, now)}
                </Text>
              </View>
              {/* A conflict is a different need from a red check, and the list
                  already carries `mergeable` for exactly that reason. UNKNOWN
                  is GitHub still computing it and must not be drawn as "fine". */}
              {detail.mergeable === "CONFLICTING" ? (
                <Note tone="bad">This branch conflicts with {detail.baseRefName}.</Note>
              ) : null}
              {detail.forcePushedSinceReview ? (
                <Note>The author force-pushed after a review — anything already said may be stale.</Note>
              ) : null}
            </View>

            {detail.body.trim() ? (
              <Card>
                {/* Verbatim. Markdown is not rendered: a description is prose
                    somebody wrote, and half-rendered markup reads worse than
                    none. Capped, because a template can be four thousand
                    characters of checklist. */}
                <Text style={{ color: C.text2, fontSize: T.body, lineHeight: 21 }}>
                  {detail.body.trim().slice(0, 1200)}
                  {detail.body.trim().length > 1200 ? "…" : ""}
                </Text>
              </Card>
            ) : null}

            {failing.length ? (
              <View style={{ gap: SPACE.sm }}>
                <Label text={`Failing · ${failing.length}`} />
                <Card style={{ gap: SPACE.xs, padding: SPACE.md }}>
                  {/* Every one of them opens the same screen. The job list
                      there is the whole run, not this check alone: a failing
                      `test` is routinely a `build` that fell over first, and
                      arriving filtered to the row you tapped hides the job
                      that actually broke. */}
                  {failing.map((c) => (
                    <CheckRow
                      key={c.name}
                      check={c}
                      onOpen={() => router.push({
                        pathname: "/pr/checks",
                        params: { number: String(number), root: root ?? "" },
                      })}
                    />
                  ))}
                </Card>
              </View>
            ) : null}

            <View style={{ gap: SPACE.sm }}>
              <Label text={`Files · ${files.length}`} />
              <Card style={{ gap: SPACE.xs, padding: SPACE.md }}>
                {shownFiles.map((f) => (
                  <FileRow
                    key={f.path}
                    file={f}
                    onOpen={() => router.push({
                      pathname: "/pr/diff",
                      params: { number: String(number), root: root ?? "", path: f.path },
                    })}
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
                    onPress={() => router.push({
                      pathname: "/pr/threads",
                      params: { number: String(number), root: root ?? "" },
                    })}
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

            {/* Not in the pinned bar. The bar holds the three things you open a
                pull request on a phone to DO — hand it over, review it, merge
                it — and a fourth button there would be a fourth button in the
                way of those. This is the thing you do on your own pull
                request, where the other three are off. */}
            {mayWrite ? (
              <Btn
                label="Comment on it"
                onPress={() => { setCommentErr(null); setCommenting(true); }}
              />
            ) : null}

            <Btn label="Open on GitHub" onPress={() => { void Linking.openURL(detail.url); }} />
          </>
        ) : null}
      </ScrollView>

      {/* The bar, pinned. It is the reason to be on this screen, so it does not
          scroll away under a long description. */}
      {detail ? (
        <View style={{
          flexDirection: "row", gap: SPACE.sm,
          paddingHorizontal: SPACE.lg, paddingTop: SPACE.md, paddingBottom: SPACE.lg,
          borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.bg2,
        }}>
          <Btn
            label="✦ Claude"
            tone="primary"
            style={{ flex: 1.2 }}
            onPress={() => setHanding(true)}
          />
          <Btn
            label={notes.length ? `Review · ${notes.length}` : "Review"}
            style={{ flex: 1 }}
            // Not on your own pull request: GitHub will not let you review your
            // own work, and neither should this.
            disabled={!mayWrite || detail.viewerDidAuthor}
            onPress={() => setReviewing(true)}
          />
          {/*
            Merge is here rather than at the top because the Inbox has a group
            called "Ready to merge" and tapping a row in it arrived at a screen
            that could not.

            Drawn only with `full`, like every other write — the scope rule is
            "not drawn rather than drawn and refused". But it IS drawn when
            merging is blocked, greyed, because the reason is the useful part
            and a control that vanishes teaches nothing. That is the same
            argument PrMergeState carries in shared/types.ts: "a disabled
            control that can't say why is the thing this panel exists to
            replace" — so the sheet says why.
          */}
          {mayWrite ? (
            <Btn
              label="Merge"
              tone={gate && !gate.blocked ? "good" : "plain"}
              style={{ flex: 1 }}
              disabled={detail.state !== "OPEN"}
              onPress={() => { setMergeErr(null); setMerging(true); }}
            />
          ) : null}
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
              Could not ask GitHub whether a review is already started here. If one is, whichever
              verdict you press below submits it too.
            </Note>
          </View>
        ) : pending.length ? (
          <View style={{ gap: SPACE.xs, paddingBottom: SPACE.md }}>
            <Label text={`${pending.length} already on GitHub`} />
            {pending.map((c, i) => (
              <View key={`${c.path}:${c.line}:${i}`} style={{ paddingVertical: SPACE.xs }}>
                <Text numberOfLines={2} style={{ color: C.text2, fontSize: T.small }}>{c.body}</Text>
                <Text numberOfLines={1} style={{ color: C.text4, fontSize: T.eyebrow, fontFamily: MONO }}>
                  {c.path}{c.line === null ? "" : `:${c.line}`}
                </Text>
              </View>
            ))}
            <Note>
              Started somewhere else and never sent. Whichever verdict you press below submits
              these too.
            </Note>
          </View>
        ) : null}

        {notes.length ? (
          <View style={{ gap: SPACE.xs, paddingBottom: SPACE.md }}>
            <Label text={`${notes.length} ${notes.length === 1 ? "comment" : "comments"} queued`} />
            {notes.map((n) => (
              <View key={`${n.path}:${n.line}`} style={{ paddingVertical: SPACE.xs }}>
                <Text numberOfLines={1} style={{ color: C.text2, fontSize: T.small }}>{n.body}</Text>
                <Text numberOfLines={1} style={{ color: C.text4, fontSize: T.eyebrow, fontFamily: MONO }}>
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
          placeholderTextColor={C.text4}
          multiline
          style={{
            minHeight: 72, borderWidth: 1, borderColor: C.border, borderRadius: RADIUS.md,
            backgroundColor: C.bg, color: C.text, padding: SPACE.md, fontSize: T.body,
          }}
        />

        <View style={{ gap: SPACE.sm, paddingTop: SPACE.md }}>
          <Btn label="Approve" tone="good" busy={verdict === "approve"}
            disabled={!!verdict} onPress={() => { void send("approve"); }} />
          <View style={{ flexDirection: "row", gap: SPACE.sm }}>
            <Btn label="Request changes" tone="danger" style={{ flex: 1 }}
              busy={verdict === "request_changes"} disabled={!!verdict}
              onPress={() => { void send("request_changes"); }} />
            <Btn label="Comment" style={{ flex: 1 }}
              busy={verdict === "comment"} disabled={!!verdict}
              onPress={() => { void send("comment"); }} />
          </View>
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

      <Sheet open={handing} onClose={() => setHanding(false)} title={`Hand #${number} to Claude`}>
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
                color: C.text4, fontSize: T.eyebrow, fontFamily: MONO,
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
