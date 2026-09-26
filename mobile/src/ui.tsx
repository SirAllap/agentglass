/*
 * The handful of pieces every screen is built from.
 *
 * Small on purpose. A design system for six screens is six screens of
 * indirection, and the thing that actually keeps a phone app coherent is that
 * the type scale and the spacing come from one file — which they do, from
 * theme.ts. This is the rest: a button that cannot be tapped twice, a field
 * that does not autocorrect an IP address into a word, and a row that reports
 * its own touch target.
 */
import { forwardRef, type ReactNode } from "react";
import {
  ActivityIndicator, Modal, Pressable, ScrollView, Text, TextInput, View,
  type StyleProp, type TextStyle, type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { C, MONO, RADIUS, SCRIM, SPACE, T, ink, tint } from "./theme.ts";
import { ChevronIcon } from "./nav/icons.tsx";
import { Glyph } from "./nav/glyphs.tsx";

/**
 * The floor for anything you tap.
 *
 * 44 is the number both platforms' guidelines land on, and it is not a
 * suggestion on a card that says "Deny": the cost of a mis-tap here is an
 * agent stopped or a command allowed that should not have been.
 */
export const TAP = 44;

export function Btn({ label, onPress, tone = "plain", busy, disabled, style }: {
  label: string;
  onPress: () => void;
  tone?: "primary" | "danger" | "good" | "plain";
  busy?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}): ReactNode {
  const face = tone === "primary" ? C.primary : tone === "danger" ? C.error : tone === "good" ? C.success : C.bg3;
  // Measured against the face rather than assumed dark: the face is the accent
  // now, and on a light screen with no accent it is #1f2328 — near-black text
  // on near-black. See inkOn in shared/palettes.ts.
  const faceInk = tone === "plain" ? C.text : ink(face);
  const off = !!disabled || !!busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: off, busy: !!busy }}
      disabled={off}
      onPress={onPress}
      style={({ pressed }) => [
        {
          minHeight: TAP,
          paddingHorizontal: SPACE.lg,
          borderRadius: RADIUS.md,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: face,
          borderWidth: tone === "plain" ? 1 : 0,
          borderColor: C.border,
          // A press is the face moving under the thumb, not fading: 0.97, the
          // same everywhere a thing can be pressed.
          opacity: off ? 0.45 : 1,
          transform: [{ scale: pressed && !off ? 0.97 : 1 }],
        },
        style,
      ]}
    >
      {busy
        ? <ActivityIndicator color={faceInk} />
        : <Text style={{ color: faceInk, fontSize: T.body, fontWeight: "600" }}>{label}</Text>}
    </Pressable>
  );
}

export const Field = forwardRef<TextInput, {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  label?: string;
  /** `code` turns off every helpful thing a keyboard does: an address and a
   *  six-digit code are the two values autocorrect is guaranteed to ruin. */
  kind?: "text" | "code" | "digits";
  onSubmitEditing?: () => void;
  style?: StyleProp<TextStyle>;
}>(function Field(props, ref) {
  const { value, onChangeText, placeholder, label, kind = "text", onSubmitEditing, style } = props;
  return (
    <View style={{ gap: SPACE.xs }}>
      {label ? <Label text={label} /> : null}
      <TextInput
        ref={ref}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={C.text4}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        keyboardType={kind === "digits" ? "number-pad" : kind === "code" ? "url" : "default"}
        inputMode={kind === "digits" ? "numeric" : undefined}
        onSubmitEditing={onSubmitEditing}
        returnKeyType={onSubmitEditing ? "go" : "done"}
        style={[{
          minHeight: TAP,
          borderWidth: 1,
          borderColor: C.border,
          borderRadius: RADIUS.md,
          backgroundColor: C.bg2,
          color: C.text,
          paddingHorizontal: SPACE.md,
          fontSize: T.body,
        }, style]}
      />
    </View>
  );
});

/**
 * The name of a block, in sentence case.
 *
 * It was 11-point uppercase with letter-spacing — a desk convention, and on a
 * phone the least legible line on the screen, on the line that says what the
 * block below is. Now it is the group title's type: 13 points, the second ink,
 * weight 600, written as the words are written.
 */
export function Label({ text }: { text: string }): ReactNode {
  return (
    <Text accessibilityRole="header" style={{ color: C.text2, fontSize: 13, fontWeight: "600" }}>{text}</Text>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }): ReactNode {
  return (
    <View style={[{
      backgroundColor: C.bg2,
      borderWidth: 1,
      borderColor: C.border,
      borderRadius: RADIUS.lg,
      padding: SPACE.lg,
      gap: SPACE.md,
    }, style]}>{children}</View>
  );
}

