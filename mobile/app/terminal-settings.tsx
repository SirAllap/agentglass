/*
 * The key bar, arranged.
 *
 * ── why this screen exists ───────────────────────────────────────────────
 * There are seventeen accessory keys and a phone shows six or seven at the
 * fold. The rest live behind a horizontal drag on a strip whose contents you
 * cannot see — the same objection this project already made about the
 * repository chips, and it lands harder here: the keys people use are not the
 * same set for any two people. Somebody living in `less` wants ^R and ^U at
 * the front. Somebody driving an agent wants Escape, Ctrl+C and nothing else.
 * A fixed order is one guess made for everybody.
 *
 * ── why buttons and not a drag handle ────────────────────────────────────
 * Orca's own list drags, and dragging is nicer. It is also a gesture library,
 * a scroll conflict on a list inside a scroll view, and a reorder that fights
 * the keyboard on the screen where the keyboard is the point. Two arrows are
 * duller and work with one thumb on a bus, which is where this is used.
 *
 * ── and why the bar can never be emptied ─────────────────────────────────
 * The last visible key cannot be hidden. An empty bar is a terminal with no
 * Escape and no Ctrl+C on it, and the way to put them back is on THIS screen —
 * which means leaving the pane to fix a pane you can no longer stop. The rule
 * lives in the model (see canHide) and this screen simply does not draw the
 * switch.
 */
import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Stack } from "expo-router";
import { usePaletteTick } from "../src/state/use-palette.ts";
import { ACCESSORY_KEYS } from "../src/terminal/keys.ts";
import { canHide, move, reset, rows, toggle } from "../src/terminal/keyLayout.ts";
import {
  COLUMNS, keyLayout, onTermPrefs, setKeyLayout, setTermColumns, termColumns,
} from "../src/terminal/termPrefs.ts";
import { Btn, Note, Section, Segmented, TAP, groupEdge } from "../src/ui.tsx";
import { C, MONO, RADIUS, SPACE, T } from "../src/theme.ts";

