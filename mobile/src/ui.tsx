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
import { C, RADIUS, SCRIM, SPACE, T, ink } from "./theme.ts";

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
          opacity: off ? 0.45 : pressed ? 0.75 : 1,
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

export function Label({ text }: { text: string }): ReactNode {
  return (
    <Text style={{
      color: C.text3, fontSize: T.eyebrow, letterSpacing: 0.8, textTransform: "uppercase",
    }}>{text}</Text>
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
                color: on ? C.text3 : C.text4, fontSize: T.eyebrow, fontVariant: ["tabular-nums"],
              }}>{option.count}</Text>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * The header's title, when the title is also a choice.
 *
 * The repository strip used to be a whole row under the header, and the header
 * above it said "Pull requests" — a word the tab below was already saying. So
 * the row is gone and the name of what you are looking at moved into the space
 * that was spending itself on the category.
 *
 * It is a title first and a control second, which is why it is the header's own
 * type and not a button's: the chevron is the entire affordance, and it is
 * enough because the alternative reading — that this static word opens
 * something — costs one tap to discover and nothing to be wrong about.
 */
export function HeaderPick({ label, onPress }: { label: string; onPress: () => void }): ReactNode {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}. Opens the list.`}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: TAP,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: SPACE.xs,
        paddingHorizontal: SPACE.sm,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Text
        numberOfLines={1}
        style={{ color: C.text, fontSize: T.title, fontWeight: "700", maxWidth: 210 }}
      >{label}</Text>
      <Text style={{ color: C.text3, fontSize: T.small }}>▾</Text>
    </Pressable>
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
        <Text style={{ color: C.primary, fontSize: T.title, fontWeight: "700" }}>✓</Text>
      ) : null}
    </Pressable>
  );
}