/** A line of explanation under a control. Never the only place something
 *  important is said — it is the smallest type on the screen. */
export function Note({ children, tone = "quiet" }: {
  children: ReactNode;
  tone?: "quiet" | "bad";
}): ReactNode {
  return (
    <Text style={{ color: tone === "bad" ? C.error : C.text3, fontSize: T.small, lineHeight: 18 }}>
      {children}
    </Text>
  );
}

/**
 * A titled block: the label above the card, not inside it.
 *
 * Settings used to put its heading on the first line INSIDE each card, which
 * makes the title one of the card's contents — the same weight as the switch
 * under it, competing with it for the eye. Outside, in small caps and in the
 * quiet colour, it stops being content and becomes what it is: the name of the
 * group below.
 *
 * `note` is the half that makes a settings screen readable rather than merely
 * tidy. It sits BETWEEN the label and the card, so the explanation is read on
 * the way to the control rather than found underneath it after a wrong guess.
 * The good ones say what the setting is for and what happens when it is off;
 * this component has no opinion about that beyond giving it somewhere to live.
 */
export function Section({ label, note, children, style }: {
  label: string;
  note?: ReactNode;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}): ReactNode {
  return (
    <View style={{ gap: SPACE.sm }}>
      <Label text={label} />
      {note ? <Note>{note}</Note> : null}
      <Card style={style}>{children}</Card>
    </View>
  );
}

/**
 * The border a row wears inside a grouped list.
 *
 * A list is ONE card with its rows divided, not a stack of cards with gaps
 * between them. Both draw the same rows; the difference is what the eye counts.
 * Separate cards make eight pull requests eight objects, each with its own
 * border and its own halo of space, and the heading above them is a label for a
 * pile. One card makes them eight lines of one thing — which is what they are —
 * and the gap between groups then means "a new group starts here" rather than
 * "here is another item".
 *
 * A function rather than a component because the four screens that need it wrap
 * different things: the Inbox has headings folded into its data and the three
 * lists do not, so what varies is how `first` and `last` are worked out, and
 * that is the caller's business. What must NOT vary is the shape, which is why
 * it is here rather than four times over.
 *
 * The hairline lives on the BOTTOM of every row including the last, and the top
 * only on the first. Drawing both would double every divider to two pixels on
 * every seam but the ends — visible, and the kind of wrong that reads as a
 * rendering fault rather than a decision.
 */
export function groupEdge(first: boolean, last: boolean): ViewStyle {
  return {
    backgroundColor: C.bg2,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: C.border,
    borderTopWidth: first ? 1 : 0,
    borderBottomWidth: 1,
    borderTopLeftRadius: first ? RADIUS.lg : 0,
    borderTopRightRadius: first ? RADIUS.lg : 0,
    borderBottomLeftRadius: last ? RADIUS.lg : 0,
    borderBottomRightRadius: last ? RADIUS.lg : 0,
  };
}

/**
 * A thing that is on or off, with the consequence of each written under it.
 *
 * Not a platform Switch. Three of the four of these decide something with no
 * undo — a branch deleted, a merge armed to land while nobody is watching —
 * and a control whose whole state is a small sliding dot puts the weight of
 * that on a glance. This is a 44-point row with a box, a label and a line
 * saying what happens, and the line is where the argument actually is: a
 * repository that already deletes its own branches should be told that,
 * because "Delete the branch after" reads as necessary otherwise.
 *
 * Disabled is drawn rather than hidden, for the same reason: "this repository
 * does not allow auto-merge" is a fact about the repository worth knowing, and
 * a row that vanished would leave somebody looking for it.
 */
