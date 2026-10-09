/*
 * What was said on a pull request, and what happened to it, in the order it
 * happened.
 *
 * Threads was the only place a remark could be read, and it holds line
 * comments alone: a pull request with five comments on it said "Nobody has
 * commented on a line" and nothing else. The order, the grouping and the words
 * of an event are the desk's (shared/prTimeline.ts, shared/prEventLine.ts), the
 * Humans/Bots counts are shared/prConversation.ts, the same code the desk panel
 * counts with; model/talk.ts turns them into rows and this file draws them on a
 * rail of faces (Bubble.tsx).
 *
 * Automation is folded to one line by default. On a live pull request the
 * machines outnumber the people and a coverage table is not something to
 * scroll past with a thumb — one tap opens it. Reacting and replying are
 * writes and are not here: reactions are shown, not pressed.
 */
import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { countLanes, conversation, type Lane } from "../../../shared/prConversation.ts";
import { Avatar, AVATAR } from "../Avatar.tsx";
import { Md } from "../md/Md.tsx";
import { repoOf } from "../model/prRef.ts";
import { plainInline } from "../md/parse.ts";
import { useAgentglass } from "../state/host-context.tsx";
import { usePaletteTick } from "../state/use-palette.ts";
import { usePrDetail } from "../state/pr-detail.ts";
import { whereOf } from "../model/threads.ts";
import { newness } from "../model/readMarks.ts";
import { dividerAt, isFresh, rowsIn, talkRows, type Bubble as BubbleData, type TalkRow } from "../model/talk.ts";
import { since } from "../lib/dates.ts";
import type { Host } from "../lib/host.ts";
import { Card, Chip, Label, Note, Segmented, TAP } from "../ui.tsx";
import { Bubble, EventLine, MARK_SIZE, Rail, RailMark } from "./Bubble.tsx";
import { C, MONO, SPACE, T } from "../theme.ts";

const EMPTY: Record<Lane, string> = {
  all: "Nobody has said anything on this pull request yet.",
  humans: "No person has said anything on this pull request.",
  bots: "No automation has said anything on this pull request.",
};

/** How many commits a push lists before it says how many more. */
const COMMITS_SHOWN = 3;

/** The line between what was read and what was not. Words, not only a colour:
 *  the same line says how many, so it is also the summary of the whole pane. */
function NewDivider({ count }: { count: number }): React.ReactNode {
  return (
    <View
      accessibilityRole="header"
      accessibilityLabel={`${count} new since you last looked`}
      style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm, paddingBottom: SPACE.md }}
    >
      <View style={{ flex: 1, height: 1, backgroundColor: C.primary }} />
      <Text style={{ color: C.primary, fontSize: T.small, fontWeight: "600" }}>{count} new</Text>
      <View style={{ flex: 1, height: 1, backgroundColor: C.primary }} />
    </View>
  );
}

function Said({ b, host, repo, now, fresh, verdict }: {
  b: BubbleData; host: Host | null; repo?: string; now: number; fresh: boolean; verdict: "approved" | "changes" | null;
}): React.ReactNode {
  const chips = (
    <>
      {fresh ? <Chip label="new" tone="accent" /> : null}
      {verdict ? <Chip label={verdict === "approved" ? "approved" : "changes requested"} tone={verdict === "approved" ? "good" : "bad"} /> : null}
    </>
  );
  return (
    <Bubble
      author={b.author} badge={b.isBot ? "BOT" : b.badge} chips={chips} when={b.at ? since(b.at, now) : ""}
      edited={b.edited} reactions={b.reactions}
    >
      {b.body.trim() ? <Md text={b.body} host={host} repo={repo} /> : null}
    </Bubble>
  );
}

