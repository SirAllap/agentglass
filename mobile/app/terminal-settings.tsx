/*
 * The key bar, arranged.
 *
 * Only the keys. The pane's width and the keyboard's help were here too and
 * moved to Settings ▸ Terminal: they are preferences, reached where the other
 * preferences are, and this screen is reached from the terminal's own menu.
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
 * ── a drag handle, and the arrows beside it ─────────────────────────────
 * The handle is the fast way: put a key where you want it in one move. It is
 * a PanResponder on the handle alone, with the page's scroll switched off for
 * as long as the finger is down — a gesture library would be a dependency for
 * one list, and a drag that starts anywhere on the row would fight the scroll
 * the screen needs. The two arrows stay: a drag is no use to somebody using a
 * switch or a screen reader, and a one-place nudge is still one thumb tap on
 * a bus. Ceiling: the row follows the finger and lands on release; the rows it
 * passes do not slide out of the way.
 *
 * ── and why the bar can never be emptied ─────────────────────────────────
 * The last visible key cannot be hidden. An empty bar is a terminal with no
 * Escape and no Ctrl+C on it, and the way to put them back is on THIS screen —
 * which means leaving the pane to fix a pane you can no longer stop. The rule
 * lives in the model (see canHide) and this screen simply does not draw the
 * switch.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Animated, PanResponder, Pressable, ScrollView, Text, View } from "react-native";
import { Stack } from "expo-router";
import { usePaletteTick } from "../src/state/use-palette.ts";
import { ACCESSORY_KEYS } from "../src/terminal/keys.ts";
import { canHide, dropIndex, move, moveTo, reset, rows, toggle } from "../src/terminal/keyLayout.ts";
import {
  MAX_CUSTOM, add, bytesFor, mintId, problemWith, remove,
} from "../src/terminal/customKeys.ts";
import { customKeys, keyLayout, onTermPrefs, setCustomKeys, setKeyLayout } from "../src/terminal/termPrefs.ts";
import { Btn, Field, Group, GroupTitle, Note, Row, Sheet, Switch, TAP } from "../src/ui.tsx";
import { Glyph } from "../src/nav/glyphs.tsx";
import { C, MONO, RADIUS, SPACE, T } from "../src/theme.ts";

export default function TerminalSettingsScreen(): React.ReactNode {
  usePaletteTick(); // a scene repaints only if it asks — see use-palette.ts

  /* The layout is a module singleton so the terminal and this screen see one
     value. This is only the local mirror that makes the list repaint. */
  const [layout, setLocal] = useState(keyLayout);
  /* The half-written key. Local to this screen: nothing is stored until it is
     added, so leaving with a field half-filled loses a draft rather than
     putting a broken key on somebody's bar. */
  const [label, setLabel] = useState("");
  const [text, setText] = useState("");
  const [enter, setEnter] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [mine, setMine] = useState(customKeys);

  useEffect(() => onTermPrefs(() => {
    setLocal(keyLayout());
    setMine(customKeys());
  }), []);

  const change = useCallback((next: ReturnType<typeof keyLayout>): void => {
    setKeyLayout(next);
    setLocal(next);
  }, []);

  /* The same catalogue the bar builds, so what is arranged here is what is
     drawn there. */
  const catalogue = useMemo(() => [
    ...ACCESSORY_KEYS,
    ...mine.map((k) => ({ id: k.id, label: k.label, bytes: bytesFor(k), spoken: k.label })),
  ], [mine]);
  const list = rows(layout, catalogue);
  const shownCount = list.filter((r) => r.shown).length;
  const onBar = list.filter((r) => r.shown);
  const offBar = list.filter((r) => !r.shown);
  const [adding, setAdding] = useState(false);
  /* A row is being dragged: the page must not scroll under the finger. */
  const [dragging, setDragging] = useState(false);

  const keyRow = (row: (typeof list)[number], i: number): React.ReactNode => (
    <DragRow
      key={row.key.id}
      draggable={row.shown}
      label={`Drag ${row.key.spoken} to a new place on the bar`}
      index={i}
      count={shownCount}
      onHold={setDragging}
      onDrop={(to) => change(moveTo(layout, catalogue, row.key.id, to))}
    >
      <Keycap label={row.key.label} off={!row.shown} />
      <Text numberOfLines={1} style={{ color: row.shown ? C.text : C.text3, fontSize: 14.5, flex: 1 }}>{row.key.spoken}</Text>
      {/* Only for what is on the bar: reordering something hidden moves it
          within a list nobody can see. */}
      {row.shown ? (
        <>
          <Arrow label={`Move ${row.key.spoken} earlier`} glyph="up" disabled={i === 0}
            onPress={() => change(move(layout, catalogue, row.key.id, -1))} />
          <Arrow label={`Move ${row.key.spoken} later`} glyph="down" disabled={i === shownCount - 1}
            onPress={() => change(move(layout, catalogue, row.key.id, 1))} />
        </>
      ) : null}
      <Pressable
        onPress={() => change(toggle(layout, catalogue, row.key.id))}
        // Not drawn as a dead switch: the last key on the bar is the one thing
        // here that cannot be turned off, and it is dimmed rather than silent.
        disabled={row.shown && !canHide(layout, catalogue, row.key.id)}
        accessibilityRole="switch"
        accessibilityState={{ checked: row.shown }}
        accessibilityLabel={`${row.key.spoken} on the bar`}
        style={{ height: TAP, justifyContent: "center", paddingHorizontal: SPACE.xs }}
      >
        <Switch on={row.shown} disabled={row.shown && !canHide(layout, catalogue, row.key.id)} />
      </Pressable>
    </DragRow>
  );

  return (
    <ScrollView scrollEnabled={!dragging} contentContainerStyle={{ padding: SPACE.lg, paddingTop: SPACE.xs, gap: SPACE.xs, paddingBottom: SPACE.xl }}>
      <Stack.Screen
        options={{
          title: "Key bar",
          headerRight: () => (
            <Pressable
              accessibilityRole="button"
              onPress={() => Alert.alert(
                "Reset the key bar?",
                // Said out loud because it is the one thing on this screen that
                // cannot be undone by pressing it again.
                "Every key goes back on the bar, in the order this app ships with. The order and everything you hid are forgotten.",
                [{ text: "Keep it", style: "cancel" }, { text: "Reset", style: "destructive", onPress: () => change(reset()) }],
              )}
              style={({ pressed }) => ({ minHeight: TAP, justifyContent: "center", paddingHorizontal: SPACE.md, opacity: pressed ? 0.7 : 1 })}
            >
              <Text style={{ color: C.primary, fontSize: T.body, fontWeight: "600" }}>Reset</Text>
            </Pressable>
          ),
        }}
      />

      {/* The bar as it will be drawn, so a change is seen as the thing it
          changes. About seven reach the fold on a 360dp phone; the rest are a
          drag away, so what is worth putting first is whatever you reach for
          without looking. */}
      <Text style={{ color: C.text3, fontSize: T.small, paddingHorizontal: SPACE.xs, paddingTop: SPACE.xs }}>
        As it appears above the keyboard
      </Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{
        gap: 6, padding: 10, borderRadius: RADIUS.lg, backgroundColor: C.bg2, borderWidth: 1, borderColor: C.border,
      }}>
        {onBar.map((row) => <Keycap key={row.key.id} label={row.key.label} />)}
      </ScrollView>

      <GroupTitle text={`On the bar · ${shownCount}`} />
      <Group>{onBar.map((row, i) => keyRow(row, i))}</Group>

      {offBar.length ? (
        <>
          <GroupTitle text={`Off the bar · ${offBar.length}`} />
          <Group>{offBar.map((row, i) => keyRow(row, shownCount + i))}</Group>
        </>
      ) : null}

      {/*
        A key that sends whatever you give it. Most of what is worth a button on
        a phone is not a control code — it is `git status`, `/clear`, or the one
        long command this project needs. Sending a Return after it is the
        difference between writing the command and running it.
      */}
      <GroupTitle text="Your own keys" />
      {mine.length ? (
        <Group>
          {mine.map((k) => (
            <View key={k.id} style={{ flexDirection: "row", alignItems: "center", gap: SPACE.md, minHeight: 56, paddingLeft: SPACE.lg, paddingRight: SPACE.xs }}>
              <Keycap label={k.label} />
              <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
                <Text numberOfLines={1} style={{ color: C.text, fontSize: 14, fontWeight: "500", fontFamily: MONO }}>{k.text}</Text>
                <Text style={{ color: C.text3, fontSize: T.small }}>{k.enter ? "Runs it" : "Types it, you press Return"}</Text>
              </View>
              <Pressable
                onPress={() => { const next = remove(mine, k.id); setCustomKeys(next); setMine(next); }}
                accessibilityRole="button"
                accessibilityLabel={`Delete the ${k.label} key`}
                style={({ pressed }) => ({
                  width: TAP, height: TAP, borderRadius: TAP / 2, alignItems: "center", justifyContent: "center",
                  backgroundColor: pressed ? C.bg3 : "transparent",
                })}
              >
                <Glyph name="trash" color={C.text3} size={20} />
              </Pressable>
            </View>
          ))}
        </Group>
      ) : (
        <View style={{ paddingHorizontal: SPACE.xs }}>
          <Note>A key that sends whatever you give it: `git status`, `/clear`, the one long command this project needs.</Note>
        </View>
      )}
      <View style={{ paddingTop: SPACE.md }}>
        {mine.length < MAX_CUSTOM ? (
          <Btn label="Add a key" onPress={() => { setProblem(null); setAdding(true); }} />
        ) : (
          <Note>{MAX_CUSTOM} is the most. Past a dozen, scrolling the bar is the problem again.</Note>
        )}
      </View>

      <Sheet open={adding} onClose={() => setAdding(false)} title="New key">
        <View style={{ gap: SPACE.md, paddingBottom: SPACE.md }}>
          <View style={{ flexDirection: "row", gap: SPACE.sm }}>
            <Field value={label} onChangeText={setLabel} placeholder="Key" label="Label" kind="code" style={{ width: 92 }} />
            <View style={{ flex: 1 }}>
              <Field value={text} onChangeText={setText} placeholder="What it sends" label="Sends" kind="code" />
            </View>
          </View>
          <Group>
            <Row
              title="Press Return after it"
              sub={enter ? "Runs it" : "Leaves it on the line for you to finish"}
              checked={enter}
              trail={<Switch on={enter} />}
              onPress={() => setEnter((v) => !v)}
            />
          </Group>
          {problem ? <Note tone="bad">{problem}</Note> : null}
          <Btn
            label="Add key"
            tone="primary"
            disabled={!label.trim() || !text}
            onPress={() => {
              const made = { id: mintId(Date.now(), Math.random()), label, text, enter };
              const why = problemWith(made);
              if (why) { setProblem(why); return; }
              const next = add(mine, made);
              setCustomKeys(next);
              setMine(next);
              setLabel(""); setText(""); setEnter(false); setProblem(null);
              setAdding(false);
            }}
          />
        </View>
      </Sheet>
    </ScrollView>
  );
}

