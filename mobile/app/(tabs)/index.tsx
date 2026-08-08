/*
 * Home: what the computer is doing, and one line for whatever is blocking.
 *
 * The screen the app opens on, and it replaced Now there. Now's own copy says
 * it "is meant to be empty most of the time", which is true and is the whole
 * argument: a queue you can empty is the right shape for a queue and the wrong
 * shape for a landing screen — open the app on a good day and it told you
 * nothing at all. This one has something to say whether or not anything is
 * wrong, because a machine with four agents on it is never nothing.
 *
 * Three things, in this order:
 *
 *   the band — the top of Now, in one line, and the way in to the rest of it.
 *   It is here on every render, not only when something is held: Now is a tab
 *   with no tab now, and a door that appears only in a crisis is a door nobody
 *   knows about.
 *
 *   the connection — because every number under it is a claim about another
 *   machine, and a phone that has been offline for ten minutes must not draw
 *   the same screen as one that is connected.
 *
 *   the agents — what is running and what each one is doing. `runningAgents`
 *   decides that, with the boundaries the queue already uses; this file only
 *   draws it.
 *
 * What is deliberately NOT here is a second copy of the queue. The band counts
 * `waitingItems`, which is Now's own rule imported, and it links rather than
 * summarises — one place where a card can be answered, and it is the one with
 * the buttons on it.
 */
import { useCallback, useState } from "react";
import { FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { sessionTitle } from "../../../shared/sessionTitle.ts";
import { baseName } from "../../../shared/projectKey.ts";
import { newsItems, waitingItems } from "../../src/model/nowQueue.ts";
import { runningAgents, type Doing, type RunningAgent } from "../../src/model/machine.ts";
import { ChevronIcon, NowIcon } from "../../src/nav/icons.tsx";
import { useAgentglass } from "../../src/state/host-context.tsx";
import { usePaletteTick } from "../../src/state/use-palette.ts";
import { useQueue } from "../../src/state/use-queue.ts";
import { Card, Label, Note } from "../../src/ui.tsx";
import { C, MONO, RADIUS, SPACE, T } from "../../src/theme.ts";

/** "4m", "2h", "3d" — the age of a thing, in the least space that is honest.
 *  The same shape Now draws its cards with. */
function age(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** What each state is called and what colour it is.
 *
 *  `blocked` is the only one that gets the error colour, and that is the same
 *  rule the queue's tones follow: a person is stopping an agent from working,
 *  and nothing else in this app is allowed to be that loud. */
function doingLooks(doing: Doing): { word: string; ink: string } {
  switch (doing) {
    case "blocked": return { word: "waiting on you", ink: C.error };
    case "stopped": return { word: "stopped", ink: C.warning };
    case "working": return { word: "working", ink: C.success };
    case "thinking": return { word: "thinking", ink: C.text4 };
  }
}

/**
 * The band: the top of Now, in one line.
 *
 * Two states and both of them say something. With nothing held it is not
 * silent — it says so, and it still counts what the queue knows but is not
 * waiting on anybody, because "two things worth knowing" is a reason to tap and
 * "nothing is waiting on you" alone is a reason to assume the screen is broken.
 */
function Band({ waiting, news, top, onOpen }: {
  waiting: number;
  news: number;
  /** The first thing in the queue, so the band names it rather than counting
   *  it. One title tells you whether to tap; a number never does. */
  top: string | null;
  onOpen: () => void;
}): React.ReactNode {
  const held = waiting > 0;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={held ? `${waiting} things want you. Opens Now.` : "Nothing is waiting on you. Opens Now."}
      onPress={onOpen}
    >
      <Card style={{
        gap: SPACE.xs,
        borderLeftWidth: 3,
        borderLeftColor: held ? C.error : C.border2,
        flexDirection: "row",
        alignItems: "center",
      }}>
        <NowIcon color={held ? C.error : C.text4} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: C.text, fontSize: T.title, fontWeight: "600" }}>
            {held
              ? `${waiting} ${waiting === 1 ? "thing wants" : "things want"} you`
              : "Nothing is waiting on you"}
          </Text>
          <Text style={{ color: C.text3, fontSize: T.small }} numberOfLines={1}>
            {top ?? (news > 0
              ? `${news} worth knowing`
              : "No gate is held and nothing has stopped.")}
          </Text>
        </View>
        <ChevronIcon color={C.text4} />
      </Card>
    </Pressable>
  );
}

