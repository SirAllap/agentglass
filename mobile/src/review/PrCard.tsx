/*
 * A pull request as a card: the verdict first, then what it is, then the work
 * it belongs to.
 *
 * On the board the card is the mock's (screen 28): a band with the verdict, a
 * ring with the run's fraction under it, the id line, the title, the card and
 * branch chips, three tiles (Review, Branch, Changes), the last thing that
 * happened, the lane's sentence, and the one press the lane implies. The list
 * keeps the shorter card: a row there is one of a page, not one of two.
 *
 * Every word and choice is decided in model/prCard.ts. This paints them.
 *
 * The whole card is the touch target; the presses inside it (the primary
 * action, the copies, the dots) stop there rather than opening the pull
 * request.
 */
import * as Clipboard from "expo-clipboard";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PrSummary } from "../../../shared/types.ts";
import type { Unread } from "../../../shared/prUnread.ts";
import { ACTION_LABEL, type Filed, type Suggested } from "../../../shared/prLanes.ts";
import { unreadTitle } from "../../../shared/prUnread.ts";
import { Avatar } from "../Avatar.tsx";
import { LabelChip, TAP, toneInk, useFlash, type ChipTone } from "../ui.tsx";
import { Glyph, type GlyphName } from "../nav/glyphs.tsx";
import { ChevronIcon } from "../nav/icons.tsx";
import { since } from "../lib/dates.ts";
import { highlight } from "../model/prSearch.ts";
import {
  bannerLook, branchCell, changesShare, ciCount, ciSegments, eventLine, facesOf,
  reviewCell, threadsLabel, type CardLine, type CardState, type Seg,
} from "../model/prCard.ts";
import type { Tone } from "../model/prLook.ts";
import { C, MONO, RADIUS, SPACE, T, ink, tint } from "../theme.ts";

const BANNER_ICON: Record<Tone, GlyphName> = {
  bad: "alert", good: "check", warn: "clock", accent: "clock", neutral: "draft_circle",
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
          {state.card.people?.length ? (
            <View style={{ flexDirection: "row", gap: 2 }}>
              {state.card.people.slice(0, 3).map((p) => (
                <Avatar key={p.id ?? p.name} name={p.name} avatar={p.avatar} initials={p.initials} color={p.color} size={22} />
              ))}
            </View>
          ) : null}
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

/* ── the board's card ────────────────────────────────────────────────────── */

/** The ring: how much of the run is done, and its fraction under it. */
function Ring({ pr }: { pr: PrSummary }): React.ReactNode {
  const ci = ciCount(pr);
  const ink = ci.tone === "neutral" ? C.text3 : toneInk(ci.tone);
  return (
    <View style={{ width: 48, alignItems: "center", gap: 2 }}>
      <View
        accessibilityLabel={`Checks: ${ci.word}`}
        style={{
          width: 34, height: 34, borderRadius: 17, borderWidth: 2,
          borderColor: tint(ink, 0.9), alignItems: "center", justifyContent: "center",
        }}
      >
        <Glyph name={ci.tone === "bad" ? "alert" : ci.tone === "good" ? "check" : "clock"} color={ink} size={14} weight={2.4} />
      </View>
      <Text style={{ color: ink, fontSize: 10, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{ci.word}</Text>
    </View>
  );
}

function Tile({ label, children }: { label: string; children: React.ReactNode }): React.ReactNode {
  return (
    <View style={{ flex: 1, minWidth: 0, height: 47, paddingHorizontal: 7, paddingVertical: 6, borderRadius: 10, backgroundColor: C.bg3, gap: 2 }}>
      <Text style={{ color: C.text4, fontSize: 9, fontWeight: "700", letterSpacing: 0.4, textTransform: "uppercase" }}>{label}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>{children}</View>
    </View>
  );
}

/** "+N" that opens the rest of the labels when tapped (the desktop's tip, as a tap). */
function MoreLabels({ labels, shown, open, onToggle }: {
  labels: readonly { name: string; color?: string }[]; shown: number; open: boolean; onToggle: () => void;
}): React.ReactNode {
  if (labels.length <= shown) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityLabel={open ? "Hide the other labels" : `Show all ${labels.length} labels`}
      hitSlop={8}
      onPress={(e) => { e.stopPropagation(); onToggle(); }}
    >
      <Text style={{ color: open ? C.text : C.text3, fontSize: 11.5, fontWeight: "600" }}>{open ? "−" : `+${labels.length - shown}`}</Text>
    </Pressable>
  );
}

function RestOfLabels({ labels, shown, open }: { labels: readonly { name: string; color?: string }[]; shown: number; open: boolean }): React.ReactNode {
  if (!open || labels.length <= shown) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, paddingTop: 6, paddingHorizontal: 11 }}>
      {labels.slice(shown).map((l) => <LabelChip key={l.name} name={l.name} color={l.color} />)}
    </View>
  );
}

