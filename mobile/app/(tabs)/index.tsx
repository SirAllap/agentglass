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
import {
  ageLabel, planState, quotaTone, remainingOf, resetLabel, tightestWindow,
} from "../../src/model/quota.ts";
import { ChevronIcon, NowIcon } from "../../src/nav/icons.tsx";
import { useAgentglass } from "../../src/state/host-context.tsx";
import { usePaletteTick } from "../../src/state/use-palette.ts";
import { useQueue } from "../../src/state/use-queue.ts";
import { useUsage } from "../../src/state/use-usage.ts";
import { Card, Label, Note } from "../../src/ui.tsx";
import { C, MONO, RADIUS, SPACE, T, toneColor } from "../../src/theme.ts";
import type { ProviderUsage, QuotaWindow } from "../../../shared/types.ts";

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

/** One window, as a bar of what is LEFT of it.
 *
 *  Left, not used, and the direction is the whole point: this screen is read on
 *  the way somewhere to decide whether to start something, and a bar that fills
 *  up as you work answers the opposite question. A window with nothing left
 *  draws no bar at all, which is the same rule the desk's meter follows in
 *  reverse: the one thing this must never overstate is how much you have. */
function Meter({ label, window: w, now }: {
  label: string;
  window: QuotaWindow;
  now: number;
}): React.ReactNode {
  const left = remainingOf(w);
  const ink = toneColor(quotaTone(w.usedPercent));
  const resets = resetLabel(w.resetsAt, now);
  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={`${label}: ${left}% left${resets ? `, resets ${resets}` : ""}`}
      style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}
    >
      <Text style={{ color: C.text4, fontSize: T.eyebrow, width: 62 }} numberOfLines={1}>{label}</Text>
      <View style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: C.bg, overflow: "hidden" }}>
        {left > 0 ? (
          <View style={{ width: `${left}%`, height: "100%", borderRadius: 3, backgroundColor: ink }} />
        ) : null}
      </View>
      <Text style={{
        color: ink, fontSize: T.small, fontWeight: "600", width: 42, textAlign: "right",
      }}>{left}%</Text>
    </View>
  );
}

/**
 * What is left of the plan, above the agents that are spending it.
 *
 * The headline is the window closest to running out across every provider, and
 * it is stated once in full size rather than left for the eye to find among the
 * bars under it. That is the question the card is here to answer: an agent you
 * are about to start is stopped by the tightest window, not by the average of
 * them.
 *
 * Four states, all of them said out loud. The expensive one to get wrong is
 * "could not reach the computer", which must never be drawn as an empty bar: a
 * phone off the network would otherwise report the plan as spent.
 */
function PlanCard({ rows, loaded, error, now }: {
  rows: ProviderUsage[] | null;
  loaded: boolean;
  error: string | null;
  now: number;
}): React.ReactNode {
  const state = planState(loaded, rows);
  if (state === "loading") return null; // nothing is more honest than nothing, for one poll
  const top = tightestWindow(rows);
  // Only worth naming the provider on each bar when more than one is reporting.
  // On a machine with Claude alone, "Claude · 5h" on every row is one word of
  // signal and one of furniture.
  const providers = (rows ?? []).filter((r) => r.available).length;

  return (
    <Card style={{ gap: SPACE.sm, padding: SPACE.md }}>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <Label text="Plan left" />
        <View style={{ flex: 1 }} />
        {/* The age belongs beside the number it qualifies. The computer holds a
            reading for fifteen minutes and keeps the last good one for up to a
            day while the endpoint is rate-limiting, so a stale percentage looks
            exactly like a live one unless it says so. */}
        {top ? (
          <Text style={{ color: C.text4, fontSize: T.eyebrow }}>{ageLabel(top.observedAt, now)}</Text>
        ) : null}
      </View>

      {state === "unreachable" ? (
        <Note>{error ?? "The computer did not answer about the plan."}</Note>
      ) : null}
      {state === "empty" ? (
        <Note>No agent on this computer reports a plan quota.</Note>
      ) : null}

      {top ? (
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: SPACE.sm }}>
          <Text style={{
            color: toneColor(quotaTone(top.window.usedPercent)),
            fontSize: 30, fontWeight: "700", lineHeight: 36,
          }}>{remainingOf(top.window)}%</Text>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ color: C.text2, fontSize: T.small }} numberOfLines={1}>
              left of {top.provider} · {top.window.label}
            </Text>
            {top.window.resetsAt ? (
              <Text style={{ color: C.text4, fontSize: T.eyebrow }} numberOfLines={1}>
                resets {resetLabel(top.window.resetsAt, now)}
              </Text>
            ) : null}
          </View>
        </View>
      ) : null}

      {(rows ?? []).filter((r) => r.available).map((row) => (
        row.windows.map((w) => (
          <Meter
            key={`${row.provider}:${w.label}`}
            label={providers > 1 ? `${row.label} ${w.label}` : w.label}
            window={w}
            now={now}
          />
        ))
      ))}

      {/* Why an unavailable provider is silent HERE, when the desk's panel
          prints its note.
          A note is an explanation, and an explanation is only worth the space
          when it is the answer. With Claude reporting, "No Codex sessions on
          this machine yet" is two lines of a phone's Home screen spent saying
          nothing about how much is left, which is the one thing this card is
          for. With NOTHING reporting, the same sentence is the whole answer,
          and a card showing a bare heading would look broken instead. */}
      {!top ? (rows ?? []).filter((r) => !r.available).map((row) => (
        <Note key={row.provider}>{row.label}: {row.note ?? "No reading."}</Note>
      )) : null}
    </Card>
  );
}

export default function HomeScreen(): React.ReactNode {
  usePaletteTick(); // a scene repaints only if it asks — see use-palette.ts
  const { fleet, live, refresh, host } = useAgentglass();
  const router = useRouter();
  const [pulling, setPulling] = useState(false);

  const usage = useUsage();
  // Held apart from `usage` itself: the hook hands back a fresh object every
  // render, so depending on it would rebuild the pull handler on every frame.
  // `reload` is stable.
  const reloadUsage = usage.reload;
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
    // Pulled down means "tell me where things stand", and the plan is part of
    // that. It mostly costs nothing: the computer answers this one out of a
    // fifteen-minute cache, which is the whole reason the phone may ask freely.
    reloadUsage();
    // The refresh is fire-and-forget in the store, so the spinner is on a
    // timer rather than on the request. Lying for 600ms beats plumbing a
    // promise through for a gesture nobody measures.
    setTimeout(() => setPulling(false), 600);
  }, [refresh, reloadUsage]);

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
          {/* Under the connection line on purpose. Every number in this card is
              a claim about another computer, and one that has been offline for
              ten minutes must not present the same screen as one that is
              connected. */}
          <PlanCard rows={usage.rows} loaded={usage.loaded} error={usage.error} now={now} />
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