function Row({ row, first, last, host, repo, now, fresh, onOpenThreads }: {
  row: TalkRow; first: boolean; last: boolean; host: Host | null; repo?: string; now: number; fresh: boolean; onOpenThreads: () => void;
}): React.ReactNode {
  const [open, setOpen] = useState(false);

  if (row.kind === "event") {
    return (
      <Rail lead={<RailMark glyph={row.glyph} tone={row.tone} />} size={MARK_SIZE} first={first} last={last}>
        <EventLine parts={row.parts} when={row.at ? since(row.at, now) : ""} />
      </Rail>
    );
  }

  if (row.kind === "commits") {
    const shown = row.commits.slice(0, COMMITS_SHOWN);
    const rest = row.commits.length - shown.length;
    const n = row.commits.length;
    return (
      <Rail lead={<RailMark glyph="commit" tone="neutral" />} size={MARK_SIZE} first={first} last={last}>
        <EventLine
          parts={[{ text: row.actor || "somebody", as: "who" }, { text: ` added ${n} ${n === 1 ? "commit" : "commits"}` }]}
          when={row.at ? since(row.at, now) : ""}
          below={(
            <View style={{ backgroundColor: C.bg3, borderRadius: 6, padding: SPACE.sm, gap: 2 }}>
              {shown.map((c, i) => (
                <View key={`${c.short}${i}`} style={{ flexDirection: "row", gap: SPACE.sm }}>
                  <Text style={{ color: C.text3, fontSize: T.eyebrow, fontFamily: MONO }}>{c.short}</Text>
                  <Text numberOfLines={1} style={{ color: C.text2, fontSize: T.eyebrow, fontFamily: MONO, flex: 1 }}>{c.message}</Text>
                </View>
              ))}
              {rest > 0 ? <Text style={{ color: C.text3, fontSize: T.eyebrow }}>{rest} more</Text> : null}
            </View>
          )}
        />
      </Rail>
    );
  }

  if (row.kind === "thread") {
    const t = row.thread;
    const c = t.comments[0];
    const replies = t.comments.length - 1;
    return (
      <Rail lead={<Avatar name={c?.author ?? ""} login={c?.author} bot={c?.isBot} size={AVATAR.rail} />} size={AVATAR.rail} first={first} last={last}>
        <Pressable accessibilityRole="button" onPress={onOpenThreads} style={{ minHeight: TAP }}>
          <Bubble
            author={c?.author ?? ""} badge={c?.isBot ? "BOT" : null} when={c?.createdAt ? since(c.createdAt, now) : ""} dim={t.isResolved}
            chips={(
              <>
                {fresh ? <Chip label="new reply" tone="accent" /> : null}
                {t.isResolved ? <Chip label="Resolved" tone="good" /> : null}
              </>
            )}
          >
            <Text numberOfLines={1} ellipsizeMode="head" style={{ color: C.text3, fontSize: T.small, fontFamily: MONO }}>{whereOf(t)}</Text>
            <Text numberOfLines={2} style={{ color: C.text, fontSize: T.body }}>{c?.body ?? ""}</Text>
            <Text style={{ color: C.text3, fontSize: T.eyebrow }}>
              {replies > 0 ? `${replies} ${replies === 1 ? "reply" : "replies"} · ` : ""}open in Threads
            </Text>
          </Bubble>
        </Pressable>
      </Rail>
    );
  }

  const b = row.bubble;
  if (b.isBot && !open) {
    const raw = b.digest || b.body.trim().split("\n")[0] || "(no text)";
    // Neither source is guaranteed plain: the digest can carry the source
    // comment's own markdown through untouched (`digestBotComment`'s
    // fallback is a raw line), and the body's first line always is. There is
    // no `Md` here to render `**87.4%**` as bold — only the row to draw it
    // literally — so the syntax comes off instead.
    const first_ = plainInline(raw);
    return (
      <Rail lead={<Avatar name={b.author} login={b.author} bot size={MARK_SIZE} />} size={MARK_SIZE} first={first} last={last}>
        <Pressable accessibilityRole="button" onPress={() => setOpen(true)} style={{ minHeight: MARK_SIZE, justifyContent: "center" }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
            <Text style={{ color: C.text3, fontSize: T.small, fontWeight: "600" }}>{b.author} · bot</Text>
            <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.small, flex: 1 }}>{first_}</Text>
            <Text style={{ color: C.text4, fontSize: T.eyebrow }}>{b.at ? since(b.at, now) : ""}</Text>
          </View>
        </Pressable>
      </Rail>
    );
  }
  return (
    <Rail lead={<Avatar name={b.author} login={b.author} bot={b.isBot} size={AVATAR.rail} />} size={AVATAR.rail} first={first} last={last}>
      <Said b={b} host={host} repo={repo} now={now} fresh={fresh} verdict={row.verdict} />
      {b.isBot ? (
        <Pressable accessibilityRole="button" onPress={() => setOpen(false)} style={{ minHeight: TAP, justifyContent: "center" }}>
          <Text style={{ color: C.text3, fontSize: T.small }}>Fold</Text>
        </Pressable>
      ) : null}
    </Rail>
  );
}

export function Timeline({ number, root, since: lastLooked, onOpenThreads }: {
  number: string; root: string;
  /** When this person last looked, before this visit; 0 says nothing is new. */
  since: number;
  onOpenThreads: () => void;
}): React.ReactNode {
  usePaletteTick(); // a scene repaints only if it asks — see use-palette.ts
  const { host } = useAgentglass();
  const { detail, error } = usePrDetail(host, root, number);
  const [lane, setLane] = useState<Lane>("all");

  /* The counts over the Humans/Bots split are the desk's (remarks only); the
     rows under it also carry the events, which are not counted. */
  const entries = useMemo(() => (detail ? conversation(detail) : []), [detail]);
  const rows = useMemo(() => (detail ? talkRows(detail) : []), [detail]);
  const counts = useMemo(() => countLanes(entries), [entries]);
  const shown = useMemo(() => rowsIn(rows, lane), [rows, lane]);
  const now = Date.now();
  const fresh = useMemo(() => (detail ? newness(entries, detail, lastLooked) : null), [entries, detail, lastLooked]);
  const divider = fresh && fresh.count > 0 ? dividerAt(shown, fresh.dividerBefore) : -1;
  const repo = repoOf(detail?.url ?? "") ?? undefined;

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

      {detail && counts[lane] === 0 ? <Card><Note>{EMPTY[lane]}</Note></Card> : null}

      {shown.length ? (
        <View style={{ paddingTop: SPACE.sm }}>
          {shown.map((row, i) => (
            <View key={row.key}>
              {i === divider && fresh ? <NewDivider count={fresh.count} /> : null}
              <Row
                row={row} first={i === 0} last={i === shown.length - 1} host={host} repo={repo} now={now}
                fresh={isFresh(row, fresh?.keys)} onOpenThreads={onOpenThreads}
              />
            </View>
          ))}
        </View>
      ) : null}
    </ScrollView>
  );
}