function DenseCard({ pr, now, forMe, repo, behind, asking, failed, card, query, onOpen, filed, action, onAction, onMenu }: {
  pr: PrSummary;
  now: number;
  forMe: boolean;
  /** The board is one repository wide: its name, for the id line. */
  repo?: string;
  /** Commits the base has that this branch lacks; null while unknown. */
  behind?: number | null;
  /** The compare is still out: the cell says "checking", never "up to date". */
  asking?: boolean;
  /** The compare came back with nothing: no count, and none claimed either. */
  failed?: boolean;
  card?: CardState;
  query?: string;
  onOpen: () => void;
  filed: Filed;
  action: Suggested;
  onAction?: () => void;
  /** The dots: what the card can do without opening it (mock 62). */
  onMenu?: () => void;
}): React.ReactNode {
  const banner = bannerLook(pr, { forMe });
  const ink_ = banner.tone === "neutral" ? C.text3 : toneInk(banner.tone as ChipTone);
  const review = reviewCell(pr, forMe);
  const branch = branchCell(pr, behind ?? null, asking, failed);
  const ci = ciCount(pr);
  const ev = eventLine(pr, now);
  const faces = facesOf(pr, 2);
  const threads = pr.openThreads?.open ?? 0;
  const shown = pr.labels.slice(0, 1);
  const [allLabels, setAllLabels] = useState(false);
  const share = changesShare(pr);
  /* What the card line draws: a reading this session re-asked when the row's
     copy had gone stale (see state/pr-cards.ts), else the row's own. */
  const linked = card?.kind === "card" ? card.card : pr.card;
  const [copied, flash] = useFlash();
  const copy = (what: string, value: string): void => { void Clipboard.setStringAsync(value); flash(); };
  return (
    <Pressable
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={`#${pr.number} ${pr.title}. ${banner.label}${banner.right ? `, ${banner.right}` : ""}. ${filed.reason}`}
      style={({ pressed }) => ({
        backgroundColor: pressed ? C.bg3 : C.bg2, borderWidth: 1, borderColor: C.border,
        borderRadius: RADIUS.lg, overflow: "hidden",
      })}
    >
      <View style={{
        flexDirection: "row", alignItems: "center", gap: 9, paddingVertical: 7, paddingLeft: 11, paddingRight: 10,
        backgroundColor: banner.tone === "neutral" ? C.bg3 : tint(ink_, 0.14),
      }}>
        <Glyph name={BANNER_ICON[banner.tone]} color={ink_} size={14} weight={2.4} />
        <Text numberOfLines={1} style={{ color: ink_, fontSize: 11.5, fontWeight: "600", flexShrink: 1 }}>
          {banner.label}{banner.right ? ` · ${banner.right}` : ""}
        </Text>
        <View style={{ flex: 1 }} />
        {faces.length ? <View style={{ flexDirection: "row", gap: 2 }}>{faces.slice(0, 1).map((f) => <Avatar key={f} name={f} login={f} size={19} />)}</View> : null}
      </View>

      <View style={{ flexDirection: "row", gap: 9, paddingTop: 10, paddingHorizontal: 11 }}>
        <Ring pr={pr} />
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 5 }}>
            <Text style={{ color: C.text2, fontSize: 11.5, fontWeight: "600", fontVariant: ["tabular-nums"] }}>#{pr.number}</Text>
            {/* The mock's id line names the repository (28): a board is one
                repository wide, and the line still says which. */}
            {repo ? (
              <Text numberOfLines={1} style={{ color: C.text3, fontSize: 11, flexShrink: 1 }}>{repo}</Text>
            ) : null}
            <View style={{ flex: 1 }} />
            <Glyph name="commit" color={C.text4} size={11} weight={2} />
            <Text style={{ color: C.text4, fontSize: 10.5 }}>pushed {since(pr.updatedAt, now)}</Text>
          </View>
          <Text numberOfLines={2} style={{ color: C.text, fontSize: 14.5, fontWeight: "600", lineHeight: 19, letterSpacing: -0.2 }}>
            {(query ? highlight(pr.title, query) : [{ text: pr.title, hit: false }]).map((piece, i) => (
              piece.hit
                ? <Text key={i} style={{ backgroundColor: tint(C.warning, 0.35) }}>{piece.text}</Text>
                : piece.text
            ))}
          </Text>
        </View>
      </View>

      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingTop: 8, paddingHorizontal: 11 }}>
        {linked ? (
          <View style={{ height: 22, paddingHorizontal: 7, borderRadius: 7, backgroundColor: C.bg3, flexDirection: "row", alignItems: "center", gap: 5, flexShrink: 1 }}>
            <Glyph name="tag" color={C.text4} size={12} weight={2} />
            <Text numberOfLines={1} style={{ color: C.text2, fontSize: 11.5, fontWeight: "600", flexShrink: 1 }}>
              {linked.customId || linked.id}
            </Text>
          </View>
        ) : null}
        {linked?.status ? (
          <View style={{ height: 22, paddingHorizontal: 7, borderRadius: 7, backgroundColor: C.bg3, flexShrink: 1 }}>
            <Text numberOfLines={1} style={{ color: C.text2, fontSize: 11.5, fontWeight: "600" }}>{linked.status}</Text>
          </View>
        ) : pr.labels.length ? (
          <View style={{ height: 22, paddingHorizontal: 7, borderRadius: 7, backgroundColor: C.bg3, flexShrink: 1 }}>
            <Text numberOfLines={1} style={{ color: C.text2, fontSize: 11.5, fontWeight: "600" }}>{pr.labels[0]?.name ?? ""}</Text>
          </View>
        ) : null}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5, height: 22, paddingLeft: 2, paddingRight: 8, borderRadius: 11, backgroundColor: C.bg3, flexShrink: 1 }}>
          <Avatar name={pr.author} login={pr.author} size={18} />
          <Text numberOfLines={1} style={{ color: C.text2, fontSize: 11.5, fontWeight: "600", flexShrink: 1 }}>{pr.author}</Text>
        </View>
        <View style={{ flex: 1 }} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copied ? "Copied" : `Copy #${pr.number}`}
          hitSlop={4}
          onPress={(e) => { e.stopPropagation(); copy("the number", `#${pr.number}`); }}
          style={{ width: 26, height: 26, borderRadius: 8, alignItems: "center", justifyContent: "center" }}
        >
          <Glyph name={copied ? "check" : "copy"} color={copied ? C.success : C.text4} size={14} weight={2} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copied ? "Copied" : `Copy the branch name ${pr.headRefName}`}
          hitSlop={4}
          onPress={(e) => { e.stopPropagation(); copy("the branch name", pr.headRefName); }}
          style={{ width: 26, height: 26, borderRadius: 8, alignItems: "center", justifyContent: "center" }}
        >
          <Glyph name="branch" color={C.text4} size={14} weight={2} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Copy the link to #${pr.number}`}
          hitSlop={4}
          onPress={(e) => { e.stopPropagation(); copy("the link", pr.url); }}
          style={{ width: 26, height: 26, borderRadius: 8, alignItems: "center", justifyContent: "center" }}
        >
          <Glyph name="link" color={C.text4} size={14} weight={2} />
        </Pressable>
      </View>

      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingTop: 6, paddingHorizontal: 11 }}>
        <View style={{ flexDirection: "row", alignItems: "center", height: 22, borderRadius: 7, backgroundColor: C.bg3, flexShrink: 1 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 6, height: 22 }}>
            <Glyph name="branch" color={C.text4} size={12} weight={2} />
            <Text numberOfLines={1} style={{ color: C.text2, fontSize: 11, fontWeight: "600", fontFamily: MONO, flexShrink: 1 }}>
              {pr.headRefName}
            </Text>
          </View>
          <ChevronIcon color={C.text4} size={12} />
          <Text numberOfLines={1} style={{ color: C.text3, fontSize: 11, fontWeight: "600", fontFamily: MONO, paddingHorizontal: 2 }}>
            {pr.baseRefName}
          </Text>
        </View>
        {threads ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4, height: 22, paddingHorizontal: 7, borderRadius: 7, backgroundColor: C.bg3 }}>
            <Glyph name="comment" color={C.text4} size={12} weight={2} />
            <Text style={{ color: C.text2, fontSize: 11.5, fontWeight: "600" }}>{threads}{pr.openThreads?.more ? "+" : ""}</Text>
          </View>
        ) : null}
      </View>

      <View style={{ flexDirection: "row", gap: 6, paddingTop: 9, paddingHorizontal: 11 }}>
        <Tile label="Review">
          {faces.slice(0, 1).map((f) => <Avatar key={f} name={f} login={f} size={17} />)}
          <Text numberOfLines={1} style={{ color: review.tone === "neutral" ? C.text3 : toneInk(review.tone), fontSize: 12, fontWeight: "600", flexShrink: 1 }}>
            {review.word}
          </Text>
        </Tile>
        <Tile label="Branch">
          <Text numberOfLines={1} style={{ color: branch.tone === "neutral" ? C.text3 : toneInk(branch.tone), fontSize: 12, fontWeight: "600", flexShrink: 1 }}>
            {branch.word}
          </Text>
        </Tile>
        <Tile label="Changes">
          <View style={{ flex: 1, gap: 4 }}>
            <Text numberOfLines={1} style={{ fontSize: 12, fontWeight: "600", fontVariant: ["tabular-nums"] }}>
              <Text style={{ color: C.success }}>+{pr.additions}</Text>
              <Text style={{ color: C.error }}> −{pr.deletions}</Text>
            </Text>
            {/* The mock's size bar: green share of the diff, red the rest. */}
            <View style={{ flexDirection: "row", height: 3, borderRadius: 2, overflow: "hidden", backgroundColor: C.error }}>
              <View style={{ width: `${Math.round(share * 100)}%`, backgroundColor: C.success }} />
            </View>
          </View>
        </Tile>
      </View>

      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingTop: 8, paddingHorizontal: 11 }}>
        <Text numberOfLines={1} style={{ color: C.text2, fontSize: 11.5, flexShrink: 1 }}>
          <Text style={{ color: C.text3 }}>↳ </Text>{ev.what}
        </Text>
        <Text style={{ color: C.text4, fontSize: 11.5 }}>· {ev.when}</Text>
        <View style={{ flex: 1 }} />
        {shown.map((l) => <LabelChip key={l.name} name={l.name} color={l.color} />)}
        <MoreLabels labels={pr.labels} shown={shown.length} open={allLabels} onToggle={() => setAllLabels((v) => !v)} />
      </View>
      <RestOfLabels labels={pr.labels} shown={shown.length} open={allLabels} />

      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8, paddingTop: 7, paddingHorizontal: 11 }}>
        <Text style={{ color: C.text4, fontSize: 9, fontWeight: "700", letterSpacing: 0.4, textTransform: "uppercase" }}>Why</Text>
        <Text numberOfLines={2} style={{ color: C.text2, fontSize: 11.5, lineHeight: 15, flex: 1 }}>{filed.reason}</Text>
      </View>

      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 10, paddingHorizontal: 11 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${ACTION_LABEL[action]} #${pr.number}. Opens the pull request.`}
          onPress={(e) => { e.stopPropagation(); (onAction ?? onOpen)(); }}
          style={({ pressed }) => ({
            minHeight: TAP, minWidth: 110, paddingHorizontal: 14, borderRadius: 12,
            alignItems: "center", justifyContent: "center",
            backgroundColor: pressed ? tint(C.primary, 0.82) : C.primary,
          })}
        >
          <Text style={{ color: ink(C.primary), fontSize: 13, fontWeight: "600" }}>{ACTION_LABEL[action]}</Text>
        </Pressable>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5, flex: 1 }}>
          <Glyph
            name={branch.tone === "good" ? "check" : branch.tone === "bad" ? "alert" : "history"}
            color={branch.tone === "neutral" ? C.text3 : toneInk(branch.tone)}
            size={12} weight={2.4}
          />
          <Text style={{ color: branch.tone === "neutral" ? C.text3 : toneInk(branch.tone), fontSize: 11, fontWeight: "600" }}>
            {branch.word === "up to date" ? "Up to date" : branch.word}
          </Text>
        </View>
        <IconSquare label={`More on #${pr.number}: re-run, sync, labels`} onPress={onMenu ?? onOpen} />
        <IconSquare label={`Copy the link to #${pr.number}`} onPress={() => copy("the link", pr.url)} />
      </View>
    </Pressable>
  );
}

