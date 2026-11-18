/*
 * The four things the board says when it has no cards to draw (mock 31):
 * loading, an empty view, offline, and a read-only phone.
 *
 * They are one component because they are one shape — an eyebrow, a sentence
 * saying what is going on, a paragraph saying what to do about it, and at most
 * one control — and because the alternative is four cards that drift apart.
 *
 * ── why a state is a card and not a line ──────────────────────────────────
 * "Reading the board…" in the middle of an empty screen is indistinguishable
 * from a board with nothing on it, and the two need different things from the
 * reader: one to wait, one to clear a filter. The eyebrow names which of the
 * four this is, so the difference is readable before the sentence under it.
 */
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { Card } from "../ui.tsx";
import { C, SPACE, T } from "../theme.ts";

export function StateCard({ eyebrow, title, text, children, quiet }: {
  /** One word for which state this is: Loading, Empty view, Offline, Read-only. */
  eyebrow: string;
  title: string;
  text: string;
  children?: ReactNode;
  /** The read-only one is a fact, not a problem: drawn without the emphasis. */
  quiet?: boolean;
}): ReactNode {
  return (
    <Card style={{ gap: SPACE.sm, opacity: quiet ? 0.9 : 1 }}>
      {/* The mock's eyebrow (31): 12 points, weight 700, the quiet ink, written
          as a word rather than in caps. */}
      <Text style={{ color: C.text3, fontSize: T.small, fontWeight: "700" }}>{eyebrow}</Text>
      <Text style={{ color: C.text, fontSize: T.body + 1, fontWeight: "600" }}>{title}</Text>
      <Text style={{ color: C.text3, fontSize: T.small, lineHeight: 18 }}>{text}</Text>
      {children}
    </Card>
  );
}

/** Two grey bars where a card will sit: the shape of "it is arriving", which a
 *  spinner in the middle of nothing does not give. */
export function CardSkeleton(): ReactNode {
  return (
    <View style={{
      flexDirection: "row", alignItems: "center", gap: SPACE.md, padding: SPACE.md,
      borderRadius: 14, borderWidth: 1, borderColor: C.border, backgroundColor: C.bg2,
    }}>
      <View style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: C.bg3 }} />
      <View style={{ flex: 1, gap: 6 }}>
        <View style={{ height: 10, width: "62%", borderRadius: 5, backgroundColor: C.bg3 }} />
        <View style={{ height: 8, width: "38%", borderRadius: 4, backgroundColor: C.bg3 }} />
      </View>
    </View>
  );
}
