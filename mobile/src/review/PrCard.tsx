/*
 * A pull request as a card: the verdict first, then what it is, then the work
 * it belongs to.
 *
 * Every word and choice is decided in model/prCard.ts. This paints them, and
 * keeps one promise: the parts never move between states. The banner, the CI
 * bar and the card line each keep their row whether they have something to say
 * or not, so a card that finishes loading does not jump under the thumb.
 *
 * The whole card is the touch target. The only control inside it is the
 * look-up on a card the boards do not hold, and that one says what it costs.
 */
import { Pressable, Text, View } from "react-native";
import type { PrSummary } from "../../../shared/types.ts";
import type { Unread } from "../../../shared/prUnread.ts";
import { unreadTitle } from "../../../shared/prUnread.ts";
import { AVATAR, AvatarStack } from "../Avatar.tsx";
import { LabelChip, toneInk } from "../ui.tsx";
import { Glyph, type GlyphName } from "../nav/glyphs.tsx";
import { since } from "../lib/dates.ts";
import { highlight } from "../model/prSearch.ts";
import { bannerLook, ciSegments, threadsLabel, type CardLine, type CardState, type Seg } from "../model/prCard.ts";
import type { Tone } from "../model/prLook.ts";
import { C, MONO, RADIUS, SPACE, T, tint } from "../theme.ts";

const BANNER_ICON: Record<Tone, GlyphName> = {
  bad: "x_circle", good: "ok_circle", warn: "clock", accent: "clock", neutral: "draft_circle",
};

const SEG: Record<Seg, () => string> = { ok: () => C.success, fail: () => C.error, run: () => C.warning };

/** Two labels are what fits beside the size on a phone; the rest is a count. */
const LABELS_SHOWN = 2;

function Bar({ pr }: { pr: PrSummary }): React.ReactNode {
  const segs = ciSegments(pr);
  return (
    <View style={{ flexDirection: "row", gap: 2, height: 4 }}>
      {segs
        ? segs.map((s, i) => <View key={i} style={{ flex: 1, borderRadius: 2, backgroundColor: SEG[s]() }} />)
        /* Not read, or no checks: an empty track, because the bar's row is
           kept for when they arrive. */
        : <View style={{ flex: 1, borderRadius: 2, backgroundColor: C.bg3 }} />}
    </View>
  );
}

export function CardChip({ card }: { card: CardLine }): React.ReactNode {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm, flexShrink: 1 }}>
      <View style={{ height: 28, paddingHorizontal: 8, borderRadius: 6, justifyContent: "center", backgroundColor: tint(C.primary, 0.14) }}>
        <Text numberOfLines={1} style={{ color: C.primary, fontSize: T.small, fontFamily: MONO, fontWeight: "700" }}>
          {card.customId || card.id}
        </Text>
      </View>
      <View style={{
        flexDirection: "row", alignItems: "center", gap: 6, height: 28, paddingHorizontal: 8,
        borderRadius: 6, backgroundColor: C.bg3, flexShrink: 1,
      }}>
        <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: card.statusColor || C.text4 }} />
        <Text numberOfLines={1} style={{ color: C.text2, fontSize: T.eyebrow, fontWeight: "700", letterSpacing: 0.4, textTransform: "uppercase", flexShrink: 1 }}>
          {card.status}
        </Text>
      </View>
    </View>
  );
}

/** The dashed stand-in: a card that is not there, or not known yet. */
export function Ghost({ text, onPress, label }: { text: string; onPress?: () => void; label?: string }): React.ReactNode {
  const body = (
    <View style={{
      height: 28, paddingHorizontal: 10, borderRadius: 6, justifyContent: "center", alignSelf: "flex-start",
      borderWidth: 1, borderStyle: "dashed", borderColor: C.border2,
    }}>
      <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.small, fontWeight: "600" }}>{text}</Text>
    </View>
  );
  if (!onPress) return body;
  // 28 high, 48 to hit: the card around it is also a button and a slip here
  // must not open the pull request.
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label ?? text} hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }} onPress={onPress}>
      {body}
    </Pressable>
  );
}

