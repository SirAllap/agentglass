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
import {
  ChevronIcon, InboxIcon, IssuesIcon, PrsIcon, ReposIcon, TasksIcon, TerminalIcon,
} from "../../src/nav/icons.tsx";
import { BAR, taskDestinations, terminalDestinations } from "../../src/nav/bar.ts";
import { useTracksWork } from "../../src/state/use-tracks-work.ts";
import { Card, Label, Note, TAP, groupEdge } from "../../src/ui.tsx";
import { C, MONO, RADIUS, SPACE, T } from "../../src/theme.ts";

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

/**
 * The destinations, from the one list that names them.
 *
 * `BAR` was the tab bar's contents and is still the statement of what this app
 * is for — pull requests, issues, cards, and the terminal they are all handed
 * to. The bar itself is retired (see src/nav/TabBar.tsx); the list outlived it,
 * which is the point of it having been data rather than a component.
 *
 * The Inbox is dropped because it is the page this draws on. `repos` is added
 * because source control is a destination somebody goes to from here and was
 * only ever off the bar for want of a sixth slot.
 */
const DESTINATIONS = [
  ...BAR.filter((d) => d.route !== "index"),
  { route: "repos" as const, label: "Source control" },
];

/* Cards is dropped on a machine that tracks work nowhere — see
   `taskDestinations` in src/nav/bar.ts for what "nowhere" means and why
   unknown is not it. Nothing takes its place: this is a list, not the
   five-slot bar it came from. */

const ICONS = {
  prs: PrsIcon,
  terminal: TerminalIcon,
  issues: IssuesIcon,
  tasks: TasksIcon,
  repos: ReposIcon,
};

/** A number beside a destination, where the Inbox already knows one. Only
 *  where it is the SAME question the destination answers — "how many pull
 *  requests need you" is, "how many exist" is not, and this screen only has
 *  the first. */
const COUNTS: Record<string, ((c: { needs: number; failing: number; ready: number }) => number) | undefined> = {
  prs: (c) => c.needs + c.ready,
};

type ListRow = { heading: InboxGroup } | { item: InboxItem };