export default function TerminalSettingsScreen(): React.ReactNode {
  usePaletteTick(); // a scene repaints only if it asks — see use-palette.ts

  /* The layout is a module singleton so the terminal and this screen see one
     value. This is only the local mirror that makes the list repaint. */
  const [layout, setLocal] = useState(keyLayout);
  const [cols, setCols] = useState(termColumns);
  useEffect(() => onTermPrefs(() => { setLocal(keyLayout()); setCols(termColumns()); }), []);

  const change = useCallback((next: ReturnType<typeof keyLayout>): void => {
    setKeyLayout(next);
    setLocal(next);
  }, []);

  const list = rows(layout, ACCESSORY_KEYS);
  const shownCount = list.filter((r) => r.shown).length;

  return (
    <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.lg, paddingBottom: SPACE.xl }}>
      <Stack.Screen options={{ title: "Terminal" }} />

      <Section
        label="How wide"
        note={
          "How many columns the phone asks the pane for. 60 to read, 80 to work. There is no "
          + "wider rung on purpose: measured on this screen, 120 columns clips each glyph inside "
          + "its own cell and characters change identity — a seven loses its bar and reads as a "
          + "slash, so a commit hash comes back wrong."
        }
      >
        <Segmented
          value={String(cols)}
          onChange={(v) => { const n = Number(v); setTermColumns(n); setCols(n); }}
          options={COLUMNS.map((n) => ({ id: String(n), label: `${n}c` }))}
        />
        <Note>
          {/* The one thing worth saying out loud, because it is the surprise:
              this is what the pane is RESIZED to while the phone is looking at
              it, not a zoom applied on the glass. */}
          A pane wider than this is shown from its left-hand edge, and the terminal says so when
          that happens.
        </Note>
      </Section>

      <Section
        label="The key bar"
        note={
          `${shownCount} of ${ACCESSORY_KEYS.length} keys are on the bar. About seven reach the fold `
          + "on a 360dp phone; the rest are a drag away, so what is worth putting first is whatever "
          + "you reach for without looking."
        }
        style={{ padding: 0, gap: 0 }}
      >
        {list.map((row, i) => {
          const off = !row.shown;
          const first = i === 0;
          const last = i === list.length - 1;
          return (
            <View
              key={row.key.id}
              style={[
                groupEdge(first, last),
                {
                  flexDirection: "row", alignItems: "center", gap: SPACE.sm,
                  paddingHorizontal: SPACE.md, minHeight: TAP,
                  // The group's own border is drawn by the Section's card, so
                  // these only need the hairline between them.
                  borderLeftWidth: 0, borderRightWidth: 0,
                  borderTopWidth: 0,
                  borderBottomWidth: last ? 0 : 1,
                  borderRadius: 0,
                  backgroundColor: "transparent",
                },
              ]}
            >
              {/* The key as it appears on the bar, so the row is recognised by
                  the thing it controls rather than by a name for it. */}
              <View style={{
                minWidth: 46, height: 30, alignItems: "center", justifyContent: "center",
                borderRadius: RADIUS.sm, backgroundColor: off ? "transparent" : C.bg3,
                borderWidth: 1, borderColor: off ? C.border : C.border2,
                paddingHorizontal: SPACE.sm,
              }}>
                <Text style={{
                  color: off ? C.text4 : C.text2, fontSize: T.small, fontFamily: MONO,
                }}>{row.key.label}</Text>
              </View>

              <Text
                numberOfLines={1}
                style={{ color: off ? C.text4 : C.text, fontSize: T.small, flex: 1 }}
              >{row.key.spoken}</Text>

              {/* Only for what is on the bar: reordering something hidden moves
                  it within a list nobody can see. */}
              {row.shown ? (
                <>
                  <Arrow
                    label="Move earlier"
                    glyph="↑"
                    disabled={i === 0}
                    onPress={() => change(move(layout, ACCESSORY_KEYS, row.key.id, -1))}
                  />
                  <Arrow
                    label="Move later"
                    glyph="↓"
                    disabled={i === shownCount - 1}
                    onPress={() => change(move(layout, ACCESSORY_KEYS, row.key.id, 1))}
                  />
                </>
              ) : null}

              <Pressable
                onPress={() => change(toggle(layout, ACCESSORY_KEYS, row.key.id))}
                // Not drawn as a dead switch: the last key on the bar is the
                // one thing here that cannot be turned off, and a control that
                // refuses silently teaches nothing.
                disabled={row.shown && !canHide(layout, ACCESSORY_KEYS, row.key.id)}
                accessibilityRole="switch"
                accessibilityState={{ checked: row.shown }}
                accessibilityLabel={`${row.key.spoken} on the bar`}
                style={({ pressed }) => ({
                  width: 40, height: TAP, alignItems: "center", justifyContent: "center",
                  opacity: pressed ? 0.6 : 1,
                })}
              >
                <View style={{
                  width: 20, height: 20, borderRadius: 5,
                  alignItems: "center", justifyContent: "center",
                  borderWidth: 1, borderColor: row.shown ? C.primary : C.border2,
                  backgroundColor: row.shown ? C.primary : "transparent",
                }} />
              </Pressable>
            </View>
          );
        })}
      </Section>

      <Section
        label="Start again"
        note="Every key back on the bar, in the order this app ships with."
      >
        <Btn label="Reset the key bar" onPress={() => change(reset())} />
        <Note>
          {/* Said out loud because it is the one thing on this screen that
              cannot be undone by pressing it again. */}
          This forgets the order and everything you have hidden.
        </Note>
      </Section>
    </ScrollView>
  );
}

/** One of the two reorder arrows. Its own component only so the disabled
 *  treatment and the tap target are written once. */
function Arrow({ label, glyph, disabled, onPress }: {
  label: string;
  glyph: string;
  disabled: boolean;
  onPress: () => void;
}): React.ReactNode {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => ({
        width: 34, height: TAP, alignItems: "center", justifyContent: "center",
        opacity: disabled ? 0.25 : pressed ? 0.6 : 1,
      })}
    >
      <Text style={{ color: C.text3, fontSize: T.body }}>{glyph}</Text>
    </Pressable>
  );
}