function CardLineRow({ state, onFind }: { state: CardState; onFind: () => void }): React.ReactNode {
  /* Same height in every state, so a card that resolves does not move the list. */
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: SPACE.sm, height: 28 }}>
      {state.kind === "card" ? (
        <>
          <CardChip card={state.card} />
          {state.card.people?.length ? <AvatarStack people={state.card.people} /> : null}
        </>
      ) : state.kind === "asking" || state.kind === "finding" ? (
        <View accessibilityLabel="Looking up the linked card" style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
          <View style={{ width: 70, height: 28, borderRadius: 6, backgroundColor: C.bg3 }} />
          <View style={{ width: 96, height: 28, borderRadius: 6, backgroundColor: C.bg3 }} />
          <Text style={{ color: C.text3, fontSize: T.small }}>looking up card…</Text>
        </View>
      ) : state.kind === "look" || state.kind === "missed" ? (
        <Ghost
          text={state.kind === "missed" ? `${state.query} · not found, try again` : `${state.query} · look up card`}
          label={`Look up card ${state.query}. This asks the tracker once.`}
          onPress={onFind}
        />
      ) : <Ghost text="no linked card" />}
    </View>
  );
}

export function PrCard({ pr, now, forMe, unread, card, query, onFind, onOpen }: {
  pr: PrSummary;
  now: number;
  forMe: boolean;
  unread: Unread | null;
  card: CardState;
  /** What the search box says: its words are marked in the title. */
  query?: string;
  onFind: () => void;
  onOpen: () => void;
}): React.ReactNode {
  const banner = bannerLook(pr, { forMe, unread: unread?.count });
  const gone = pr.state === "OPEN" ? null : pr.state === "MERGED" ? "Merged" : "Closed";
  const ink_ = toneInk(banner.tone);
  const threads = threadsLabel(pr);
  // In the banner already when it is what the banner's right edge says.
  const threadsBelow = threads && banner.right !== threads ? threads : null;
  const shown = pr.labels.slice(0, LABELS_SHOWN);
  return (
    <Pressable
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={`${banner.label}${banner.right ? `, ${banner.right}` : ""}. ${gone ? `${gone}. ` : ""}${pr.title}. #${pr.number} by ${pr.author}${unread ? `. ${unreadTitle(unread)}` : ""}`}
      style={({ pressed }) => ({
        backgroundColor: pressed ? C.bg3 : C.bg2, borderWidth: 1, borderColor: C.border,
        borderRadius: RADIUS.lg, overflow: "hidden",
      })}
    >
      <View style={{
        flexDirection: "row", alignItems: "center", gap: SPACE.sm,
        paddingHorizontal: 14, paddingVertical: 9, backgroundColor: banner.tone === "neutral" ? C.bg3 : tint(ink_, 0.14),
      }}>
        <Glyph name={BANNER_ICON[banner.tone]} color={ink_} size={16} weight={2} />
        <Text numberOfLines={1} style={{ color: ink_, fontSize: T.small, fontWeight: "700", flexShrink: 1 }}>{banner.label}</Text>
        <View style={{ flex: 1 }} />
        {banner.right ? (
          <Text numberOfLines={1} style={{ color: ink_, fontSize: T.eyebrow, fontWeight: "600" }}>{banner.right}</Text>
        ) : null}
      </View>
      <View style={{ padding: 14, gap: 10 }}>
        <Text numberOfLines={2} style={{ color: C.text, fontSize: 16, fontWeight: "600", lineHeight: 21 }}>
          <Text style={{ color: C.text3, fontSize: T.small, fontFamily: MONO, fontWeight: "400" }}>#{pr.number}  </Text>
          {(query ? highlight(pr.title, query) : [{ text: pr.title, hit: false }]).map((piece, i) => (
            piece.hit
              ? <Text key={i} style={{ backgroundColor: tint(C.warning, 0.35) }}>{piece.text}</Text>
              : piece.text
          ))}
        </Text>
        <Bar pr={pr} />
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 8, rowGap: 6 }}>
          <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.small }}>
            {gone ? `${gone} · ` : ""}{pr.author} · {since(pr.updatedAt, now)}
          </Text>
          {shown.map((l) => <LabelChip key={l.name} name={l.name} color={l.color} />)}
          {pr.labels.length > shown.length ? <Text style={{ color: C.text3, fontSize: T.small }}>+{pr.labels.length - shown.length}</Text> : null}
          {threadsBelow ? <Text style={{ color: C.warning, fontSize: T.small, fontWeight: "600" }}>{threadsBelow}</Text> : null}
          <View style={{ flex: 1 }} />
          <Text style={{ fontSize: T.small, fontFamily: MONO }}>
            <Text style={{ color: C.success }}>+{pr.additions}</Text>
            <Text style={{ color: C.error }}> −{pr.deletions}</Text>
          </Text>
        </View>
        <CardLineRow state={card} onFind={onFind} />
      </View>
    </Pressable>
  );
}