/** Every key row is this tall, so a drop's distance is a count of rows. */
const ROW = 56;

/**
 * One row of the list, and the handle that drags it.
 *
 * The row follows the finger vertically and the drop is worked out on release
 * from how far it travelled (see `dropIndex`). The responder is on the handle
 * only, and refuses to give the gesture up: the page's ScrollView would
 * otherwise take it the moment the finger drifts, which is the drag ending in
 * the middle with the key nowhere. Only the keys on the bar can be dragged;
 * the rows under "Off the bar" draw no handle but keep its width so the
 * keycaps line up.
 */
function DragRow({ draggable, label, index, count, onHold, onDrop, children }: {
  draggable: boolean;
  label: string;
  index: number;
  count: number;
  onHold: (held: boolean) => void;
  onDrop: (to: number) => void;
  children: React.ReactNode;
}): React.ReactNode {
  const y = useRef(new Animated.Value(0)).current;
  const [lifted, setLifted] = useState(false);
  /* The responder is built once; what it reads is kept current here. */
  const now = useRef({ index, count, onHold, onDrop });
  now.current = { index, count, onHold, onDrop };

  /* Back to rest, however the gesture ended. */
  const putDown = (): void => { y.setValue(0); setLifted(false); now.current.onHold(false); };

  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => { setLifted(true); now.current.onHold(true); },
    onPanResponderMove: (_, g) => {
      const { index: at, count: n } = now.current;
      // The row cannot leave the list: stop it at either end.
      y.setValue(Math.max(-at * ROW, Math.min((n - 1 - at) * ROW, g.dy)));
    },
    onPanResponderRelease: (_, g) => {
      const { index: at, count: n, onDrop: drop } = now.current;
      const to = dropIndex(at, g.dy, ROW, n);
      putDown();
      if (to !== at) drop(to);
    },
    onPanResponderTerminate: putDown,
  })).current;

  return (
    <Animated.View style={{
      flexDirection: "row", alignItems: "center", gap: SPACE.md, height: ROW, paddingLeft: SPACE.xs, paddingRight: SPACE.sm,
      transform: [{ translateY: y }], zIndex: lifted ? 10 : 0, elevation: lifted ? 6 : 0,
      backgroundColor: lifted ? C.bg3 : "transparent",
    }}>
      {draggable ? (
        <View
          {...pan.panHandlers}
          accessible
          accessibilityRole="button"
          accessibilityLabel={label}
          style={{ width: 36, height: TAP, alignItems: "center", justifyContent: "center" }}
        >
          <Glyph name="grip" color={C.text3} size={22} />
        </View>
      ) : <View style={{ width: 36 }} />}
      {children}
    </Animated.View>
  );
}

