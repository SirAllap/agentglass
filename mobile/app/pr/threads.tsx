/*
 * The conversations on a pull request, answered from the phone.
 *
 * ── what this replaces ───────────────────────────────────────────────────
 * A line on the detail screen that said "Reading them is on GitHub for now".
 * That sentence was the honest description of a review you could start on the
 * phone and could not finish: you could write remarks on the diff and send a
 * verdict, but the moment somebody replied to one, the app had nothing to say
 * and handed you to a browser, signed out, on a page built for a mouse.
 *
 * Three things happen here, and each is one call the server already served for
 * the desk:
 *
 *   reply           `/prs/reply`            — into the thread, not as a new one
 *   resolve         `/prs/thread-resolved`  — and unresolve, the same button
 *   apply           `/prs/apply-suggestion` — commit the suggested lines
 *
 * ── replies post immediately, and the diff's comments do not ─────────────
 * This looks like an inconsistency and is the opposite of one. A line comment
 * is part of a REVIEW — a verdict plus its remarks, which GitHub takes in one
 * call, and which reviewDraft.ts queues precisely so that a dropped connection
 * cannot leave three observations with no conclusion. A reply is not part of
 * anything: it is one message into a conversation that already exists, it
 * stands on its own, and holding it back until some later verdict would be
 * holding an answer somebody is waiting for.
 *
 * ── applying a suggestion writes a commit to somebody's branch ───────────
 * So it asks first, and it says whose branch and which lines. The parsing —
 * which block, which range — is `shared/suggestion.ts`, and the range comes
 * from the THREAD rather than from anything in the block, because that is how
 * GitHub defines it. An outdated thread offers no Apply at all: the lines it
 * was written about are gone, and the number it still carries now points at
 * something nobody was talking about.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Linking, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import * as Haptics from "expo-haptics";
import type { PrActionResult, PrDetail, PrThread } from "../../../shared/types.ts";
import { suggestionRange, suggestionsIn } from "../../../shared/suggestion.ts";
import { ask } from "../../src/lib/api.ts";
import { useAgentglass } from "../../src/state/host-context.tsx";
import { usePaletteTick } from "../../src/state/use-palette.ts";
import { since } from "../../src/lib/dates.ts";
import { hunkTail, ordered, replyAnchor, whereOf } from "../../src/model/threads.ts";
import { Btn, Card, Label, Note, TAP } from "../../src/ui.tsx";
import { C, MONO, RADIUS, SCRIM, SPACE, T, tint } from "../../src/theme.ts";

/** The diff hunk GitHub kept with the comment, trimmed to what fits.
 *  Kept because a reply written without seeing the code it is about is a reply
 *  about the wrong thing — and on an outdated thread this is the ONLY copy of
 *  those lines left anywhere in the app. */
function Hunk({ text }: { text: string }): React.ReactNode {
  const { lines: shown, clipped } = hunkTail(text);
  return (
    <View style={{ backgroundColor: C.bg, borderRadius: RADIUS.sm, paddingVertical: SPACE.xs }}>
      {clipped ? (
        <Text style={{ color: C.text4, fontSize: 10, fontFamily: MONO, paddingHorizontal: SPACE.sm }}>⋯</Text>
      ) : null}
      {shown.map((line, i) => {
        const add = line.startsWith("+");
        const del = line.startsWith("-");
        return (
          <Text
            key={i}
            numberOfLines={1}
            style={{
              color: add ? C.success : del ? C.error : C.text3,
              backgroundColor: add ? tint(C.success, 0.12) : del ? tint(C.error, 0.12) : "transparent",
              fontSize: 10, fontFamily: MONO, lineHeight: 16, paddingHorizontal: SPACE.sm,
            }}
          >{line}</Text>
        );
      })}
    </View>
  );
}

