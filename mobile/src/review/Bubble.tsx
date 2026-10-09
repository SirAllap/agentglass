/*
 * What somebody said, drawn once: a face on a rail, and a bubble beside it.
 *
 * The pull request's conversation and a card's comments are the same thing to
 * look at — who, when, what, how others took it — and they were two different
 * drawings (a card of text with a face in its corner, and a column of bare
 * rows). This is the one, with its parts: `Rail` is the line that joins the
 * faces and the small marks for things that are not remarks, `Bubble` is a
 * remark, `EventLine` is a thing that happened. The screens supply the words.
 */
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { AVATAR } from "../Avatar.tsx";
import { Glyph, type GlyphName } from "../nav/glyphs.tsx";
import type { EventPart } from "../../../shared/prEventLine.ts";
import type { Tone } from "../model/talk.ts";
import { toneInk } from "../ui.tsx";
import { C, MONO, RADIUS, SPACE, T, tint } from "../theme.ts";

/** The mark on the rail for an event is smaller than a face and sits on the
 *  same line, so a column of both reads as one thread of time. */
const MARK = 22;
const GAP = SPACE.md;

/**
 * One row of the rail.
 *
 * The line runs behind the lead from row to row; the first row starts it at the
 * middle of its lead and the last ends it there, so it joins things rather than
 * hanging off either end. `size` is the lead's height, which is where "the
 * middle" is.
 */
export function Rail({ lead, size, first, last, children }: {
  lead: ReactNode; size: number; first?: boolean; last?: boolean; children: ReactNode;
}): ReactNode {
  const mid = size / 2;
  return (
    <View style={{ flexDirection: "row", gap: GAP, paddingBottom: last ? 0 : SPACE.md }}>
      <View style={{ width: AVATAR.rail, alignItems: "center" }}>
        <View
          pointerEvents="none"
          style={{
            position: "absolute", left: AVATAR.rail / 2 - 1, width: 2, backgroundColor: C.border,
            top: first ? mid : 0, ...(last ? { height: mid } : { bottom: -SPACE.md }),
          }}
        />
        {lead}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>{children}</View>
    </View>
  );
}

/** The mark for an event: a small ring on the rail with its glyph in the tone. */
export function RailMark({ glyph, tone }: { glyph: GlyphName; tone: Tone }): ReactNode {
  const ink = tone === "neutral" ? C.text3 : toneInk(tone);
  return (
    <View style={{
      width: MARK, height: MARK, borderRadius: MARK / 2, alignItems: "center", justifyContent: "center",
      backgroundColor: C.bg, borderWidth: 1.5, borderColor: tone === "neutral" ? C.border2 : ink,
    }}>
      <Glyph name={glyph} color={ink} size={12} weight={2.2} />
    </View>
  );
}
export const MARK_SIZE = MARK;

/** GitHub's word for somebody's standing, or "YOU": small, outlined, quiet. */
export function RoleBadge({ text }: { text: string }): ReactNode {
  return (
    <View style={{ borderRadius: 4, borderWidth: 1, borderColor: C.border2, paddingHorizontal: 5, paddingVertical: 1 }}>
      <Text style={{ color: C.text3, fontSize: 10, fontWeight: "700", letterSpacing: 0.4 }}>{text}</Text>
    </View>
  );
}

/** Emoji tallies under a remark. Read-only: reacting is a write. */
export function Reactions({ items }: { items: readonly { emoji: string; count: number; mine: boolean }[] }): ReactNode {
  if (!items.length) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACE.sm }}>
      {items.map((r) => (
        <View
          key={r.emoji}
          accessibilityLabel={`${r.count} ${r.emoji}${r.mine ? ", including you" : ""}`}
          style={{
            flexDirection: "row", alignItems: "center", gap: 4, height: 28, paddingHorizontal: 10, borderRadius: 14,
            borderWidth: 1, borderColor: r.mine ? C.primary : C.border2,
            backgroundColor: r.mine ? tint(C.primary, 0.14) : C.bg2,
          }}
        >
          <Text style={{ fontSize: T.small }}>{r.emoji}</Text>
          <Text style={{ color: r.mine ? C.primary : C.text2, fontSize: T.small, fontWeight: "600" }}>{r.count}</Text>
        </View>
      ))}
    </View>
  );
}

/**
 * A remark: who, what standing, when, and what it says.
 *
 * The header sits on its own band so the author is found before the prose is
 * read; `chips` are the things that are news about the remark (new, resolved, a
 * review's verdict) and `children` is the body, drawn by the caller because a
 * pull request's is Markdown over its own repository and a card's is
 * Markdown over the workspace.
 */
export function Bubble({ author, badge, chips, when, edited, children, reactions, dim }: {
  author: string;
  badge?: string | null;
  chips?: ReactNode;
  when: string;
  edited?: boolean;
  children?: ReactNode;
  reactions?: readonly { emoji: string; count: number; mine: boolean }[];
  dim?: boolean;
}): ReactNode {
  return (
    <View style={{
      borderRadius: RADIUS.md, borderWidth: 1, borderColor: C.border, backgroundColor: C.bg2, overflow: "hidden",
      opacity: dim ? 0.6 : 1,
    }}>
      <View style={{
        flexDirection: "row", alignItems: "center", gap: SPACE.sm, paddingVertical: SPACE.sm, paddingHorizontal: SPACE.md,
        backgroundColor: C.bg3,
      }}>
        <Text numberOfLines={1} style={{ color: C.text, fontSize: T.body, fontWeight: "700", flexShrink: 1 }}>{author}</Text>
        {badge ? <RoleBadge text={badge} /> : null}
        {chips}
        <View style={{ flex: 1 }} />
        <Text style={{ color: C.text3, fontSize: T.small }}>{edited ? `edited · ${when}` : when}</Text>
      </View>
      {children || reactions?.length ? (
        <View style={{ padding: SPACE.md, gap: SPACE.md }}>
          {children}
          {reactions ? <Reactions items={reactions} /> : null}
        </View>
      ) : null}
    </View>
  );
}

/** A thing that happened, as a sentence. The parts say what is bold or code;
 *  the words are shared with the desk (shared/prEventLine.ts). */
export function EventLine({ parts, when, below }: { parts: readonly EventPart[]; when: string; below?: ReactNode }): ReactNode {
  return (
    <View style={{ minHeight: MARK, justifyContent: "center", gap: 4 }}>
      <Text style={{ color: C.text2, fontSize: T.small, lineHeight: 18 }}>
        {parts.map((p, i) => {
          switch (p.as) {
            case "who": return <Text key={i} style={{ color: C.text, fontWeight: "700" }}>{p.text}</Text>;
            case "strong": case "label": return <Text key={i} style={{ color: C.text, fontWeight: "700" }}>{p.text}</Text>;
            case "code": return <Text key={i} style={{ color: C.text, fontFamily: MONO, fontSize: T.eyebrow }}>{p.text}</Text>;
            default: return p.text;
          }
        })}
        {when ? <Text style={{ color: C.text3 }}>{` · ${when}`}</Text> : null}
      </Text>
      {below}
    </View>
  );
}
