/*
 * The three things the Overview of a pull request leads with: whether it can
 * merge and whose move it is, who has said what about the code, and the work
 * it belongs to. What each says is decided in model/prOverview.ts and
 * model/prCard.ts; these only draw it.
 */
import { Pressable, Text, View } from "react-native";
import type { PrSummary } from "../../../shared/types.ts";
import type { JiraReach } from "../../../shared/taskref.ts";
import type { Host } from "../lib/host.ts";
import { ago } from "../model/cardStatus.ts";
import { usePrCard } from "../state/pr-cards.ts";
import { Avatar, AvatarStack, AVATAR } from "../Avatar.tsx";
import type { ReviewerRow } from "../model/prOverview.ts";
import type { Tone } from "../model/prLook.ts";
import type { CardLine } from "../model/prCard.ts";
import { Glyph, type GlyphName } from "../nav/glyphs.tsx";
import { Card, Chip, GroupTitle } from "../ui.tsx";
import { CardChip } from "./PrCard.tsx";
import { RoleBadge } from "./Bubble.tsx";
import { C, RADIUS, SPACE, T, tint } from "../theme.ts";

/** "Merging is blocked", and why. It is the door to the merge sheet on an open
 *  pull request, so it is a button only then.
 *
 *  The mock's strip (32) leads with the run — "2 of 3 jobs passed", and which
 *  job you are waiting for — and says the merge situation underneath. The
 *  surface is the accent's wash whichever way the verdict went: this is the
 *  screen's lead, and a red block on a phone is the whole top of the page. */
export function MergeBannerCard({ chip, when, text, onPress }: {
  chip: { label: string; tone: Tone; icon?: React.ReactNode };
  when?: string | null;
  text: string;
  onPress?: () => void;
}): React.ReactNode {
  const body = (
    <View style={{
      gap: SPACE.sm, paddingVertical: 12, paddingHorizontal: 13, borderRadius: 16,
      backgroundColor: tint(C.primary, 0.14),
    }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Chip label={chip.label} tone={chip.tone} icon={chip.icon} />
        {when ? (
          <Text numberOfLines={1} style={{ marginLeft: "auto", color: C.text3, fontSize: T.small }}>
            {when}
          </Text>
        ) : null}
      </View>
      <Text style={{ color: C.text2, fontSize: 13, lineHeight: 19 }}>{text}</Text>
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
 *  approve, and a reader should see that it was a machine that did. The row is
 *  the mock's (32): a 34-point face, the name over when they last said
 *  something, and the verdict as a chip on the right.
 *
 *  The section head is the screen's, because it carries a button ("Request")
 *  that opens a sheet the screen owns; this draws only the card. */
export function ReviewersCard({ rows, now }: { rows: readonly ReviewerRow[]; now: number }): React.ReactNode {
  if (!rows.length) return null;
  return (
      <Card style={{ padding: 0, gap: 0 }}>
        {rows.map((r, i) => {
          const when = r.at ? `${r.said} ${ago(r.at, now)}` : r.said;
          return (
            <View
              key={r.key}
              accessibilityLabel={`${r.login}${r.bot ? ", automation" : ""}: ${r.word}`}
              style={{
                flexDirection: "row", alignItems: "center", gap: SPACE.md, minHeight: 54,
                paddingHorizontal: 12, paddingVertical: 10,
                borderTopWidth: i ? 1 : 0, borderTopColor: C.border,
              }}
            >
              {r.team
                ? <View style={{ width: AVATAR.rail, height: AVATAR.rail, borderRadius: AVATAR.rail / 2, backgroundColor: C.bg3, alignItems: "center", justifyContent: "center" }}>
                    <Glyph name="people" color={C.text2} size={18} />
                  </View>
                : <Avatar name={r.login} login={r.login} bot={r.bot} size={AVATAR.rail} />}
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <Text numberOfLines={1} style={{ color: C.text, fontSize: 13.5, fontWeight: "600" }}>{r.login}</Text>
                  {r.bot ? <RoleBadge text="BOT" /> : null}
                </View>
                <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.small }}>{when}</Text>
              </View>
              <Chip label={r.chip} tone={r.tone} />
            </View>
          );
        })}
      </Card>
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
 *
 * The card names its own tracker, so a tap opens the screen that can draw it:
 * a Jira key is not a ClickUp id even when the two strings look alike.
 */
export function LinkedCard({ host, pr, tracked, jira, onOpen }: {
  host: Host; pr: PrSummary; tracked: boolean | null; jira?: JiraReach | null;
  onOpen?: (id: string, tracker: "clickup" | "jira") => void;
}): React.ReactNode {
  const { state } = usePrCard(host, pr, tracked, jira);
  if (state.kind !== "card") return null;
  const jiraCard = state.card.tracker === "jira";
  // Jira's own key is the human one; ClickUp keeps its plain task id.
  const id = jiraCard ? state.card.customId ?? state.card.id : state.card.id;
  return (
    <LinkedCardRow
      card={state.card}
      onOpen={onOpen ? () => onOpen(id, jiraCard ? "jira" : "clickup") : undefined}
    />
  );
}