export default function ThreadsScreen(): React.ReactNode {
  usePaletteTick(); // a scene repaints only if it asks — see use-palette.ts
  const { host } = useAgentglass();
  const { number, root } = useLocalSearchParams<{ number: string; root: string }>();

  const [detail, setDetail] = useState<PrDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Which thread has its reply box open, and what is in it. */
  const [writing, setWriting] = useState<{ id: string; body: string } | null>(null);
  /** The thread id something is in flight for, so one row can say it is busy
   *  without freezing the whole screen. */
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<{ id: string; text: string; bad: boolean } | null>(null);
  /** A suggestion waiting to be confirmed. Applying one writes a commit to
   *  somebody else's branch, which is not something a single tap should do. */
  const [confirming, setConfirming] = useState<{ thread: PrThread; text: string } | null>(null);

  const mayWrite = host?.scope === "full";

  const load = useCallback(async (): Promise<void> => {
    if (!host || !number || !root) return;
    const query = `root=${encodeURIComponent(root)}&number=${encodeURIComponent(number)}`;
    const answer = await ask<{ ok: boolean; detail?: PrDetail; error?: string }>(host, `/prs/detail?${query}`);
    if (!answer.ok) { setError(answer.error); return; }
    if (!answer.value.ok || !answer.value.detail) {
      setError(answer.value.error || "That pull request could not be read.");
      return;
    }
    setError(null);
    setDetail(answer.value.detail);
  }, [host, number, root]);

  useEffect(() => { void load(); }, [load]);

  /*
   * One write, and then a re-read.
   *
   * Never an optimistic update. What a thread looks like after a reply is
   * GitHub's answer and not this app's guess — a resolve can be refused by a
   * branch rule, and a reply can land while somebody else resolves the thread
   * underneath it. Re-reading costs one request on an action that already cost
   * one, and it is the difference between a screen that reports and a screen
   * that hopes.
   */
  const act = useCallback(async (
    id: string, path: string, body: unknown, done: string,
  ): Promise<boolean> => {
    if (!host) return false;
    setBusy(id);
    setSaid(null);
    const answer = await ask<PrActionResult>(host, path, { method: "POST", body });
    if (!answer.ok || !answer.value.ok) {
      setBusy(null);
      setSaid({ id, bad: true, text: (answer.ok ? answer.value.error : answer.error) || "GitHub refused that." });
      return false;
    }
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await load();
    setBusy(null);
    setSaid({ id, bad: false, text: done });
    return true;
  }, [host, load]);

  const reply = useCallback(async (thread: PrThread): Promise<void> => {
    const text = writing?.body.trim();
    if (!text || writing?.id !== thread.id) return;
    /*
     * The REST reply endpoint takes the numeric id of a comment in the thread,
     * and `PrThreadComment.id` is a GraphQL node id — the two are not
     * interchangeable, which the shared type says out loud. Without a
     * databaseId there is nothing to reply to, so the box is not offered.
     */
    const anchor = replyAnchor(thread);
    if (anchor === null) {
      setSaid({ id: thread.id, bad: true, text: "That thread carries no id to reply to." });
      return;
    }
    const ok = await act(thread.id, "/prs/reply", { root, number: Number(number), commentId: anchor, body: text }, "Replied.");
    if (ok) setWriting(null);
  }, [act, writing, root, number]);

  const setResolved = useCallback((thread: PrThread): void => {
    void act(
      thread.id, "/prs/thread-resolved",
      { root, threadId: thread.id, resolved: !thread.isResolved },
      thread.isResolved ? "Reopened." : "Resolved.",
    );
  }, [act, root]);

  const applySuggestion = useCallback(async (): Promise<void> => {
    if (!confirming) return;
    const { thread, text } = confirming;
    const range = suggestionRange(thread);
    if (!range) return;
    setConfirming(null);
    await act(thread.id, "/prs/apply-suggestion", {
      root, number: Number(number),
      path: thread.path, startLine: range.startLine, line: range.line,
      suggestion: text,
      // Credited as a co-author on the commit, exactly as GitHub does it. The
      // author of the SUGGESTION, which is the first comment in the thread and
      // not whoever replied last.
      author: thread.comments[0]?.author,
    }, "Applied.");
  }, [act, confirming, root, number]);

  const threads = useMemo(() => ordered(detail?.threads ?? []), [detail]);
  const open = threads.filter((t) => !t.isResolved).length;
  const now = Date.now();

  return (
    /* `padding`, both platforms, never Platform-conditional — the measurement
       is in test/keyboard-inset.test.ts. This screen takes typing. */
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: C.bg }} behavior="padding">
      <Stack.Screen options={{ title: `#${number} · threads` }} />

      <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.lg, paddingBottom: SPACE.xl }}>
        {error ? (
          <Card>
            <Label text="Cannot read them" />
            <Note tone="bad">{error}</Note>
          </Card>
        ) : null}

        {!detail && !error ? <ActivityIndicator color={C.text3} /> : null}

        {detail && threads.length === 0 ? (
          <Card><Note>Nobody has commented on a line of this pull request.</Note></Card>
        ) : null}

        {threads.length ? (
          <Label text={open ? `${open} open · ${threads.length} in all` : `${threads.length} resolved`} />
        ) : null}

        {threads.map((thread) => {
          const range = suggestionRange(thread);
          /* The FIRST suggestion in the thread, which is the one the range
             belongs to. A later reply containing its own block is a different
             proposal about the same lines, and applying it under the first
             one's range would be applying something nobody chose. */
          const suggestion = thread.comments
            .flatMap((c) => suggestionsIn(c.body))
            .at(0);
          const canApply = mayWrite && !!suggestion && !!range && !thread.isResolved;
          const canReply = mayWrite && replyAnchor(thread) !== null;
          const note = said?.id === thread.id ? said : null;
          const working = busy === thread.id;

          return (
            <Card key={thread.id} style={{ gap: SPACE.sm, opacity: thread.isResolved ? 0.6 : 1 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
                <Text
                  numberOfLines={1}
                  ellipsizeMode="head"
                  style={{ color: C.text2, fontSize: T.small, fontFamily: MONO, flex: 1 }}
                >{whereOf(thread)}</Text>
                {thread.isResolved ? (
                  <Text style={{ color: C.success, fontSize: T.eyebrow }}>resolved</Text>
                ) : thread.isOutdated ? (
                  <Text style={{ color: C.text4, fontSize: T.eyebrow }}>outdated</Text>
                ) : null}
              </View>

              {thread.diffHunk ? <Hunk text={thread.diffHunk} /> : null}

              {thread.comments.map((comment) => (
                <View key={comment.id} style={{ gap: 2, paddingTop: SPACE.xs }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
                    <Text style={{ color: C.text, fontSize: T.small, fontWeight: "600" }}>
                      {comment.author}{comment.isBot ? " · bot" : ""}
                    </Text>
                    <Text style={{ color: C.text4, fontSize: T.eyebrow }}>
                      {since(comment.createdAt, now)}
                    </Text>
                  </View>
                  <Text style={{ color: C.text2, fontSize: T.body, lineHeight: 20 }}>{comment.body}</Text>
                </View>
              ))}

              {writing?.id === thread.id ? (
                <View style={{ gap: SPACE.sm, paddingTop: SPACE.xs }}>
                  <TextInput
                    value={writing.body}
                    onChangeText={(body) => setWriting({ id: thread.id, body })}
                    placeholder="Reply"
                    placeholderTextColor={C.text4}
                    multiline
                    autoFocus
                    style={{
                      minHeight: 64, borderWidth: 1, borderColor: C.border, borderRadius: RADIUS.sm,
                      backgroundColor: C.bg, color: C.text, padding: SPACE.sm, fontSize: T.body,
                    }}
                  />
                  <View style={{ flexDirection: "row", gap: SPACE.sm }}>
                    <Btn
                      label="Send reply"
                      tone="primary"
                      style={{ flex: 1 }}
                      busy={working}
                      disabled={!writing.body.trim() || working}
                      onPress={() => { void reply(thread); }}
                    />
                    <Btn label="Cancel" onPress={() => setWriting(null)} />
                  </View>
                  {/* Said where the difference bites: this one goes now, and
                      the remarks written on the diff do not. */}
                  <Note>A reply is posted on its own, straight away.</Note>
                </View>
              ) : (
                <View style={{ flexDirection: "row", gap: SPACE.sm, paddingTop: SPACE.xs }}>
                  <Btn
                    label="Reply"
                    style={{ flex: 1 }}
                    disabled={!canReply || working}
                    onPress={() => { setSaid(null); setWriting({ id: thread.id, body: "" }); }}
                  />
                  <Btn
                    label={thread.isResolved ? "Reopen" : "Resolve"}
                    tone={thread.isResolved ? "plain" : "good"}
                    style={{ flex: 1 }}
                    busy={working}
                    disabled={!mayWrite || working}
                    onPress={() => setResolved(thread)}
                  />
                </View>
              )}

              {canApply ? (
                <Btn
                  label={`Apply suggestion · ${thread.path.split("/").pop()}:${
                    range!.startLine === range!.line ? range!.line : `${range!.startLine}-${range!.line}`
                  }`}
                  disabled={working}
                  onPress={() => { setSaid(null); setConfirming({ thread, text: suggestion!.text }); }}
                />
              ) : null}

              {suggestion && !range ? (
                <Note>
                  This thread carries a suggestion, and the lines it was written about are gone.
                  Applying it would change code nobody was talking about.
                </Note>
              ) : null}

              {note ? <Note tone={note.bad ? "bad" : "quiet"}>{note.text}</Note> : null}

              {thread.url ? (
                <Pressable
                  onPress={() => { void Linking.openURL(thread.url!); }}
                  accessibilityRole="button"
                  style={{ minHeight: TAP, justifyContent: "center" }}
                >
                  <Text style={{ color: C.primary, fontSize: T.small }}>Open the thread on GitHub</Text>
                </Pressable>
              ) : null}
            </Card>
          );
        })}

        {!mayWrite && threads.length ? (
          <Note>
            This phone is paired to read. Replying, resolving and applying a suggestion all write
            to GitHub, so they are off until it is paired again with write access.
          </Note>
        ) : null}
      </ScrollView>

      {/* The confirmation, as a card over the list rather than a sheet: what it
          is confirming is TEXT, and a sheet that has to scroll to show what you
          are agreeing to is a sheet nobody reads to the bottom. */}
      {confirming ? (
        <View style={{
          position: "absolute", left: 0, right: 0, bottom: 0, top: 0,
          backgroundColor: SCRIM, justifyContent: "flex-end",
        }}>
          <View style={{
            backgroundColor: C.bg2, borderTopLeftRadius: RADIUS.lg, borderTopRightRadius: RADIUS.lg,
            padding: SPACE.lg, gap: SPACE.md, maxHeight: "80%",
          }}>
            <Label text="Commit this to the branch?" />
            <Text style={{ color: C.text2, fontSize: T.small }}>
              {whereOf(confirming.thread)} on {detail?.headRefName ?? "the head branch"}
            </Text>
            <ScrollView style={{ maxHeight: 220 }}>
              <Text style={{
                color: C.text, fontFamily: MONO, fontSize: 11, lineHeight: 17,
                backgroundColor: C.bg, padding: SPACE.sm, borderRadius: RADIUS.sm,
              }}>{confirming.text === "" ? "(removes those lines)" : confirming.text}</Text>
            </ScrollView>
            <Note>
              It is committed through GitHub, credited to {confirming.thread.comments[0]?.author ?? "whoever wrote it"},
              and refused if anybody has pushed since this was read.
            </Note>
            <View style={{ flexDirection: "row", gap: SPACE.sm }}>
              <Btn label="Cancel" style={{ flex: 1 }} onPress={() => setConfirming(null)} />
              <Btn label="Apply" tone="primary" style={{ flex: 1 }} onPress={() => { void applySuggestion(); }} />
            </View>
          </View>
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}
