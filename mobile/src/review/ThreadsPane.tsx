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
 * ── this is the list; the diff has the same thing on the line ────────────
 * A conversation is answered here or under the row of code it is about, and
 * both draw `review/ThreadCard.tsx` and act through `useThreadActions` — the
 * three writes and the re-read after them live there. What is left in this
 * file is the list: which threads, in what order, and what to say when there
 * are none.
 *
 * ── replies post immediately, and the diff's comments do not ─────────────
 * This looks like an inconsistency and is the opposite of one. A line comment
 * is part of a REVIEW — a verdict plus its remarks, which GitHub takes in one
 * call, and which reviewDraft.ts queues precisely so that a dropped connection
 * cannot leave three observations with no conclusion. A reply is not part of
 * anything: it is one message into a conversation that already exists, it
 * stands on its own, and holding it back until some later verdict would be
 * holding an answer somebody is waiting for.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, ScrollView } from "react-native";
import type { PrDetail } from "../../../shared/types.ts";
import { ask } from "../lib/api.ts";
import { useAgentglass } from "../state/host-context.tsx";
import { usePaletteTick } from "../state/use-palette.ts";
import { ordered } from "../model/threads.ts";
import { ApplyConfirm } from "./ApplyConfirm.tsx";
import { ThreadCard } from "./ThreadCard.tsx";
import { useThreadActions } from "./useThreadActions.ts";
import { Card, Label, Note } from "../ui.tsx";
import { C, SPACE } from "../theme.ts";

/**
 * The conversations on a pull request, as a pane.
 *
 * A component and not a screen, for the reason `FilesPane` gives: it is the
 * Threads segment of the review AND the route a notification points at, and
 * those two must be one implementation.
 */
export function ThreadsPane({ number, root }: { number: string; root: string }): React.ReactNode {
  usePaletteTick(); // a scene repaints only if it asks — see use-palette.ts
  const { host } = useAgentglass();

  const [detail, setDetail] = useState<PrDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const actions = useThreadActions({ host, root: root ?? "", number: number ?? "", reload: load });

  const threads = useMemo(() => ordered(detail?.threads ?? []), [detail]);
  const open = threads.filter((t) => !t.isResolved).length;
  const now = Date.now();

  return (
    /* `padding`, both platforms, never Platform-conditional — the measurement
       is in test/keyboard-inset.test.ts. This screen takes typing. */
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: C.bg }} behavior="padding">

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

        {threads.map((thread) => (
          <ThreadCard key={thread.id} thread={thread} host={host} actions={actions} now={now} />
        ))}

        {!actions.mayWrite && threads.length ? (
          <Note>
            This phone is paired to read. Replying, resolving and applying a suggestion all write
            to GitHub, so they are off until it is paired again with write access.
          </Note>
        ) : null}
      </ScrollView>

      {actions.confirming ? (
        <ApplyConfirm
          thread={actions.confirming.thread}
          text={actions.confirming.text}
          branch={detail?.headRefName}
          onCancel={actions.cancelApply}
          onApply={() => { void actions.apply(); }}
        />
      ) : null}
    </KeyboardAvoidingView>
  );
}
