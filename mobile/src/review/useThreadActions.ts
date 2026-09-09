/*
 * Answering a thread: the three writes, and the bookkeeping around them.
 *
 * This used to live inside the threads screen, which was fine while the
 * threads screen was the only place a conversation could be answered. It is
 * not any more — the diff draws them on the line they are about — and two
 * copies of "reply, resolve, apply" is how one of them quietly stops
 * re-reading after a write.
 *
 *   reply     `/prs/reply`            — into the thread, not as a new one
 *   resolve   `/prs/thread-resolved`  — and unresolve, the same button
 *   apply     `/prs/apply-suggestion` — commit the suggested lines
 *
 * The caller owns the fetch and passes `reload`, because the two screens read
 * different things: the threads screen wants the detail, and the diff wants
 * the detail AND keeps its own parsed text. Both must re-read after a write.
 */
import { useCallback, useState } from "react";
import * as Haptics from "expo-haptics";
import type { PrActionResult, PrThread } from "../../../shared/types.ts";
import { suggestionRange } from "../../../shared/suggestion.ts";
import { ask } from "../lib/api.ts";
import type { Host } from "../lib/host.ts";
import { replyAnchor } from "../model/threads.ts";

/** What a row is being told, and about which thread. `bad` is GitHub refusing
 *  rather than this app failing — both are shown, in different colours. */
export interface ThreadSaid { id: string; text: string; bad: boolean }

export interface ThreadActions {
  /** Off entirely on a phone paired to read: all three of these write. */
  mayWrite: boolean;
  /** The thread id something is in flight for, so one row can say it is busy
   *  without freezing the screen around it. */
  busy: string | null;
  said: ThreadSaid | null;
  writing: { id: string; body: string } | null;
  confirming: { thread: PrThread; text: string } | null;
  begin: (thread: PrThread) => void;
  type: (body: string) => void;
  cancel: () => void;
  reply: (thread: PrThread) => Promise<void>;
  setResolved: (thread: PrThread) => void;
  askApply: (thread: PrThread, text: string) => void;
  cancelApply: () => void;
  apply: () => Promise<void>;
}

export function useThreadActions({ host, root, number, reload }: {
  host: Host | null;
  root: string;
  number: string;
  reload: () => Promise<void>;
}): ThreadActions {
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<ThreadSaid | null>(null);
  const [writing, setWriting] = useState<{ id: string; body: string } | null>(null);
  /** A suggestion waiting to be confirmed. Applying one writes a commit to
   *  somebody else's branch, which is not something a single tap should do. */
  const [confirming, setConfirming] = useState<{ thread: PrThread; text: string } | null>(null);

  const mayWrite = host?.scope === "full";

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
    await reload();
    setBusy(null);
    setSaid({ id, bad: false, text: done });
    return true;
  }, [host, reload]);

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
    const ok = await act(
      thread.id, "/prs/reply",
      { root, number: Number(number), commentId: anchor, body: text },
      "Replied.",
    );
    if (ok) setWriting(null);
  }, [act, writing, root, number]);

  const setResolved = useCallback((thread: PrThread): void => {
    void act(
      thread.id, "/prs/thread-resolved",
      { root, threadId: thread.id, resolved: !thread.isResolved },
      thread.isResolved ? "Reopened." : "Resolved.",
    );
  }, [act, root]);

  const apply = useCallback(async (): Promise<void> => {
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

  return {
    mayWrite, busy, said, writing, confirming,
    begin: (thread) => { setSaid(null); setWriting({ id: thread.id, body: "" }); },
    type: (body) => { setWriting((was) => (was ? { id: was.id, body } : was)); },
    cancel: () => setWriting(null),
    reply,
    setResolved,
    askApply: (thread, text) => { setSaid(null); setConfirming({ thread, text }); },
    cancelApply: () => setConfirming(null),
    apply,
  };
}
