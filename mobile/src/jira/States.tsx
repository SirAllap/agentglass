/*
 * The five states the Jira half of Tasks can be in, each with the one control
 * it can still offer.
 *
 * A board that draws nothing is a board somebody reads as broken, and the
 * difference between "no card matches", "the computer is unreachable", "Jira is
 * not signed in" and "no board is saved" is the difference between five
 * different actions. The mock draws all five; this is the same list with the
 * same words, and no state is ever drawn empty.
 *
 * ── the shape is the mock's card ─────────────────────────────────────────
 * A small word saying WHICH state this is, the sentence that says what
 * happened, the line that says what it costs, and then the one control. That
 * first word is not decoration: "Cannot reach the computer" and "Jira is not
 * signed in" are both red-ish sentences to a thumb, and the eyebrow is the only
 * thing that tells them apart before reading.
 *
 * No state is a dead end: `loading` still re-reads, `empty` clears what is
 * narrowing it, `offline` retries and offers the cards already on screen,
 * `no-account` sends the person to the screen that explains the computer's
 * connection, and `no-source` switches to the source that always works.
 */
import { Text, View } from "react-native";
import { Glyph, type GlyphName } from "../nav/glyphs.tsx";
import { Btn, Note } from "../ui.tsx";
import { C, RADIUS, SPACE, T } from "../theme.ts";

export type JiraStateKind = "loading" | "empty" | "offline" | "no-account" | "no-source";

export interface JiraStateProps {
  kind: JiraStateKind;
  /** The board or view the state is about, for the sentence. */
  board?: string;
  /** What the empty state can say was narrowed. */
  filters?: boolean;
  /** The last successful read, when the state is offline and there is a copy. */
  at?: number;
  error?: string | null;
  onRetry?: () => void;
  onClear?: () => void;
  onSettings?: () => void;
  onIssues?: () => void;
}

const ICON: Record<JiraStateKind, GlyphName> = {
  loading: "refresh",
  empty: "list",
  offline: "offline",
  "no-account": "lock",
  "no-source": "link",
};

const EYEBROW: Record<JiraStateKind, string> = {
  loading: "Loading",
  empty: "Empty",
  offline: "Offline",
  "no-account": "No account",
  "no-source": "No source",
};

/** A clock in the phone's own day: "09:12", for "showing the copy from". */
function clock(at: number): string {
  const d = new Date(at);
  if (!Number.isFinite(d.getTime()) || at <= 0) return "";
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function JiraState(p: JiraStateProps): React.ReactNode {
  const board = p.board?.trim() || "this board";
  const rows: Record<JiraStateKind, { title: string; line: string }> = {
    loading: {
      title: `Reading ${board}`,
      line: "Every status. The lanes are drawn as soon as the first read lands.",
    },
    empty: {
      title: p.filters ? "No card with these filters" : `${board} has no card here`,
      line: p.filters
        ? "The filters are the only thing narrowing it. Clearing them brings the rest back."
        : "Nothing is wrong: this board has nothing in it right now.",
    },
    offline: {
      title: p.at ? `Showing ${clock(p.at)}, from the computer` : "Cannot reach the computer",
      line: p.error ?? "Cards are here; moving one waits for orbit-mini, because Jira is written through it.",
    },
    "no-account": {
      title: "Jira is not signed in",
      line: "The board cannot be read until the computer signs in. This phone never asks for the password.",
    },
    "no-source": {
      title: `${board === "Jira" ? "This repository" : board} reads no Jira project`,
      line: "Nothing is wrong: this repository is not linked to a board yet. GitHub issues are untouched.",
    },
  };
  const { title, line } = rows[p.kind];
  return (
    <View style={{ paddingHorizontal: SPACE.md, paddingTop: SPACE.md }}>
      <View style={{
        backgroundColor: C.bg2, borderWidth: 1, borderColor: C.border, borderRadius: RADIUS.lg,
        paddingVertical: SPACE.md, paddingHorizontal: SPACE.md, gap: SPACE.sm,
      }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Glyph name={ICON[p.kind]} color={p.kind === "offline" ? C.warning : C.text3} size={14} />
          <Text style={{ color: C.text3, fontSize: T.eyebrow, fontWeight: "700", letterSpacing: 0.6 }}>
            {EYEBROW[p.kind].toUpperCase()}
          </Text>
        </View>
        <Text accessibilityRole="header" style={{ color: C.text, fontSize: 15, fontWeight: "600", lineHeight: 20 }}>{title}</Text>
        <Note tone={p.kind === "offline" ? "bad" : "quiet"}>{line}</Note>
        {p.kind === "loading" ? <Skeleton /> : null}
        <View style={{ gap: SPACE.sm, paddingTop: SPACE.xs }}>
          {p.kind === "loading" && p.onRetry ? <Btn label="Read it again" onPress={p.onRetry} style={{ width: "100%" }} /> : null}
          {p.kind === "empty" && p.filters && p.onClear ? <Btn label="Clear the filters" onPress={p.onClear} style={{ width: "100%" }} /> : null}
          {p.kind === "offline" && p.onRetry ? <Btn label="Retry" onPress={p.onRetry} style={{ width: "100%" }} /> : null}
          {p.kind === "no-account" && p.onSettings ? <Btn label="Show the computer" onPress={p.onSettings} style={{ width: "100%" }} /> : null}
          {p.kind === "no-source" && p.onIssues ? <Btn label="Read GitHub issues" onPress={p.onIssues} style={{ width: "100%" }} /> : null}
        </View>
        {p.kind === "no-account" ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingTop: 2 }}>
            <Glyph name="lock" color={C.text4} size={14} />
            <Text style={{ color: C.text3, fontSize: T.small }}>The sign-in lives in the app on the computer.</Text>
          </View>
        ) : null}
        {p.kind === "offline" && p.at ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingTop: 2 }}>
            <Glyph name="offline" color={C.text4} size={14} />
            <Text style={{ color: C.text3, fontSize: T.small }}>Cannot reach the computer · retry when it is back.</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** Three soft rows, the shape of a lane, so a slow read is visibly a board
 *  being drawn rather than an empty one. */
function Skeleton(): React.ReactNode {
  const widths = ["70%", "88%", "54%"] as const;
  return (
    <View accessibilityElementsHidden style={{ gap: SPACE.sm, paddingVertical: SPACE.xs }}>
      {widths.map((w, i) => (
        <View key={i} style={{ height: i === 0 ? 14 : 10, width: w, borderRadius: 5, backgroundColor: C.bg3 }} />
      ))}
    </View>
  );
}
