/*
 * The conversations, and which of them are still going.
 *
 * The same session you left at the desk, and still the same one when you sit
 * back down: it lives on the server, not in a browser tab and not on this
 * phone. So this list is a way back into work rather than a history of it.
 *
 * `live` is the opening scope when anything is live, because the reason to
 * reach for this on a phone is almost always something that is running now.
 * When nothing is, it falls back rather than opening on an empty screen — the
 * rule is the browser companion's `openingScope`, imported rather than
 * re-decided.
 */
import { useCallback, useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import type { SessionRollup } from "../../../shared/types.ts";
import { canResume, openingScope, scopeSessions, searchSessions, type ChatScope } from "../../src/model/chatList.ts";
import { useAgentglass } from "../../src/state/host-context.tsx";
import { usePaletteTick } from "../../src/state/use-palette.ts";
import { since } from "../../src/lib/dates.ts";
import { Card, Label, Note } from "../../src/ui.tsx";
import { C, MONO, RADIUS, SPACE, T } from "../../src/theme.ts";

const SCOPES: { id: ChatScope; label: string }[] = [
  { id: "live", label: "Live" },
  { id: "today", label: "Today" },
  { id: "all", label: "All" },
];

/** What to call a conversation. The order is the order of how much a person
 *  meant it: a title they typed, then one the app inferred, then the prompt
 *  that started it, then the directory. */
function title(s: SessionRollup): string {
  return s.custom_title || s.ai_title || (s.first_prompt ?? "").slice(0, 80)
    || (s.cwd_path ?? s.project_path ?? "").split("/").filter(Boolean).pop()
    || "Untitled";
}

const LIVE_MS = 120_000;

function Row({ session, onOpen, now }: {
  session: SessionRollup;
  onOpen: () => void;
  now: number;
}): React.ReactNode {
  const live = !session.ended_at && now - session.last_seen < LIVE_MS;
  const where = (session.cwd_path ?? session.project_path ?? "").split("/").filter(Boolean).pop() ?? "";
  return (
    <Pressable onPress={onOpen}>
      <Card style={{ gap: SPACE.sm }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
          {/* A dot rather than the word "live": it is the only state worth a
              colour here, and a row of green words reads as decoration. */}
          <View style={{
            width: 7, height: 7, borderRadius: 4,
            backgroundColor: live ? C.success : "transparent",
            borderWidth: live ? 0 : 1, borderColor: C.text4,
          }} />
          <Text style={{ color: C.text4, fontSize: T.eyebrow, fontFamily: MONO }}>{where}</Text>
          <View style={{ flex: 1 }} />
          <Text style={{ color: C.text4, fontSize: T.eyebrow }}>
            {since(new Date(session.last_seen).toISOString(), now)}
          </Text>
        </View>

        <Text style={{ color: C.text, fontSize: T.body, lineHeight: 19 }} numberOfLines={2}>
          {title(session)}
        </Text>

        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.md }}>
          <Text style={{ color: C.text4, fontSize: T.eyebrow, fontFamily: MONO }}>
            {(session.model_name ?? "").replace(/^claude-/, "")}
          </Text>
          {typeof session.cost_usd === "number" && session.cost_usd > 0 ? (
            <Text style={{ color: C.text4, fontSize: T.eyebrow, fontFamily: MONO }}>
              ${session.cost_usd.toFixed(2)}
            </Text>
          ) : null}
          {/* Said on the row, because it decides whether tapping is worth it:
              a session with no directory on record cannot be picked up. */}
          {canResume(session) ? null : (
            <Text style={{ color: C.text4, fontSize: T.eyebrow }}>read-only</Text>
          )}
        </View>
      </Card>
    </Pressable>
  );
}

export default function ChatsScreen(): React.ReactNode {
  usePaletteTick(); // a scene repaints only if it asks — see use-palette.ts
  const { fleet, refresh } = useAgentglass();
  const router = useRouter();
  const [scope, setScope] = useState<ChatScope | null>(null);
  const [query, setQuery] = useState("");
  const [pulling, setPulling] = useState(false);

  const now = fleet.at || Date.now();
  // Opened on whatever scope has something in it. Chosen once from the data
  // rather than defaulted, so the first thing you see is never an empty list
  // that makes the app look broken.
  const chosen = scope ?? openingScope(fleet.sessions, now);

  const shown = useMemo(() => {
    const inScope = scopeSessions(fleet.sessions, chosen, now);
    return query.trim() ? searchSessions(inScope, query) : inScope;
  }, [fleet.sessions, chosen, query, now]);

  const onRefresh = useCallback((): void => {
    setPulling(true);
    refresh();
    setTimeout(() => setPulling(false), 600);
  }, [refresh]);

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={{
        flexDirection: "row", gap: SPACE.xs, paddingHorizontal: SPACE.lg, paddingVertical: SPACE.sm,
        alignItems: "center",
      }}>
        {SCOPES.map((s) => {
          const on = s.id === chosen;
          return (
            <Pressable
              key={s.id}
              onPress={() => setScope(s.id)}
              style={{
                paddingHorizontal: SPACE.md, minHeight: 36, justifyContent: "center",
                borderRadius: RADIUS.sm, backgroundColor: on ? C.bg3 : "transparent",
              }}
            >
              <Text style={{ color: on ? C.text : C.text4, fontSize: T.small }}>{s.label}</Text>
            </Pressable>
          );
        })}
      </View>

      <View style={{ paddingHorizontal: SPACE.lg, paddingBottom: SPACE.sm }}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search these conversations"
          placeholderTextColor={C.text4}
          autoCapitalize="none"
          autoCorrect={false}
          style={{
            minHeight: 40, borderRadius: RADIUS.md, backgroundColor: C.bg2,
            borderWidth: 1, borderColor: C.border, color: C.text,
            paddingHorizontal: SPACE.md, fontSize: T.small,
          }}
        />
      </View>

      <FlatList
        data={shown}
        keyExtractor={(s) => s.session_id}
        contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md, paddingBottom: SPACE.xl }}
        refreshControl={<RefreshControl refreshing={pulling} onRefresh={onRefresh} tintColor={C.text3} />}
        ListEmptyComponent={
          fleet.at === 0 ? null : (
            <Card>
              <Label text="Nothing here" />
              <Note>
                {query.trim()
                  ? "No conversation matches that."
                  : chosen === "live"
                    ? "No agent is running right now. Today and All have the rest."
                    : "No conversation in this window."}
              </Note>
            </Card>
          )
        }
        renderItem={({ item }) => (
          <Row
            session={item}
            now={now}
            // The object form, not a built string: a session id is a uuid today
            // and the path segment would need escaping the day it is not.
            onOpen={() => router.push({ pathname: "/chat/[id]", params: { id: item.session_id } })}
          />
        )}
      />
    </View>
  );
}
