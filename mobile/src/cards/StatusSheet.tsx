/*
 * Move a card: one sheet, every status in full, one button that confirms.
 *
 * This replaces a horizontal strip of chips that showed three statuses and cut
 * the rest off, "Blocked" among them. Here every status of the card's list is a
 * row the width of the screen, in the list's own order and colours, the card's
 * current one tagged. Tapping a row only chooses; the fixed button at the
 * bottom is the confirmation, and it stays disabled until the choice is a
 * status the card is not in, so a stray tap moves nothing and notifies nobody.
 */
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Btn, LabelChip, Sheet } from "../ui.tsx";
import { moveLabel, statusChoices, statusInk } from "../model/cardStatus.ts";
import { C, RADIUS, SPACE, T, tint } from "../theme.ts";

function Radio({ on }: { on: boolean }): React.ReactNode {
  return (
    <View style={{
      width: 24, height: 24, borderRadius: 12, borderWidth: 2, alignItems: "center", justifyContent: "center",
      borderColor: on ? C.primary : C.border2,
    }}>
      {on ? <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: C.primary }} /> : null}
    </View>
  );
}

export function StatusSheet({ open, onClose, list, statuses, current, onMove }: {
  open: boolean;
  onClose: () => void;
  /** The card's list, for the line under the title. */
  list: string | null;
  statuses: readonly { status: string; color?: string }[];
  current: string;
  onMove: (status: string) => void;
}): React.ReactNode {
  const [choice, setChoice] = useState<string | null>(null);
  // Each opening starts on where the card is, not on the last abandoned choice.
  useEffect(() => { if (open) setChoice(current); }, [open, current]);

  const choices = statusChoices(statuses, current);
  const go = moveLabel(current, choice);
  const count = `${choices.length} status${choices.length === 1 ? "" : "es"}`;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Status"
      subtitle={list ? `${list} · ${count}` : count}
      footer={(
        <>
          <Btn label="Cancel" onPress={onClose} style={{ minHeight: 48, minWidth: 96 }} />
          <Btn
            tone="primary" label={go.label} disabled={!go.enabled}
            onPress={() => { if (choice) onMove(choice); }}
            style={{ minHeight: 48, flex: 1 }}
          />
        </>
      )}
    >
      <View style={{ borderRadius: RADIUS.lg, borderWidth: 1, borderColor: C.border, overflow: "hidden" }}>
        {choices.map((c, i) => {
          const on = choice !== null && c.status.trim().toLowerCase() === choice.trim().toLowerCase();
          return (
            <Pressable
              key={c.status}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              accessibilityLabel={c.current ? `${c.status}, current` : c.status}
              onPress={() => setChoice(c.status)}
              style={{
                minHeight: 56, flexDirection: "row", alignItems: "center", gap: SPACE.md, paddingHorizontal: SPACE.md,
                borderTopWidth: i ? 1 : 0, borderTopColor: C.border,
                backgroundColor: on ? tint(C.primary, 0.12) : "transparent",
              }}
            >
              <Radio on={on} />
              <View style={{ flex: 1, flexDirection: "row" }}>
                <LabelChip name={c.status} color={statusInk(c.color)} />
              </View>
              {c.current ? (
                <Text style={{
                  color: C.text3, fontSize: T.eyebrow, fontWeight: "700", letterSpacing: 0.6,
                  paddingHorizontal: SPACE.sm, paddingVertical: 3, borderRadius: 6, backgroundColor: C.bg3,
                }}>CURRENT</Text>
              ) : null}
            </Pressable>
          );
        })}
      </View>
    </Sheet>
  );
}