/** A 44-point square in the card's footer, which is where the mock puts the
 *  secondary actions. It opens the pull request rather than a menu of its own:
 *  the screen behind it is the menu. */
function IconSquare({ label, onPress }: { label: string; onPress: () => void }): React.ReactNode {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={(e) => { e.stopPropagation(); onPress(); }}
      style={({ pressed }) => ({
        width: 44, height: 44, borderRadius: 12, alignItems: "center", justifyContent: "center",
        backgroundColor: pressed ? C.bg3 : "transparent",
      })}
    >
      <Glyph name={label.startsWith("More") ? "more" : "link"} color={C.text2} size={18} weight={2} />
    </Pressable>
  );
}

export function PrCard({ pr, now, forMe, unread, repo, behind, asking, failed, card, query, onFind, onOpen, filed, action, onAction, onMenu }: {
  pr: PrSummary;
  now: number;
  forMe: boolean;
  /** The board's repository, for the board card's id line. */
  repo?: string;
  unread: Unread | null;
  /** The board card's compare: commits the base has that this branch lacks. */
  behind?: number | null;
  /** That compare is out: the branch word says "checking". */
  asking?: boolean;
  /** That compare failed: no count, and "up to date" is not claimed either. */
  failed?: boolean;
  card?: CardState;
  /** What the search box says: its words are marked in the title. */
  query?: string;
  onFind?: () => void;
  onOpen: () => void;
  /** The board's density: the lane's sentence, and the press that lane implies. */
  filed?: Filed;
  action?: Suggested;
  onAction?: () => void;
  /** The board card's dots: what it can do without being opened. */
  onMenu?: () => void;
}): React.ReactNode {
  if (filed && action) {
    return (
      <DenseCard
        pr={pr} now={now} forMe={forMe} repo={repo} behind={behind} asking={asking} failed={failed} card={card} query={query}
        onOpen={onOpen} filed={filed} action={action} onAction={onAction} onMenu={onMenu}
      />
    );
  }
  const banner = bannerLook(pr, { forMe, unread: unread?.count });
  const gone = pr.state === "OPEN" ? null : pr.state === "MERGED" ? "Merged" : "Closed";
  const ink_ = toneInk(banner.tone);
  const threads = threadsLabel(pr);
  // In the banner already when it is what the banner's right edge says.
  const threadsBelow = threads && banner.right !== threads ? threads : null;
  const shown = pr.labels.slice(0, LABELS_SHOWN);
  const [allLabels, setAllLabels] = useState(false);
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
        <Glyph name={bannerIcon(banner.tone)} color={ink_} size={16} weight={2} />
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
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Glyph name="branch" color={C.text4} size={13} weight={2} />
          <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.eyebrow, fontFamily: MONO, flexShrink: 1 }}>
            {pr.headRefName} → {pr.baseRefName}
          </Text>
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 8, rowGap: 6 }}>
          <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.small }}>
            {gone ? `${gone} · ` : ""}{pr.author} · {since(pr.updatedAt, now)}
          </Text>
          {shown.map((l) => <LabelChip key={l.name} name={l.name} color={l.color} />)}
          <MoreLabels labels={pr.labels} shown={shown.length} open={allLabels} onToggle={() => setAllLabels((v) => !v)} />
          {threadsBelow ? <Text style={{ color: C.warning, fontSize: T.small, fontWeight: "600" }}>{threadsBelow}</Text> : null}
          <View style={{ flex: 1 }} />
          <Text style={{ fontSize: T.small, fontFamily: MONO }}>
            <Text style={{ color: C.success }}>+{pr.additions}</Text>
            <Text style={{ color: C.error }}> −{pr.deletions}</Text>
          </Text>
        </View>
        <RestOfLabels labels={pr.labels} shown={shown.length} open={allLabels} />
        {card && onFind ? <CardLineRow state={card} onFind={onFind} /> : null}
      </View>
    </Pressable>
  );
}

function bannerIcon(tone: Tone): GlyphName {
  return tone === "bad" ? "x_circle" : tone === "good" ? "ok_circle" : tone === "warn" || tone === "accent" ? "clock" : "draft_circle";
}
