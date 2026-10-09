/*
 * The three things the Overview of a pull request leads with: whether it can
 * merge and whose move it is, who has said what about the code, and the work
 * it belongs to. What each says is decided in model/prOverview.ts and
 * model/prCard.ts; these only draw it.
 */
import { Pressable, Text, View } from "react-native";
import type { PrSummary } from "../../../shared/types.ts";
import type { Host } from "../lib/host.ts";
import { usePrCard } from "../state/pr-cards.ts";
import { Avatar, AvatarStack, AVATAR } from "../Avatar.tsx";
import type { MergeBanner, ReviewerRow } from "../model/prOverview.ts";
import type { CardLine } from "../model/prCard.ts";
import { Glyph, type GlyphName } from "../nav/glyphs.tsx";
import { Group, GroupTitle, toneInk } from "../ui.tsx";
import { CardChip } from "./PrCard.tsx";
import { RoleBadge } from "./Bubble.tsx";
import { C, RADIUS, SPACE, T, tint } from "../theme.ts";

const BANNER_GLYPH = { bad: "x_circle", warn: "alert", good: "ok_circle", neutral: "merge", accent: "merge" } as const satisfies Record<string, GlyphName>;

/** "Merging is blocked", and why. It is the door to the merge sheet on an open
 *  pull request, so it is a button only then. */
export function MergeBannerCard({ banner, onPress }: { banner: MergeBanner; onPress?: () => void }): React.ReactNode {
  const ink = banner.tone === "neutral" ? C.text2 : toneInk(banner.tone);
  const body = (
    <View style={{
      gap: SPACE.xs, padding: SPACE.lg, borderRadius: RADIUS.lg, borderWidth: 1,
      borderColor: tint(ink, 0.4), backgroundColor: tint(ink, 0.12),
    }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
        <Glyph name={BANNER_GLYPH[banner.tone]} color={ink} size={20} weight={2} />
        <Text style={{ color: ink, fontSize: T.body + 1, fontWeight: "700", flex: 1 }}>{banner.title}</Text>
      </View>
      <Text style={{ color: C.text, fontSize: T.body, lineHeight: 20 }}>{banner.text}</Text>
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable accessibilityRole="button" accessibilityHint="Opens the merge options" onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
      {body}
    </Pressable>
  );
}

/** Each reviewer with where they stand. Automation is shown and tagged: it can
 *  approve, and a reader should see that it was a machine that did. */
export function ReviewersCard({ rows }: { rows: readonly ReviewerRow[] }): React.ReactNode {
  if (!rows.length) return null;
  return (
    <View>
      <GroupTitle text="Reviewers" />
      <Group inset={SPACE.lg + AVATAR.rail + SPACE.md}>
        {rows.map((r) => {
          const ink = r.tone === "neutral" ? C.text3 : toneInk(r.tone);
          return (
            <View
              key={r.key}
              accessibilityLabel={`${r.login}${r.bot ? ", automation" : ""}: ${r.word}`}
              style={{ flexDirection: "row", alignItems: "center", gap: SPACE.md, minHeight: 56, paddingHorizontal: SPACE.lg, paddingVertical: SPACE.sm }}
            >
              {r.team
                ? <View style={{ width: AVATAR.rail, height: AVATAR.rail, borderRadius: AVATAR.rail / 2, backgroundColor: C.bg3, alignItems: "center", justifyContent: "center" }}>
                    <Glyph name="people" color={C.text2} size={18} />
                  </View>
                : <Avatar name={r.login} login={r.login} bot={r.bot} size={AVATAR.rail} />}
              <Text numberOfLines={1} style={{ color: C.text, fontSize: 15, fontWeight: "500", flexShrink: 1 }}>{r.login}</Text>
              {r.bot ? <RoleBadge text="BOT" /> : null}
              <View style={{ flex: 1 }} />
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Glyph name={r.glyph} color={ink} size={16} weight={2.2} />
                <Text style={{ color: ink, fontSize: T.small, fontWeight: "700" }}>{r.word}</Text>
              </View>
            </View>
          );
        })}
      </Group>
    </View>
  );
}

/** The card this pull request is for: its id, its status, the people on it. */
export function LinkedCardRow({ card, onOpen }: { card: CardLine; onOpen?: () => void }): React.ReactNode {
  const body = (
    <View style={{
      flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: SPACE.sm, minHeight: 56,
      paddingHorizontal: SPACE.lg, paddingVertical: SPACE.sm, backgroundColor: C.bg2, borderRadius: RADIUS.lg,
      borderWidth: 1, borderColor: C.border,
    }}>
      <CardChip card={card} />
      {card.people?.length ? <AvatarStack people={card.people} size={AVATAR.field} /> : null}
    </View>
  );
  return (
    <View>
      <GroupTitle text="Card" />
      {onOpen ? (
        <Pressable accessibilityRole="button" accessibilityLabel={`Open card ${card.customId || card.id}`} onPress={onOpen}>{body}</Pressable>
      ) : body}
    </View>
  );
}

/**
 * The linked card, found the way the list finds it: from what the boards
 * already hold, which costs no request. Nothing is drawn until there is a card
 * to show; the title's chip is the door for one that has to be looked up,
 * because a lookup that costs a tracker request is the person's to ask for.
 */
export function LinkedCard({ host, pr, tracked, onOpen }: {
  host: Host; pr: PrSummary; tracked: boolean | null; onOpen?: (id: string) => void;
}): React.ReactNode {
  const { state } = usePrCard(host, pr, tracked);
  if (state.kind !== "card") return null;
  const id = state.card.id;
  return <LinkedCardRow card={state.card} onOpen={onOpen ? () => onOpen(id) : undefined} />;
}
