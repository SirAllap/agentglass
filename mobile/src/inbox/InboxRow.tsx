/*
 * One thing waiting on you, as a row.
 *
 * Three shapes, because the three kinds of waiting are not the same errand and
 * the mock draws them apart: a DECISION is a card with the answer on it (a plan
 * waiting for Go, a settings request), a WATCH is a notification-shaped row
 * ("this happened"), and a REVIEW or a stopped agent is a list row that opens
 * somewhere else.
 *
 * What a row CAN do is decided by the pairing, not by the row: a gate opens the
 * terminal where the hold lives, a review opens the pull request, and the two
 * decisions that are one press (a settings request, a flight plan) draw their
 * own controls here. A phone that may not act on one still sees it, with the
 * reason in one line, rather than a button that posts into a 403.
 *
 * The controls follow model/confirmPolicy.ts: answering a settings request the
 * server validated is a TAP; Go spends a worker and HOLDS.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import type { Host } from "../lib/host.ts";
import { ask } from "../lib/api.ts";
import { WHY_NOT, sourceWord, type InboxItem, type PlanWaiting } from "../model/inbox.ts";
import type { WatchPr } from "./WatchRuleSheet.tsx";
import { PlanCard } from "./PlanCard.tsx";
import { Btn, Chip, TAP, toneInk, type ChipTone } from "../ui.tsx";
import { C, RADIUS, SPACE, T, tint } from "../theme.ts";
import { Glyph, type GlyphName } from "../nav/glyphs.tsx";
import { ChevronIcon } from "../nav/icons.tsx";
import { rowRoom } from "../uiPrefs.ts";
import { answerGone } from "../model/inboxStale.ts";

/** The chip beside the sentence: the source's word, in the level's colour. */
const TONE: Record<InboxItem["level"], ChipTone> = { blocking: "bad", error: "warn", warn: "accent" };

/** "Tell me when…" — the door into the watch sheet, from a row that names a
 *  pull request. Small, because it is the second thing a row offers. */
function WatchLink({ onPress }: { onPress: () => void }): React.ReactNode {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Tell me when this pull request changes"
      onPress={onPress}
      hitSlop={8}
      style={{ minHeight: TAP, justifyContent: "center" }}
    >
      <Text style={{ color: C.primary, fontSize: T.small, fontWeight: "600" }}>Tell me when…</Text>
    </Pressable>
  );
}

/** A row's leading mark: a 34-point tile, the same on every list in the app. */
function Lead({ name, tone }: { name: GlyphName; tone?: "accent" | "good" | "bad" }): React.ReactNode {
  const ink = tone === "good" ? C.success : tone === "bad" ? C.error : C.primary;
  return (
    <View style={{
      width: 34, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center",
      backgroundColor: tone ? tint(ink, 0.14) : C.bg3,
    }}>
      <Glyph name={name} color={tone ? ink : C.text2} size={18} />
    </View>
  );
}

/** A list row: the mark, the sentence, and the way on. */
function RowShell({ children, onPress, label }: {
  children: React.ReactNode;
  onPress?: () => void;
  label?: string;
}): React.ReactNode {
  const body = (pressed: boolean): React.ReactNode => (
    <View style={{
      flexDirection: "row", alignItems: "center", gap: SPACE.md,
      minHeight: 58 + rowRoom(), paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm,
      borderRadius: RADIUS.lg, borderWidth: 1, borderColor: C.border,
      backgroundColor: pressed ? C.bg3 : C.bg2,
    }}>{children}</View>
  );
  if (!onPress) return body(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
    >
      {({ pressed }) => body(pressed)}
    </Pressable>
  );
}

/** What the list draws while the first read is out: the shape of the rows that
 *  are coming, so the screen does not say "nothing" about a list it has not
 *  heard. */
