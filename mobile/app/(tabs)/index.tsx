/*
 * The Inbox: what is waiting on you, from the three places work arrives from.
 *
 * Pull requests, issues and cards. NOTHING about agents — not a held gate, not
 * a stopped session, not the plan meter. The rule and the argument for it are
 * in src/model/inbox.ts; what this file adds is that the rule is visible in
 * the imports, which carry no session or gate type at all.
 *
 * ── what was here, and why it went ────────────────────────────────────────
 * A list of running agents under a band that counted `waitingItems`. That
 * rule calls a session "waiting on you" when it has been quiet between four
 * minutes and twelve hours, so on a real machine it read "4 things want you"
 * over four rows last touched 21 minutes, 6 hours, 10 hours and 10 hours ago.
 * It titled them with `sessionTitle`, whose fallback for a hook-only session
 * is `source_app:id.slice(0,8)` — so the four rows said `orbit:3f9c1a04`.
 *
 * Everything an agent is doing is now read where it is running, in the
 * terminal behind the star. A gate that is held raises a band there, not here.
 *
 * ── three numbers, then one list ──────────────────────────────────────────
 * The tiles are a summary and the list is the detail, in that order, because
 * this screen is scanned rather than read. They are counted from the rows
 * underneath them — `inboxCounts` takes the built list — so a tile cannot
 * disagree with what it is sitting on top of, which is the failure the old
 * band shipped with.
 */
import { useCallback, useState } from "react";
import { FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useAgentglass } from "../../src/state/host-context.tsx";
import { useInbox } from "../../src/state/use-inbox.ts";
import { usePaletteTick } from "../../src/state/use-palette.ts";
import type { InboxGroup, InboxItem } from "../../src/model/inbox.ts";
import { ChevronIcon, InboxIcon, IssuesIcon, PrsIcon, TasksIcon } from "../../src/nav/icons.tsx";
import { Card, Label, Note, TAP } from "../../src/ui.tsx";
import { C, RADIUS, SPACE, T } from "../../src/theme.ts";

