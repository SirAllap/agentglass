/*
 * A card on the board: its id and when it is due, what it is called, where it
 * stands, how much talk and code hangs off it, and who carries it.
 *
 * Its own surface, not a row in a shared group: the list is sectioned by status
 * and a card is a thing you pick up, as a pull request is (review/PrCard.tsx).
 * The whole card is the touch target; a long press copies its id, which is the
 * one thing you cannot retype from memory on a phone.
 */
import { Pressable, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import type { ProviderTask } from "../../../shared/providers.ts";
import { AvatarStack } from "../Avatar.tsx";
import { Glyph } from "../nav/glyphs.tsx";
import { dueIn } from "../lib/dates.ts";
import { statusInk } from "../model/cardStatus.ts";
import { highlight } from "../model/prSearch.ts";
import { C, MONO, RADIUS, SPACE, T, tint } from "../theme.ts";

/** The faces are the tallest thing on the line; every card keeps that height
 *  so one with nobody on it is not shorter than its neighbours. */
const AVATAR_ROW = 28;

function Count({ glyph, n, label }: { glyph: "pr" | "comment"; n: number; label: string }): React.ReactNode {
  return (
    <View accessibilityLabel={`${n} ${label}`} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      <Glyph name={glyph} color={C.text3} size={16} />
      <Text style={{ color: C.text2, fontSize: T.small, fontVariant: ["tabular-nums"] }}>{n}</Text>
    </View>
  );
}

export function CardRow({ task, prs, query, showList, onCopied, onOpen }: {
  task: ProviderTask;
  /** Pull requests, when known (model/cardBoard.ts prCount); null draws none. */
  prs: number | null;
  /** The search box's words, marked in the title. */
  query: string;
  /** The list it lives in, for a board that spans several. */
  showList: boolean;
  onCopied: (what: string) => void;
  onOpen: () => void;
}): React.ReactNode {
  const when = dueIn(task.due, new Date());
  const ink = statusInk(task.statusColor) ?? C.text3;
  const people = task.people ?? [];
  const id = task.customId || task.id;
  return (
    <Pressable
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={`${id}. ${task.title}. ${task.status}${when ? `, due ${when.text}` : ""}`}
      onLongPress={() => {
        void Clipboard.setStringAsync(id);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        onCopied(id);
      }}
      style={({ pressed }) => ({
        backgroundColor: pressed ? C.bg3 : C.bg2, borderWidth: 1, borderColor: C.border, borderRadius: RADIUS.lg,
        padding: 14, gap: SPACE.sm,
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
        <Text style={{ color: C.text3, fontSize: T.small, fontFamily: MONO }}>{id}</Text>
        {showList && task.list ? <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.small, flexShrink: 1 }}>· {task.list}</Text> : null}
        <View style={{ flex: 1 }} />
        {when ? <Text style={{ color: when.late ? C.error : C.text3, fontSize: T.small, fontWeight: "600" }}>{when.text}</Text> : null}
      </View>
      <Text numberOfLines={3} style={{ color: C.text, fontSize: 16, fontWeight: "600", lineHeight: 21 }}>
        {highlight(task.title, query).map((piece, i) => (
          piece.hit
            ? <Text key={i} style={{ backgroundColor: tint(C.warning, 0.35) }}>{piece.text}</Text>
            : piece.text
        ))}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.md, minHeight: AVATAR_ROW }}>
        <View style={{
          flexDirection: "row", alignItems: "center", gap: 6, height: 24, paddingHorizontal: 8, borderRadius: 6, flexShrink: 1,
          backgroundColor: /^#[0-9a-f]{6}$/i.test(ink) ? tint(ink, 0.18) : C.bg3,
        }}>
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: ink }} />
          <Text numberOfLines={1} style={{ color: C.text, fontSize: T.eyebrow, fontWeight: "700", letterSpacing: 0.4, textTransform: "uppercase", flexShrink: 1 }}>
            {task.status}
          </Text>
        </View>
        {prs ? <Count glyph="pr" n={prs} label={prs === 1 ? "pull request" : "pull requests"} /> : null}
        {task.comments ? <Count glyph="comment" n={task.comments} label={task.comments === 1 ? "comment" : "comments"} /> : null}
        <View style={{ flex: 1 }} />
        {people.length ? <AvatarStack people={people} /> : null}
      </View>
    </Pressable>
  );
}