/** A key as the bar draws it, so each row is recognised by the thing it
 *  controls rather than by a name for it. */
function Keycap({ label, off }: { label: string; off?: boolean }): React.ReactNode {
  return (
    <View style={{
      minWidth: 46, height: 32, alignItems: "center", justifyContent: "center", paddingHorizontal: SPACE.sm,
      borderRadius: RADIUS.sm, backgroundColor: off ? "transparent" : C.bg3, borderWidth: 1, borderColor: C.border2,
    }}>
      <Text style={{ color: off ? C.text3 : C.text, fontSize: 13, fontFamily: MONO }}>{label}</Text>
    </View>
  );
}

/** One of the two reorder arrows. Its own component only so the disabled
 *  treatment and the tap target are written once. */
function Arrow({ label, glyph, disabled, onPress }: {
  label: string;
  glyph: "up" | "down";
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
        width: 40, height: TAP, borderRadius: 20, alignItems: "center", justifyContent: "center",
        opacity: disabled ? 0.25 : 1, backgroundColor: pressed ? C.bg3 : "transparent",
      })}
    >
      {/* One chevron, turned for "earlier": the pair reads as a pair. */}
      <View style={{ transform: [{ rotate: glyph === "up" ? "180deg" : "0deg" }] }}>
        <Glyph name="down" color={C.text2} size={20} />
      </View>
    </Pressable>
  );
}
