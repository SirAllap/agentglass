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
  ActivityIndicator, Pressable, Text, TextInput, View,
  type StyleProp, type TextStyle, type ViewStyle,
} from "react-native";
import { C, RADIUS, SPACE, T, ink } from "./theme.ts";

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