/** "4m", "2h", "3d" — the age of a thing, in the least space that is honest. */
function age(at: number, now: number): string {
  if (!at) return "";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

const HEADING: Record<InboxGroup, string> = {
  needs: "Needs you",
  ready: "Ready to merge",
  moved: "Moved since you looked",
};

/** The mark for where a row came from. A mixed list of `#483` and
 *  `SHOP-2140` is not tellable apart at a glance, and this is what makes it
 *  scannable without reading. */
function SourceMark({ item }: { item: InboxItem }): React.ReactNode {
  const ink = item.tone === "bad" ? C.error
    : item.tone === "warn" ? C.warning
    : item.tone === "good" ? C.success
    : C.text4;
  if (item.source === "pr") return <PrsIcon color={ink} size={17} />;
  if (item.source === "issue") return <IssuesIcon color={ink} size={17} />;
  return <TasksIcon color={ink} size={17} />;
}

function Row({ item, now, onOpen }: {
  item: InboxItem;
  now: number;
  onOpen: () => void;
}): React.ReactNode {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${item.title}. ${item.sub}`}
      onPress={onOpen}
      style={({ pressed }) => ({
        minHeight: 58,
        flexDirection: "row",
        alignItems: "center",
        gap: SPACE.md,
        paddingHorizontal: SPACE.md,
        paddingVertical: SPACE.sm,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <View style={{ width: 20, alignItems: "center" }}><SourceMark item={item} /></View>
      <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ color: C.text, fontSize: T.body, fontWeight: "600" }}>
          {item.title}
        </Text>
        <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.small }}>{item.sub}</Text>
      </View>
      <Text style={{ color: C.text4, fontSize: T.eyebrow }}>{age(item.at, now)}</Text>
      <ChevronIcon color={C.text4} size={17} />
    </Pressable>
  );
}

/** One number and what it counts. Tappable is deliberately NOT offered: these
 *  are a summary of the list below, and a tile that filtered it would make the
 *  same screen answer two questions. */
function Tile({ n, label, ink, loud }: {
  n: number;
  label: string;
  ink: string;
  loud?: boolean;
}): React.ReactNode {
  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={`${n} ${label}`}
      style={{
        flex: 1, minHeight: 62, justifyContent: "center", gap: 1,
        paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm,
        borderRadius: RADIUS.md, borderWidth: 1,
        borderColor: loud && n > 0 ? ink : C.border,
        backgroundColor: C.bg2,
      }}
    >
      <Text style={{
        color: n > 0 ? ink : C.text4, fontSize: 22, fontWeight: "700", lineHeight: 26,
      }}>{n}</Text>
      <Text style={{ color: C.text3, fontSize: T.eyebrow, fontWeight: "600" }}>{label}</Text>
    </View>
  );
}

type ListRow = { heading: InboxGroup } | { item: InboxItem };

export default function InboxScreen(): React.ReactNode {
  usePaletteTick(); // a scene repaints only if it asks — see use-palette.ts
  const { fleet, live, refresh, host } = useAgentglass();
  const router = useRouter();
  const inbox = useInbox();
  const [pulling, setPulling] = useState(false);

  const reload = inbox.reload;
  const onRefresh = useCallback((): void => {
    setPulling(true);
    refresh();
    reload();
    // The store's refresh is fire-and-forget, so the spinner is on a timer
    // rather than on the request — the same trade the old screen made, for the
    // same reason: plumbing a promise through for a gesture nobody measures.
    setTimeout(() => setPulling(false), 600);
  }, [refresh, reload]);

  const now = fleet.at || Date.now();

  /** Rows with their headings folded in, so one FlatList draws the lot. A
   *  SectionList would be the obvious alternative and buys nothing here: there
   *  are three sections, they never stick, and this keeps the empty state one
   *  branch instead of two. */
  const rows: ListRow[] = [];
  let group: InboxGroup | null = null;
  for (const item of inbox.items) {
    if (item.group !== group) { group = item.group; rows.push({ heading: group }); }
    rows.push({ item });
  }

  const open = useCallback((item: InboxItem): void => {
    inbox.markSeen(item);
    if (item.open.screen === "pr") {
      router.push({ pathname: "/pr/[number]", params: { number: item.open.id, root: item.open.root ?? "" } });
      return;
    }
    if (item.open.screen === "issue") {
      router.push({ pathname: "/issue/[number]", params: { number: item.open.id, root: item.open.root ?? "" } });
      return;
    }
    // Cards have no detail screen yet. Marking it seen is still right — you
    // looked at it here — and the Cards tab is where it is read for now.
    router.push("/tasks");
  }, [inbox, router]);

  return (
    <FlatList
      data={rows}
      keyExtractor={(row) => ("heading" in row ? `h:${row.heading}` : row.item.id)}
      contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.xs, paddingBottom: SPACE.xl }}
      refreshControl={<RefreshControl refreshing={pulling} onRefresh={onRefresh} tintColor={C.text3} />}
      ListHeaderComponent={
        <View style={{ gap: SPACE.md, paddingBottom: SPACE.md }}>
          <View style={{ flexDirection: "row", gap: SPACE.sm }}>
            <Tile n={inbox.counts.needs} label="need you" ink={C.error} loud />
            <Tile n={inbox.counts.failing} label="CI failing" ink={C.warning} />
            <Tile n={inbox.counts.ready} label="ready to merge" ink={C.success} loud />
          </View>
          {/* Under the tiles on purpose. Every number above is a claim about
              another computer, and one that has been offline for ten minutes
              must not present the same screen as one that is connected. */}
          <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm, paddingHorizontal: SPACE.xs }}>
            <View style={{
              width: 7, height: 7, borderRadius: 4,
              backgroundColor: live === "open" ? C.success : live === "connecting" ? C.warning : C.text4,
            }} />
            <Text style={{ color: C.text3, fontSize: T.small, flexShrink: 1 }} numberOfLines={1}>
              {fleet.error
                ? fleet.error
                : live === "open"
                  ? host?.label ?? "Connected"
                  : live === "connecting" ? "Reconnecting…" : "Offline"}
            </Text>
          </View>
        </View>
      }
      ListEmptyComponent={
        /* Three states, and they are three different sentences. "Not asked
           yet" must never be drawn as "nothing needs you" — that is good news
           reported before anybody looked, which is the exact failure the old
           band shipped with. */
        !inbox.loaded || fleet.at === 0 ? null : (
          <Card>
            <Label text="Clear" />
            <Note>
              No pull request, issue or card is waiting on you. Anything an agent is doing is in
              the terminal.
            </Note>
          </Card>
        )
      }
      ListFooterComponent={
        inbox.skipped > 0 ? (
          <View style={{ paddingTop: SPACE.md }}>
            <Note>
              {inbox.skipped} more {inbox.skipped === 1 ? "repository is" : "repositories are"} on this
              machine and were not asked. Six is the cap — the same one the rest of the app uses.
            </Note>
          </View>
        ) : null
      }
      renderItem={({ item: row, index }) =>
        "heading" in row ? (
          <View style={{ paddingTop: index === 0 ? 0 : SPACE.md, paddingBottom: SPACE.xs }}>
            <Label text={HEADING[row.heading]} />
          </View>
        ) : (
          <View style={{
            backgroundColor: C.bg2, borderWidth: 1, borderColor: C.border, borderRadius: RADIUS.lg,
          }}>
            <Row item={row.item} now={now} onOpen={() => open(row.item)} />
          </View>
        )}
    />
  );
}
