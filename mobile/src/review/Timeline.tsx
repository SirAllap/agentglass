/*
 * What was said on a pull request, by people and by automation, in the order it
 * was said.
 *
 * Threads was the only place a remark could be read, and it holds line
 * comments alone: a pull request with five comments on it said "Nobody has
 * commented on a line" and nothing else. The order and the Humans/Bots split
 * are decided in shared/prConversation.ts, the same code the desktop panel
 * counts with; this file draws it.
 *
 * Automation is folded to one line by default. On a live pull request the
 * machines outnumber the people and a coverage table is not something to
 * scroll past with a thumb — one tap opens it.
 */
import { useMemo, useState } from "react";
import type { Host } from "../lib/host.ts";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import type { PrReview } from "../../../shared/types.ts";
import { conversation, countLanes, inLane, type ConvEntry, type Lane } from "../../../shared/prConversation.ts";
import { Md } from "../md/Md.tsx";
import { useAgentglass } from "../state/host-context.tsx";
import { usePaletteTick } from "../state/use-palette.ts";
import { usePrDetail } from "../state/pr-detail.ts";
import { whereOf } from "../model/threads.ts";
import { since } from "../lib/dates.ts";
import { Card, Chip, Label, Note, Segmented, TAP } from "../ui.tsx";
import { C, SPACE, T } from "../theme.ts";

const VERDICT: Record<PrReview["state"], { word: string; tone: "good" | "bad" | "neutral" }> = {
  APPROVED: { word: "approved", tone: "good" },
  CHANGES_REQUESTED: { word: "changes requested", tone: "bad" },
  COMMENTED: { word: "reviewed", tone: "neutral" },
  DISMISSED: { word: "dismissed", tone: "neutral" },
  PENDING: { word: "pending", tone: "neutral" },
};

const EMPTY: Record<Lane, string> = {
  all: "Nobody has said anything on this pull request yet.",
  humans: "No person has said anything on this pull request.",
  bots: "No automation has said anything on this pull request.",
};

function Head({ author, isBot, when, now, chip }: {
  author: string; isBot: boolean; when: number; now: number; chip?: React.ReactNode;
}): React.ReactNode {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
      <Text numberOfLines={1} style={{ color: C.text, fontSize: T.small, fontWeight: "600", flexShrink: 1 }}>
        {author}{isBot ? " · bot" : ""}
      </Text>
      {chip}
      <Text style={{ color: C.text3, fontSize: T.eyebrow }}>{when ? since(when, now) : ""}</Text>
    </View>
  );
}

const bodyOf = (e: ConvEntry): string =>
  e.kind === "comment" ? e.comment.body : e.kind === "review" ? e.review.body : e.thread.comments[0]?.body ?? "";

function Entry({ e, host, now, onOpenThreads }: {
  e: ConvEntry; host: Host | null; now: number; onOpenThreads: () => void;
}): React.ReactNode {
  const [open, setOpen] = useState(false);
  const author = e.kind === "comment" ? e.comment.author : e.kind === "review" ? e.review.author : e.thread.comments[0]?.author ?? "";
  const body = bodyOf(e);
  const chip = e.kind === "review"
    ? <Chip label={VERDICT[e.review.state].word} tone={VERDICT[e.review.state].tone} />
    : undefined;

  if (e.kind === "thread") {
    const replies = e.thread.comments.length - 1;
    return (
      <Pressable accessibilityRole="button" onPress={onOpenThreads} style={{ minHeight: TAP }}>
        <Card style={{ gap: SPACE.xs, opacity: e.thread.isResolved ? 0.6 : 1 }}>
          <Text numberOfLines={1} ellipsizeMode="head" style={{ color: C.text2, fontSize: T.small }}>
            {whereOf(e.thread)}{e.thread.isResolved ? " · resolved" : ""}
          </Text>
          <Head author={author} isBot={e.isBot} when={e.at} now={now} />
          <Text numberOfLines={2} style={{ color: C.text, fontSize: T.body }}>{body}</Text>
          <Text style={{ color: C.text3, fontSize: T.eyebrow }}>
            {replies > 0 ? `${replies} ${replies === 1 ? "reply" : "replies"} · ` : ""}open in Threads
          </Text>
        </Card>
      </Pressable>
    );
  }

  if (e.isBot && !open) {
    const first = (e.kind === "comment" && e.comment.digest) || body.trim().split("\n")[0] || "(no text)";
    return (
      <Pressable accessibilityRole="button" onPress={() => setOpen(true)} style={{ minHeight: TAP, justifyContent: "center" }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
          <Text style={{ color: C.text3, fontSize: T.small, fontWeight: "600" }}>{author} · bot</Text>
          <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.small, flex: 1 }}>{first}</Text>
          <Text style={{ color: C.text4, fontSize: T.eyebrow }}>{since(e.at, now)}</Text>
        </View>
      </Pressable>
    );
  }

  return (
    <Card style={{ gap: SPACE.sm }}>
      <Head author={author} isBot={e.isBot} when={e.at} now={now} chip={chip} />
      {body.trim() ? <Md text={body} host={host} /> : null}
      {e.isBot ? (
        <Pressable accessibilityRole="button" onPress={() => setOpen(false)} style={{ minHeight: TAP, justifyContent: "center" }}>
          <Text style={{ color: C.text3, fontSize: T.small }}>Fold</Text>
        </Pressable>
      ) : null}
    </Card>
  );
}

export function Timeline({ number, root, onOpenThreads }: {
  number: string; root: string; onOpenThreads: () => void;
}): React.ReactNode {
  usePaletteTick(); // a scene repaints only if it asks — see use-palette.ts
  const { host } = useAgentglass();
  const { detail, error } = usePrDetail(host, root, number);
  const [lane, setLane] = useState<Lane>("all");

  const entries = useMemo(() => (detail ? conversation(detail) : []), [detail]);
  const counts = countLanes(entries);
  const shown = inLane(entries, lane);
  const now = Date.now();

  return (
    <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md, paddingBottom: SPACE.xl }}>
      {error ? (
        <Card>
          <Label text="Cannot read it" />
          <Note tone="bad">{error}</Note>
        </Card>
      ) : null}

      {!detail && !error ? <ActivityIndicator color={C.text3} /> : null}

      {detail ? (
        <Segmented
          options={[
            { id: "all", label: "All", count: counts.all },
            { id: "humans", label: "Humans", count: counts.humans },
            { id: "bots", label: "Bots", count: counts.bots },
          ]}
          value={lane}
          onChange={setLane}
        />
      ) : null}

      {detail && shown.length === 0 ? <Card><Note>{EMPTY[lane]}</Note></Card> : null}

      {shown.map((e) => (
        <Entry key={e.key} e={e} host={host} now={now} onOpenThreads={onOpenThreads} />
      ))}
    </ScrollView>
  );
}
