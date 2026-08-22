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
import { Btn, Card, Label, Note, Sheet, SheetRow, TAP } from "../../src/ui.tsx";
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

function CheckRow({ check }: { check: PrCheck }): React.ReactNode {
  const bad = check.state === "failure";
  // `done` is the server's own word for "will not change without a push or a
  // re-run", and it is not the same question as the state: a check can read
  // `failure` and still be re-running.
  const running = !check.done;
  const ink = bad ? C.error : running ? C.warning : C.success;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm, minHeight: TAP }}>
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
    </View>
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
  /* Opened straight away when the diff sent you here with comments queued —
     `review=1` on the route. Otherwise it is the second button below. */
  const [reviewing, setReviewing] = useState(review === "1");
  const [verdict, setVerdict] = useState<"approve" | "request_changes" | "comment" | null>(null);
  const [summary, setSummary] = useState("");
  const [sent, setSent] = useState<string | null>(null);

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
    router.push("/terminal");
  }, [detail, root, router]);

  const key = `${root}#${number}`;
  const notes = draft(key);

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
    void load();
  }, [host, detail, root, summary, notes, key, load]);

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
                  {failing.map((c) => <CheckRow key={c.name} check={c} />)}
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

            {openThreads ? (
              <View style={{ gap: SPACE.sm }}>
                <Label text={`Open threads · ${openThreads}`} />
                <Card>
                  <Note>
                    {openThreads === 1 ? "One conversation is" : `${openThreads} conversations are`}
                    {" "}still unresolved. Reading them is on GitHub for now.
                  </Note>
                </Card>
              </View>
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
        </View>
      ) : null}

      <Sheet open={reviewing} onClose={() => setReviewing(false)} title="Send your review">
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
            <Note>No line comments. Open the files above to write one.</Note>
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
            onPress={() => hand(recipe.id)}
          />
        ))}
        <View style={{ paddingTop: SPACE.md, gap: SPACE.xs }}>
          <Note>
            Opens a tmux window on the computer with the agent already running, and takes you to it.
          </Note>
          {/* Said out loud because it is the one thing that is not visible from
              here: the words that reach the agent are the computer's, chosen by
              the name above. This phone sends a number and an id. */}
          <Note>
            The phone sends the number and which question to ask. The prompt itself is written on
            the computer.
          </Note>
        </View>
      </Sheet>
    </View>
  );
}