export function Skeleton(): React.ReactNode {
  return (
    <View style={{
      flexDirection: "row", alignItems: "center", gap: SPACE.md, padding: SPACE.md,
      borderRadius: RADIUS.lg, borderWidth: 1, borderColor: C.border, backgroundColor: C.bg2,
    }}>
      <View style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: C.bg3 }} />
      <View style={{ flex: 1, gap: 8 }}>
        <View style={{ height: 11, width: "60%", borderRadius: 6, backgroundColor: C.bg3 }} />
        <View style={{ height: 10, width: "35%", borderRadius: 6, backgroundColor: C.bg3 }} />
      </View>
    </View>
  );
}

export function InboxRow({ item, host, plan, onAnswered, onAck, onWatch }: {
  item: InboxItem;
  host: Host;
  /** The plan behind a `plan` row: its launch line and size come from the read
   *  that produced the row, not from a second request. */
  plan?: PlanWaiting;
  onAnswered: () => void;
  onAck: (seq: number) => void;
  onWatch: (pr: WatchPr) => void;
}): React.ReactNode {
  const router = useRouter();
  const [busy, setBusy] = useState<"yes" | "no" | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  /* Arming a watch is a POST. A phone that may only look sees the row and is
     told why, rather than a link that posts into a 403. */
  const mayWrite = host.scope === "full";

  const openPr = (number: number, root?: string): void => {
    router.push({
      pathname: "/pr/[number]",
      params: { number: String(number), ...(root ? { root } : {}) },
    });
  };

  const open = (): void => {
    if (item.action.kind === "gate" || item.action.kind === "agent") { router.push("/terminal"); return; }
    if (item.action.kind === "review") { openPr(item.action.number, item.action.root); return; }
    if (item.action.kind === "watch") {
      // Ack first: the row is about to leave, and a fire acknowledged after the
      // navigation is a write somebody may never come back to.
      onAck(item.action.seq);
      openPr(item.action.number, item.action.root);
    }
  };

  const watchPr = (): WatchPr | null => {
    if (item.action.kind === "review") {
      return { root: item.action.root, repo: item.action.repo, number: item.action.number, title: item.text };
    }
    if (item.action.kind === "watch") {
      return {
        root: item.action.root ?? "",
        repo: item.action.repo,
        number: item.action.number,
        title: item.text,
      };
    }
    return null;
  };

  const decide = async (approve: boolean): Promise<void> => {
    if (item.action.kind !== "settings") return;
    setBusy(approve ? "yes" : "no");
    setSaid(null);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const answer = await ask<{ ok: boolean; error?: string }>(host, "/settings/requests/decide", {
      method: "POST",
      body: { id: item.action.id, approve },
    });
    setBusy(null);
    // Answered at the desk, or expired: the card leaves instead of staying with an error.
    if (answerGone("settings", answer)) { onAnswered(); return; }
    if (!answer.ok) { setSaid(answer.error); return; }
    if (!answer.value.ok) { setSaid(answer.value.error || "That request is no longer waiting."); return; }
    onAnswered();
  };

  if (item.action.kind === "plan") {
    return <PlanCard item={item} plan={plan} host={host} onAnswered={onAnswered} />;
  }

  const pr = watchPr();

  // ── a settings request: the answer is on the card ───────────────────────
  if (item.action.kind === "settings") {
    return (
      <View
        accessibilityLabel={`Settings request: ${item.text}`}
        style={{
          padding: 14, gap: SPACE.sm, borderRadius: RADIUS.lg,
          borderWidth: 1, borderColor: C.border, backgroundColor: C.bg2,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
          <Chip label="Settings request" tone="warn" />
          <Text numberOfLines={1} style={{ flex: 1, textAlign: "right", color: C.text3, fontSize: T.small }}>
            {item.detail}
          </Text>
        </View>
        <Text numberOfLines={3} style={{ color: C.text, fontSize: 16, fontWeight: "600", lineHeight: 21 }}>
          {item.text}
        </Text>
        <Text style={{ color: C.text3, fontSize: T.small, lineHeight: 18 }}>
          An agent asked to change a setting. It never leaves this phone unanswered.
        </Text>
        {item.canAct ? (
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: SPACE.sm, paddingTop: SPACE.xs }}>
            <Btn label="Decline" onPress={() => { void decide(false); }} busy={busy === "no"} disabled={busy !== null} />
            <Btn label="Approve" tone="primary" onPress={() => { void decide(true); }} busy={busy === "yes"} disabled={busy !== null} />
          </View>
        ) : (
          <Text style={{ color: C.text3, fontSize: T.small }}>{WHY_NOT.settings}</Text>
        )}
        {said ? (
          <Text accessibilityLiveRegion="polite" style={{ color: toneInk("bad"), fontSize: T.small }}>{said}</Text>
        ) : null}
      </View>
    );
  }

  // ── a held command: the card names it, and the terminal holds the answer ──
  if (item.action.kind === "gate") {
    return (
      <RowShell onPress={open} label={`Gate: ${item.text}`}>
        <Lead name="shield" tone="bad" />
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <Text numberOfLines={2} style={{ color: C.text, fontSize: 14.5, fontWeight: "600", lineHeight: 19 }}>
            {item.text}
          </Text>
          <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.small }}>{item.detail}</Text>
        </View>
        <Chip label="Gate" tone="bad" />
        <ChevronIcon color={C.text3} size={18} />
      </RowShell>
    );
  }

  // ── a watch that fired: a notification, not a second inbox ──────────────
  if (item.action.kind === "watch") {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${sourceWord(item.source)}: ${item.text}`}
        onPress={open}
        style={({ pressed }) => ({
          flexDirection: "row", gap: SPACE.md, padding: 12,
          borderRadius: RADIUS.lg, borderWidth: 1, borderColor: C.border2,
          backgroundColor: pressed ? C.bg3 : C.bg2,
        })}
      >
        <View style={{
          width: 32, height: 32, borderRadius: 10, alignItems: "center", justifyContent: "center",
          backgroundColor: tint(item.level === "error" ? C.error : C.success, 0.14),
        }}>
          <Glyph
            name={item.level === "error" ? "alert" : "check"}
            color={item.level === "error" ? C.error : C.success}
            size={17}
          />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <Text numberOfLines={2} style={{ color: C.text, fontSize: 14, fontWeight: "600", lineHeight: 19 }}>
            {item.text}
          </Text>
          <Text numberOfLines={2} style={{ color: C.text3, fontSize: T.small, lineHeight: 17 }}>{item.detail}</Text>
          {pr && pr.repo && !mayWrite ? (
            <Text numberOfLines={2} style={{ color: C.text3, fontSize: T.small, lineHeight: 17 }}>{WHY_NOT.watch}</Text>
          ) : null}
        </View>
        {pr && pr.repo ? <WatchLink onPress={() => onWatch(pr)} /> : null}
      </Pressable>
    );
  }

  // ── a review asked, or an agent that stopped: a row that opens it ───────
  const agent = item.action.kind === "agent";
  return (
    <RowShell onPress={open} label={`${sourceWord(item.source)}: ${item.text}`}>
      <Lead
        name={agent ? "check" : "pr"}
        tone={agent ? "good" : "accent"}
      />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text numberOfLines={2} style={{ color: C.text, fontSize: 14.5, fontWeight: "600", lineHeight: 19 }}>
          {item.text}
        </Text>
        <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.small }}>{item.detail}</Text>
        {pr && pr.repo && !mayWrite ? (
          <Text numberOfLines={2} style={{ color: C.text3, fontSize: T.small, lineHeight: 17 }}>{WHY_NOT.watch}</Text>
        ) : null}
      </View>
      {pr && pr.repo ? <WatchLink onPress={() => onWatch(pr)} /> : null}
      <Chip label={sourceWord(item.source)} tone={TONE[item.level]} />
      <ChevronIcon color={C.text3} size={18} />
    </RowShell>
  );
}