export function Toggle({ on, label, sub, disabled, onPress }: {
  on: boolean;
  label: string;
  sub?: string;
  disabled?: boolean;
  onPress: () => void;
}): ReactNode {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: on, disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row", alignItems: "center", gap: SPACE.md,
        minHeight: TAP, opacity: disabled ? 0.45 : pressed ? 0.7 : 1,
      })}
    >
      <View style={{
        width: 20, height: 20, borderRadius: 5,
        alignItems: "center", justifyContent: "center",
        borderWidth: 1, borderColor: on ? C.primary : C.border2,
        backgroundColor: on ? C.primary : "transparent",
      }}>
        {/* A tick drawn as two rules rather than a glyph: the same reason
            src/nav/icons.tsx exists at all — Android's font has no dependable
            check mark and the fallback chain runs out at an empty box. */}
        {on ? (
          <View style={{
            width: 9, height: 5, borderLeftWidth: 2, borderBottomWidth: 2,
            borderColor: ink(C.primary), transform: [{ rotate: "-45deg" }], marginTop: -2,
          }} />
        ) : null}
      </View>
      <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
        <Text style={{ color: C.text, fontSize: T.body }}>{label}</Text>
        {sub ? <Text style={{ color: C.text3, fontSize: T.small }}>{sub}</Text> : null}
      </View>
    </Pressable>
  );
}

/**
 * One switch between a few views of the same list.
 *
 * There were three of these, none of them the same. The pull requests drew
 * their filters at 36 points, the chat list drew its scopes at 36, and Review's
 * own control drew two halves at 34 with a comment apologising for it. A thumb
 * moving between screens met three weights of the identical gesture.
 *
 * So: one, at the app's own floor. `TAP` is 44 and the row is 44 plus the
 * track's 3 points of padding either side, which is what makes the touchable
 * part of each segment actually 44 rather than 44 minus the chrome.
 *
 * Full width and equal segments, not a scrolling row of chips. Two things
 * follow from that and both are the point: every option is on screen, so there
 * is nothing to discover by dragging, and the control cannot grow — which is
 * the constraint that keeps somebody from adding a seventh filter.
 *
 * `count` is drawn beside the word rather than under it. A number that only
 * appears on the selected segment is a number you have to tap to read, and the
 * whole reason these carry counts is to choose without tapping.
 */