function AgentRow({ agent, now, onOpen }: {
  agent: RunningAgent;
  now: number;
  onOpen: () => void;
}): React.ReactNode {
  const looks = doingLooks(agent.doing);
  const where = agent.session.cwd_path ?? agent.session.project_path ?? "";
  /*
   * On a blocked row the clock is the GATE's, not the session's silence.
   *
   * The two start together and are not the same measurement: silence is how
   * long since the agent last wrote anything, and a session that emits after
   * its gate opens — or one whose gate was raised a second time — resets it
   * while the request goes on being unanswered. The number that decides whether
   * to answer now is how long the request has been open, and only the gate
   * knows that.
   */
  const clock = agent.gate ? now - agent.gate.created : agent.quiet;
  return (
    <Pressable onPress={onOpen} accessibilityRole="button">
      <Card style={{ gap: SPACE.sm, padding: SPACE.md }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
          {/* A dot in the state's colour, and the word beside it. Colour alone
              is not a signal to rely on at 11px outdoors, and for a good number
              of people it is not a signal at all — the same reason the repos
              screen puts a letter next to every file's colour. */}
          <View style={{
            width: 8, height: 8, borderRadius: 4,
            backgroundColor: agent.doing === "thinking" ? "transparent" : looks.ink,
            borderWidth: agent.doing === "thinking" ? 1 : 0, borderColor: C.text4,
          }} />
          <Text style={{ color: looks.ink, fontSize: T.eyebrow, fontWeight: "700", letterSpacing: 0.6 }}>
            {looks.word.toUpperCase()}
          </Text>
          <View style={{ flex: 1 }} />
          {/* Not on a working row. Every other state is somebody waiting and
              the clock is what says how badly; "working · 3s" is the age of the
              last keystroke, which is noise. */}
          {agent.doing === "working" ? null : (
            <Text style={{ color: C.text4, fontSize: T.eyebrow }}>{age(clock)}</Text>
          )}
        </View>

        {/* The AGENT, always — never the gate's summary, even when there is one.
            The band above is already naming that, word for word, because it is
            the top of the queue; a row that repeated it would leave nothing on
            the screen saying which conversation is stuck. */}
        <Text style={{ color: C.text, fontSize: T.body, lineHeight: 19 }} numberOfLines={2}>
          {sessionTitle(agent.session)}
        </Text>

        {agent.gate ? (
          <View style={{ backgroundColor: C.bg, borderRadius: RADIUS.sm, padding: SPACE.sm }}>
            {/* Verbatim, and never wrapped into something that reads like a
                different command: this is what the agent is asking to run. The
                same rule Now's cards follow. */}
            <Text style={{ color: C.text2, fontFamily: MONO, fontSize: T.small }} numberOfLines={2}>
              {agent.gate.summary || agent.gate.tool_name}
            </Text>
          </View>
        ) : null}

        <Text style={{ color: C.text4, fontSize: T.eyebrow, fontFamily: MONO }} numberOfLines={1}>
          {where ? baseName(where) : agent.session.source_app}
        </Text>
      </Card>
    </Pressable>
  );
}

export default function HomeScreen(): React.ReactNode {
  usePaletteTick(); // a scene repaints only if it asks — see use-palette.ts
  const { fleet, live, refresh, host } = useAgentglass();
  const router = useRouter();
  const [pulling, setPulling] = useState(false);

  const queue = useQueue(fleet);
  const waiting = waitingItems(queue);
  const news = newsItems(queue);
  // Pinned to the moment of the last load rather than to render time, for the
  // reason use-queue.ts sets out: an agent must not cross from "thinking" to
  // "stopped" because the list re-rendered.
  const now = fleet.at || Date.now();
  const agents = runningAgents(fleet.sessions, fleet.gates, now);

  const onRefresh = useCallback((): void => {
    setPulling(true);
    refresh();
    // The refresh is fire-and-forget in the store, so the spinner is on a
    // timer rather than on the request. Lying for 600ms beats plumbing a
    // promise through for a gesture nobody measures.
    setTimeout(() => setPulling(false), 600);
  }, [refresh]);

  return (
    <FlatList
      data={agents}
      keyExtractor={(agent) => agent.session.session_id}
      contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.sm, paddingBottom: SPACE.xl }}
      refreshControl={<RefreshControl refreshing={pulling} onRefresh={onRefresh} tintColor={C.text3} />}
      ListHeaderComponent={
        <View style={{ gap: SPACE.md, paddingBottom: SPACE.md }}>
          <Band
            waiting={waiting.length}
            news={news.length}
            top={waiting[0]?.title ?? null}
            onOpen={() => router.push("/now")}
          />
          <View style={{
            flexDirection: "row", alignItems: "center", gap: SPACE.sm,
            paddingHorizontal: SPACE.xs,
          }}>
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
          <Label text={agents.length ? `On the machine · ${agents.length}` : "On the machine"} />
        </View>
      }
      ListEmptyComponent={
        // Nothing has arrived yet is not the same claim as nothing is running,
        // and drawing the second one during the first is how a companion looks
        // broken on a cold start.
        fleet.at === 0 ? null : (
          <Card>
            <Label text="Quiet" />
            <Note>
              No agent has run here in the last twelve hours. The terminal below opens the
              computer&apos;s own shells, which is where one gets started.
            </Note>
          </Card>
        )
      }
      renderItem={({ item }) => (
        <AgentRow
          agent={item}
          now={now}
          // The object form, not a built string: a session id is a uuid today
          // and the path segment would need escaping the day it is not.
          onOpen={() => router.push({ pathname: "/chat/[id]", params: { id: item.session.session_id } })}
        />
      )}
    />
  );
}
