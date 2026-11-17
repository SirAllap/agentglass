/*
 * Quiet hours, the sheet the Settings row opens.
 *
 * A draft saved on one button, like every sheet this app already draws: each
 * tap on a time writes nothing, and Save is what makes the night quiet. The
 * value itself is this phone's (see quietPref.ts), and the note says so
 * instead of borrowing the computer's authority for a rule it never had.
 */
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  FROM_CHOICES, TO_CHOICES, clockText, cycle, quietText, type QuietPref,
} from "../model/quietHours.ts";
import { quietPref, setQuietPref } from "../notifications/quietPref.ts";
import { Btn, Note, Sheet, Switch, TAP } from "../ui.tsx";
import { C, MONO, RADIUS, SPACE, T } from "../theme.ts";

/** One of the sheet's rows: what it is, and the control that changes it. The
 *  row itself is the switch's target, so the whole line flips it. */
function Line({ title, sub, children, onPress, checked }: {
  title: string;
  sub?: string;
  children: React.ReactNode;
  onPress?: () => void;
  checked?: boolean;
}): React.ReactNode {
  const body = (pressed: boolean): React.ReactNode => (
    <View style={{
      flexDirection: "row", alignItems: "center", gap: SPACE.md,
      minHeight: 58, paddingVertical: SPACE.sm, borderTopWidth: 1, borderTopColor: C.border,
      backgroundColor: pressed ? C.bg3 : "transparent",
    }}>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text style={{ color: C.text, fontSize: 14.5, fontWeight: "600" }}>{title}</Text>
        {sub ? <Text style={{ color: C.text3, fontSize: T.small, lineHeight: 17 }}>{sub}</Text> : null}
      </View>
      {children}
    </View>
  );
  if (!onPress) return body(false);
  return (
    <Pressable
      accessibilityRole={checked === undefined ? "button" : "switch"}
      accessibilityState={checked === undefined ? undefined : { checked }}
      accessibilityLabel={title}
      onPress={onPress}
    >
      {({ pressed }) => body(pressed)}
    </Pressable>
  );
}

/** The time as a button that steps to the next one, the way the mock draws it.
 *  A picker would be three taps and a wheel for a value with three answers. */
function TimeButton({ minutes, choices, onChange }: {
  minutes: number;
  choices: readonly number[];
  onChange: (next: number) => void;
}): React.ReactNode {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${clockText(minutes)}. Tap for the next time`}
      onPress={() => onChange(cycle(minutes, choices))}
      style={({ pressed }) => ({
        minWidth: 84, minHeight: TAP, paddingHorizontal: SPACE.md, borderRadius: RADIUS.md,
        alignItems: "center", justifyContent: "center",
        borderWidth: 1, borderColor: C.border2, backgroundColor: pressed ? C.bg3 : C.bg2,
      })}
    >
      <Text style={{ color: C.text, fontSize: T.body, fontWeight: "600", fontFamily: MONO }}>
        {clockText(minutes)}
      </Text>
    </Pressable>
  );
}

export function QuietHoursSheet({ open, onClose }: {
  open: boolean;
  onClose: () => void;
}): React.ReactNode {
  const [draft, setDraft] = useState<QuietPref>(quietPref());

  // Opened again after a save elsewhere: the draft is what is stored now, not
  // what was on screen when the sheet was last dismissed.
  useEffect(() => { if (open) setDraft(quietPref()); }, [open]);

  const set = (patch: Partial<QuietPref>): void => setDraft((d) => ({ ...d, ...patch }));

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Quiet hours"
      subtitle="Nothing rings in this window. The Inbox still fills, and nothing is lost."
      footer={
        <Btn
          label="Save quiet hours"
          tone="primary"
          style={{ flex: 1 }}
          onPress={() => { setQuietPref(draft); onClose(); }}
        />
      }
    >
      <View style={{ paddingBottom: SPACE.md }}>
        <Line
          title="Quiet hours"
          sub={draft.on ? `On, ${quietText(draft)}. The Inbox still fills.` : "Off: every alert rings, whatever the hour."}
          checked={draft.on}
          onPress={() => set({ on: !draft.on })}
        >
          <Switch on={draft.on} />
        </Line>
        <Line title="From" sub="When the phone stops ringing">
          <TimeButton minutes={draft.from} choices={FROM_CHOICES} onChange={(from) => set({ from })} />
        </Line>
        <Line title="To" sub="When it starts again">
          <TimeButton minutes={draft.to} choices={TO_CHOICES} onChange={(to) => set({ to })} />
        </Line>
        <Line
          title="Let a stopped agent through"
          sub="A failure at 3 am is the one thing that still rings."
          checked={draft.agents}
          onPress={() => set({ agents: !draft.agents })}
        >
          <Switch on={draft.agents} />
        </Line>
        <View style={{ paddingTop: SPACE.md }}>
          <Note>
            Quiet hours belong to this phone, not to the computer — it is the pocket that decides when a buzz
            is rude. A watch that fires in the window is kept in the Inbox, with the time it happened.
          </Note>
        </View>
      </View>
    </Sheet>
  );
}