export function Segmented<T extends string>({ options, value, onChange, style }: {
  options: { id: T; label: string; count?: number }[];
  value: T;
  onChange: (id: T) => void;
  style?: StyleProp<ViewStyle>;
}): ReactNode {
  return (
    <View
      role="tablist"
      style={[{
        flexDirection: "row",
        backgroundColor: C.bg3,
        borderRadius: RADIUS.md,
        padding: 3,
        gap: 3,
      }, style]}
    >
      {options.map((option) => {
        const on = option.id === value;
        return (
          <Pressable
            key={option.id}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={
              option.count === undefined ? option.label : `${option.label}, ${option.count}`
            }
            onPress={() => onChange(option.id)}
            style={({ pressed }) => ({
              flex: 1,
              minHeight: TAP,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: SPACE.xs,
              borderRadius: RADIUS.sm,
              backgroundColor: on ? C.bg : "transparent",
              borderWidth: 1,
              borderColor: on ? C.border2 : "transparent",
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <Text
              numberOfLines={1}
              style={{ color: on ? C.text : C.text3, fontSize: T.small, fontWeight: on ? "700" : "400" }}
            >{option.label}</Text>
            {option.count === undefined ? null : (
              <Text style={{
                color: on ? C.text2 : C.text3, fontSize: T.eyebrow, fontVariant: ["tabular-nums"],
              }}>{option.count}</Text>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * A list that comes up from the bottom, for choosing one of many.
 *
 * What this replaces is a horizontal strip of chips, and the argument against
 * that strip is arithmetic rather than taste: it showed about three checkouts
 * of the twenty-three on the machine, so the other twenty were reachable only
 * by dragging a row whose contents you could not see. It also spent a whole
 * line of every screen it was on, permanently, to display one selected value.
 *
 * A sheet spends nothing until it is opened and then spends the screen, which
 * is the right trade for something you touch once and dismiss. It can hold a
 * filter, which a strip cannot.
 *
 * `Modal` rather than an absolutely-positioned overlay: a sheet has to sit over
 * the tab bar, and the bar is a flex sibling of the scene rather than something
 * drawn under it — an overlay inside a screen is clipped by the screen.
 */
export function Sheet({ open, onClose, title, children }: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}): ReactNode {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      {/* The scrim closes it. Tapping outside is how every sheet on either
          platform is dismissed, and a sheet that can only be closed by a button
          is a dialog wearing a sheet's shape. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Close ${title}`}
        onPress={onClose}
        style={{ flex: 1, backgroundColor: SCRIM }}
      />
      <View style={{
        backgroundColor: C.bg2,
        borderTopWidth: 1,
        borderTopColor: C.border2,
        // The capsule radius, because a sheet's top edge IS the round thing on
        // the screen it covers — same reason and same number as the composer.
        borderTopLeftRadius: RADIUS.pill,
        borderTopRightRadius: RADIUS.pill,
        paddingTop: SPACE.md,
        // The gesture bar, paid once. Nothing else in the sheet knows about it.
        paddingBottom: insets.bottom + SPACE.md,
        maxHeight: "75%",
      }}>
        {/* The grabber. It does not drag — this sheet is dismissed by the
            scrim or the back gesture — and it is here because it is the one
            mark that says "this came up from the bottom and will go back
            down", which a plain rounded box does not. */}
        <View style={{
          width: 36, height: 4, borderRadius: 2, backgroundColor: C.border2, alignSelf: "center",
        }} />
        <View style={{ paddingHorizontal: SPACE.lg, paddingTop: SPACE.md, paddingBottom: SPACE.sm }}>
          <Text style={{ color: C.text, fontSize: T.title, fontWeight: "700" }}>{title}</Text>
        </View>
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: SPACE.lg, paddingBottom: SPACE.sm }}
          keyboardShouldPersistTaps="handled"
        >
          {children}
        </ScrollView>
      </View>
    </Modal>
  );
}

/**
 * A row inside a Sheet: one choice, with what it costs you to pick it.
 *
 * `sub` is not decoration. Every list this is used for is a list of things
 * with the same kind of name — twenty-three checkouts all called something
 * hyphenated, a dozen board views all called a noun — so the second line is
 * what actually tells two of them apart.
 */
export function SheetRow({ label, sub, on, onPress }: {
  label: string;
  sub?: string;
  on?: boolean;
  onPress: () => void;
}): ReactNode {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: !!on }}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 60,
        flexDirection: "row",
        alignItems: "center",
        gap: SPACE.md,
        paddingVertical: SPACE.sm,
        borderBottomWidth: 1,
        borderBottomColor: C.border,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text
          numberOfLines={1}
          style={{ color: C.text, fontSize: T.body, fontWeight: on ? "700" : "400" }}
        >{label}</Text>
        {sub ? (
          <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.small }}>{sub}</Text>
        ) : null}
      </View>
      {/* A tick, not a highlighted row. The selected one has to be findable in
          a list of twenty without reading every line, and a mark at a fixed
          x-position is what the eye can run down. */}
      {on ? (
        <View style={{
          width: 12, height: 7, borderLeftWidth: 2.5, borderBottomWidth: 2.5, borderColor: C.primary,
          transform: [{ rotate: "-45deg" }], marginTop: -3, marginRight: 4,
        }} />
      ) : null}
    </Pressable>
  );
}

/**
 * A preference that is on or off: the platform's shape, drawn here.
 *
 * `Toggle` above is a box on purpose, for choices with no undo. A setting is
 * the other kind — flipped, looked at, flipped back — and Android people read
 * a switch as exactly that. Settings drew its one preference as a box beside
 * a sentence that changed wording with the state ("This phone may buzz" /
 * "Let this phone buzz"), so the only way to tell on from off was to read it.
 *
 * Material 3's geometry: a 52 × 32 track, a 24 thumb carrying a tick when on
 * and a 16 one when off, and the off track outlined so it is a control and
 * not a hole in the card. The whole row is the target, so the switch itself
 * needs no padding of its own.
 */
export function Switch({ on, disabled }: { on: boolean; disabled?: boolean }): ReactNode {
  return (
    <View
      style={{
        width: 52, height: 32, borderRadius: 16, justifyContent: "center",
        backgroundColor: on ? C.primary : C.bg4,
        borderWidth: on ? 0 : 2, borderColor: C.text4,
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <View style={{
        position: "absolute",
        left: on ? 24 : 6 - 2,
        width: on ? 24 : 16, height: on ? 24 : 16, borderRadius: 12,
        backgroundColor: on ? ink(C.primary) : C.text3,
        alignItems: "center", justifyContent: "center",
      }}>
        {on ? (
          <View style={{
            width: 9, height: 5, borderLeftWidth: 2, borderBottomWidth: 2,
            borderColor: C.primary, transform: [{ rotate: "-45deg" }], marginTop: -2,
          }} />
        ) : null}
      </View>
    </View>
  );
}

/**
 * A group title: sentence case, above a group, in the second text colour.
 *
 * The screens titled their groups in small uppercase (`Label`), which is a
 * desk convention: at 11 points on a phone it is the least legible line on the
 * screen, and it is the line that says what the group below is.
 */
export function GroupTitle({ text, trailing }: { text: string; trailing?: ReactNode }): ReactNode {
  return (
    <View style={{
      flexDirection: "row", alignItems: "center", gap: SPACE.sm,
      paddingHorizontal: SPACE.xs, paddingTop: SPACE.md, paddingBottom: SPACE.xs,
    }}>
      <Text accessibilityRole="header" style={{ color: C.text2, fontSize: 13, fontWeight: "600", flex: 1 }}>
        {text}
      </Text>
      {trailing}
    </View>
  );
}

/**
 * Rows that belong together, on one surface with hairlines between them.
 *
 * The same argument as `groupEdge`, for rows that are not in a FlatList: one
 * card with its rows divided, so eight settings read as eight lines of one
 * thing. The hairline is inset past the leading icon, the way Android draws a
 * list, so the icons read as a column and the dividers as belonging to the
 * text.
 */
export function Group({ children, inset = SPACE.lg }: { children: ReactNode; inset?: number }): ReactNode {
  const rows = (Array.isArray(children) ? children : [children]).flat().filter(Boolean);
  return (
    <View style={{
      backgroundColor: C.bg2, borderRadius: RADIUS.lg, borderWidth: 1, borderColor: C.border, overflow: "hidden",
    }}>
      {rows.map((row, i) => (
        <View key={i}>
          {i > 0 ? <View style={{ height: 1, backgroundColor: C.border, marginLeft: inset }} /> : null}
          {row}
        </View>
      ))}
    </View>
  );
}

/**
 * One row of a Group: a leading mark, a title with its line under it, and
 * whatever trails — a value, a switch, or the chevron that says it opens
 * something. 56 points tall with a line under the title, 48 without: both
 * over the floor, and the height a list row is on Android.
 */
export function Row({ title, sub, lead, trail, chevron, onPress, disabled, tone, checked }: {
  title: string;
  /** Set when the row IS a switch: TalkBack then says "switch, on" rather
   *  than "button", and the trailing Switch is only the drawing of it. */
  checked?: boolean;
  sub?: string;
  lead?: ReactNode;
  trail?: ReactNode;
  chevron?: boolean;
  onPress?: () => void;
  disabled?: boolean;
  tone?: "danger";
}): ReactNode {
  const body = (pressed: boolean): ReactNode => (
    <View style={{
      flexDirection: "row", alignItems: "center", gap: 14,
      minHeight: sub ? 56 : 48, paddingHorizontal: SPACE.lg, paddingVertical: SPACE.md,
      backgroundColor: pressed ? C.bg3 : "transparent",
      opacity: disabled ? 0.45 : 1,
    }}>
      {lead}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text numberOfLines={1} style={{
          color: tone === "danger" ? C.error : C.text, fontSize: 15, fontWeight: "500",
        }}>{title}</Text>
        {sub ? <Text numberOfLines={2} style={{ color: C.text3, fontSize: T.small, lineHeight: 17 }}>{sub}</Text> : null}
      </View>
      {trail}
      {chevron ? <ChevronIcon color={C.text3} size={18} /> : null}
    </View>
  );
  if (!onPress) return body(false);
  return (
    <Pressable
      accessibilityRole={checked === undefined ? "button" : "switch"}
      accessibilityState={checked === undefined ? { disabled: !!disabled } : { checked, disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
    >
      {({ pressed }) => body(pressed)}
    </Pressable>
  );
}

export type ChipTone = "neutral" | "accent" | "good" | "warn" | "bad";

/**
 * A short fact in a pill: "Approved", "2 failed", "bug".
 *
 * There were four: an outlined one in the pull requests, a tinted one on the
 * cards, a label pill on issues and a status pill on the card detail, each
 * with its own radius and padding. One now, filled with a tint of its tone and
 * written in the tone itself, so the colour carries the meaning twice and the
 * word carries it for somebody who cannot see the colour.
 */
export function Chip({ label, tone = "neutral", icon }: {
  label: string;
  tone?: ChipTone;
  icon?: ReactNode;
}): ReactNode {
  const ink_ = tone === "accent" ? C.primary : tone === "good" ? C.success : tone === "warn" ? C.warning
    : tone === "bad" ? C.error : C.text2;
  return (
    <View style={{
      flexDirection: "row", alignItems: "center", gap: 4, height: 24, paddingHorizontal: 8,
      borderRadius: 6, backgroundColor: tone === "neutral" ? C.bg3 : tint(ink_, 0.14), flexShrink: 1,
    }}>
      {icon}
      <Text numberOfLines={1} style={{ color: ink_, fontSize: T.small, fontWeight: "500" }}>{label}</Text>
    </View>
  );
}

/**
 * A row of filters, scrolled sideways: "All repos", then each repository.
 *
 * A scrolling row rather than the full-width `Segmented`, because this list
 * grows with the machine and a segmented control cannot. The selected one is
 * filled and ticked, so it is findable without reading every label.
 */
export function FilterChips<V extends string>({ options, value, onChange, label }: {
  options: { id: V; label: string }[];
  value: V;
  onChange: (v: V) => void;
  label: string;
}): ReactNode {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityLabel={label}
      /* "handled", or the first tap on a chip while a search box has the
         keyboard up only closes the keyboard and the chip needs a second. */
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingHorizontal: SPACE.lg, gap: SPACE.sm }}
      /* flexShrink too: beside a long list this row is the flexible child and
         was squeezed a dozen points, its chips clipped along the bottom. */
      style={{ flexGrow: 0, flexShrink: 0 }}
    >
      {options.map((o) => {
        const on = o.id === value;
        return (
          <Pressable
            key={o.id}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            onPress={() => onChange(o.id)}
            hitSlop={{ top: 8, bottom: 8 }}
            style={({ pressed }) => ({
              flexDirection: "row", alignItems: "center", gap: 6, height: 32,
              paddingHorizontal: 12, borderRadius: RADIUS.sm,
              backgroundColor: on ? tint(C.primary, 0.16) : "transparent",
              borderWidth: 1, borderColor: on ? "transparent" : C.border2,
              transform: [{ scale: pressed ? 0.97 : 1 }],
            })}
          >
            {on ? (
              <View style={{
                width: 9, height: 5, borderLeftWidth: 2, borderBottomWidth: 2, borderColor: C.primary,
                transform: [{ rotate: "-45deg" }], marginTop: -2,
              }} />
            ) : null}
            <Text style={{ color: on ? C.primary : C.text2, fontSize: 13, fontWeight: on ? "600" : "500" }}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/**
 * A repository's label, in the colour the repository gave it — as a dot and a
 * tint behind the name, with the name in the text colour.
 *
 * GitHub stores these as six hex digits and no `#`, and some are chosen
 * against a white page: a label written in its own pale yellow was unreadable
 * on the dark ground. The colour still says which label it is; the word is
 * legible whatever the repository picked.
 */
export function LabelChip({ name, color }: { name: string; color?: string }): ReactNode {
  const clean = (color || "").replace(/^#/, "");
  const hex = /^[0-9a-fA-F]{6}$/.test(clean) ? `#${clean}` : null;
  return (
    <View style={{
      flexDirection: "row", alignItems: "center", gap: 6, height: 24, paddingHorizontal: 8, borderRadius: 6,
      backgroundColor: hex ? tint(hex, 0.18) : C.bg3,
    }}>
      {hex ? <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: hex }} /> : null}
      <Text numberOfLines={1} style={{ color: C.text, fontSize: T.small, fontWeight: "500" }}>{name}</Text>
    </View>
  );
}

/**
 * A command to run on the computer, with a button that copies it.
 *
 * Selectable and copyable, not runnable. Every command this app shows is for
 * somebody else's machine (an install, a `gh auth login`) and a phone that
 * could run one would be a phone that can run anything as whoever owns it.
 * One component because Troubleshooting and the pull request list both need
 * it, and two copies of a box are two boxes that stop matching.
 */
export function CommandLine({ line }: { line: string }): ReactNode {
  return (
    <View style={{
      flexDirection: "row", alignItems: "center", paddingLeft: SPACE.md,
      backgroundColor: C.bg, borderRadius: RADIUS.md, borderWidth: 1, borderColor: C.border,
    }}>
      <Text selectable style={{ color: C.text, fontSize: T.small, fontFamily: MONO, flex: 1 }}>{line}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Copy: ${line}`}
        onPress={() => {
          void Clipboard.setStringAsync(line);
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }}
        style={({ pressed }) => ({
          width: TAP, height: TAP, alignItems: "center", justifyContent: "center",
          transform: [{ scale: pressed ? 0.97 : 1 }],
        })}
      >
        <Glyph name="copy" color={C.text2} size={18} />
      </Pressable>
    </View>
  );
}