export default function InboxScreen(): React.ReactNode {
  usePaletteTick(); // a scene repaints only if it asks — see use-palette.ts
  const { fleet, live, refresh, host } = useAgentglass();
  const router = useRouter();
  const inbox = useInbox();
  const [pulling, setPulling] = useState(false);
  /* Asked once per machine and held for a minute — the hook's own file says
     why it is not a fetch inside this component. Null while it is unknown,
     which draws every destination. The terminal is the other cut, and that
     one waits for nothing: the scope is the pairing this phone holds. */
  const destinations = terminalDestinations(taskDestinations(DESTINATIONS, useTracksWork(host)), host?.scope);

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
  /* What the heading counts. `needs` plus `ready` — the two groups whose rows
     have something for a person to DO. `moved` is deliberately out: it is what
     changed since you looked, which is worth a section and is not a job. */
  const waiting = inbox.counts.needs + inbox.counts.ready;

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
  /*
   * Where each card starts and stops.
   *
   * A section is ONE card with its rows divided, not a stack of cards with
   * gaps between them. Both draw the same rows; the difference is what the eye
   * counts. Separate cards make eight pull requests eight objects, each with
   * its own border and its own shadow of space, and the heading above them is
   * a label for a pile. One card makes them eight lines of one thing, which is
   * what they are — and the gap then means what it should, which is "a new
   * group starts here" rather than "here is another item".
   *
   * Computed here rather than asked per row inside the renderer, because
   * `renderItem` gets an index and nothing else, and a row cannot see its
   * neighbours from there.
   */
  const isItem = (r: ListRow | undefined): boolean => !!r && !("heading" in r);
  const edges = rows.map((row, i) => ({
    first: isItem(row) && !isItem(rows[i - 1]),
    last: isItem(row) && !isItem(rows[i + 1]),
  }));

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
    router.push({ pathname: "/card/[id]", params: { id: item.open.id } });
  }, [inbox, router]);

  return (
    <FlatList
      data={rows}
      keyExtractor={(row) => ("heading" in row ? `h:${row.heading}` : row.item.id)}
      /* No gap. Rows inside a section are divided by their own hairline, and a
         gap as well would draw the separation twice — see `edges`. The space
         between sections is paid by the heading's own padding. */
      contentContainerStyle={{ padding: SPACE.lg, paddingBottom: SPACE.xl }}
      refreshControl={<RefreshControl refreshing={pulling} onRefresh={onRefresh} tintColor={C.text3} />}
      ListHeaderComponent={
        <View style={{ gap: SPACE.lg, paddingBottom: SPACE.md }}>
          {/*
            A title in the CONTENT, not only in the navigation bar.

            The bar's own title is 17pt and shares its row with a gear; it says
            which tab you are on and nothing else. A page has room to open with
            a sentence, and the sentence people arrive for is not "Inbox" — it
            is how much is waiting. So the heading answers that, and the count
            under it is the same one the tiles add up to, said in words for the
            two seconds before anybody parses three numbers.
          */}
          <View style={{ gap: 2 }}>
            <Text style={{ color: C.text, fontSize: 30, fontWeight: "700", lineHeight: 36 }}>
              {waiting === 0 ? "All clear" : waiting === 1 ? "One thing" : `${waiting} things`}
            </Text>
            <Text style={{ color: C.text3, fontSize: T.small }}>
              {waiting === 0
                ? "Nothing is waiting on you."
                : `${waiting === 1 ? "is" : "are"} waiting on you.`}
            </Text>
          </View>

          <View style={{ flexDirection: "row", gap: SPACE.sm }}>
            <Tile n={inbox.counts.needs} label="need you" ink={C.error} loud />
            <Tile n={inbox.counts.failing} label="CI failing" ink={C.warning} />
            <Tile n={inbox.counts.ready} label="ready to merge" ink={C.success} loud />
          </View>

          {/*
            The machine, as a row you can press rather than a line of text.

            Every number above is a claim about another computer, and one that
            has been offline for ten minutes must not present the same screen
            as one that is connected — which is why this is under the tiles and
            not over them. It is a row now because it had somewhere to go all
            along: the address, the grant and the way to forget it are all in
            Settings, and a status line that reports a problem while offering
            no way to it is a dead end drawn in the calmest type on the screen.
          */}
          <View style={{ gap: SPACE.sm }}>
            <Label text="Machine" />
            <Pressable
              onPress={() => router.push("/settings")}
              accessibilityRole="button"
              accessibilityLabel="This computer, and what this phone may do to it"
              style={({ pressed }) => [
                groupEdge(true, true),
                {
                  flexDirection: "row", alignItems: "center", gap: SPACE.md,
                  paddingHorizontal: SPACE.lg, paddingVertical: SPACE.md,
                  opacity: pressed ? 0.6 : 1,
                },
              ]}
            >
              <View style={{
                width: 8, height: 8, borderRadius: 4,
                backgroundColor: live === "open" ? C.success : live === "connecting" ? C.warning : C.text4,
              }} />
              <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
                <Text numberOfLines={1} style={{ color: C.text, fontSize: T.body, fontWeight: "600" }}>
                  {host?.label ?? "No computer"}
                </Text>
                <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.small }}>
                  {fleet.error
                    ? fleet.error
                    : live === "open"
                      ? "Connected"
                      : live === "connecting" ? "Reconnecting…" : "Offline"}
                </Text>
              </View>
              <ChevronIcon color={C.text4} size={17} />
            </Pressable>
          </View>

          {/*
            Where else there is, now that nothing draws a bar.

            Read from BAR in src/nav/bar.ts rather than listed again here — it
            is still the list of what this app is FOR, and two places naming
            four destinations is how one of them ends up missing the fifth. The
            Inbox itself is dropped: it is the page you are on.

            Counts where there is one worth giving. A destination with a number
            beside it is a reason to press it; a bare word is a menu.
          */}
          <View style={{ gap: SPACE.sm }}>
            <Label text="Go to" />
            {destinations.map((dest, i) => {
              const Icon = ICONS[dest.route as keyof typeof ICONS];
              const count = COUNTS[dest.route]?.(inbox.counts);
              return (
                <Pressable
                  key={dest.route}
                  onPress={() => router.push(`/${dest.route === "index" ? "" : dest.route}`)}
                  accessibilityRole="button"
                  accessibilityLabel={dest.label ?? dest.route}
                  style={({ pressed }) => [
                    groupEdge(i === 0, i === destinations.length - 1),
                    {
                      flexDirection: "row", alignItems: "center", gap: SPACE.md,
                      paddingHorizontal: SPACE.lg, minHeight: TAP,
                      opacity: pressed ? 0.6 : 1,
                    },
                  ]}
                >
                  {Icon ? <Icon color={C.text3} size={19} /> : null}
                  <Text style={{ color: C.text, fontSize: T.body, flex: 1 }}>
                    {dest.label ?? "Terminal"}
                  </Text>
                  {count ? (
                    <Text style={{ color: C.text3, fontSize: T.small, fontFamily: MONO }}>{count}</Text>
                  ) : null}
                  <ChevronIcon color={C.text4} size={17} />
                </Pressable>
              );
            })}
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
              {/* The list of what was checked has to match what was actually
                  checked. On a machine with no tracker there are no cards to
                  have looked at, and naming them here is the same false
                  reassurance the Cards screen used to give — it says something
                  was searched that never existed. */}
              No pull request{destinations.some((d) => d.route === "tasks") ? ", issue or card" : " or issue"} is
              waiting on you. Anything an agent is doing is in the terminal.
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
          /* The gap between groups is paid here, and it is bigger than it was.
             With the rows now joined into one card, the only thing separating
             two groups IS this space — before, every row had its own margin
             and a heading only had to sit in the middle of it. */
          <View style={{ paddingTop: index === 0 ? 0 : SPACE.xl, paddingBottom: SPACE.sm }}>
            <Label text={HEADING[row.heading]} />
          </View>
        ) : (
          <View style={groupEdge(edges[index]!.first, edges[index]!.last)}>
            <Row item={row.item} now={now} onOpen={() => open(row.item)} />
          </View>
        )}
    />
  );
}
