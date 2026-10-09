/*
 * The card changed between opening it and moving it.
 *
 * A dialog, not a sheet: it interrupts a write with a question that has two
 * answers, and both are said in full. The primary button is the safe one, to
 * leave the card as the other person made it (the screen already shows it so,
 * it was re-read); overwriting is the secondary and names the status it would
 * write, so nobody overwrites somebody by reflex.
 */
import { Modal, Pressable, Text, View } from "react-native";
import { Btn } from "../ui.tsx";
import type { ConflictDialog } from "../model/cardStatus.ts";
import { C, RADIUS, SCRIM, SPACE, T } from "../theme.ts";

export function StatusConflict({ dialog, busy, onKeep, onOverwrite }: {
  dialog: ConflictDialog | null;
  busy: boolean;
  onKeep: () => void;
  onOverwrite: () => void;
}): React.ReactNode {
  return (
    <Modal visible={!!dialog} transparent animationType="fade" onRequestClose={onKeep}>
      <View style={{ flex: 1, justifyContent: "center", padding: SPACE.xl }}>
        <Pressable accessibilityLabel="Close" onPress={onKeep} style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, backgroundColor: SCRIM }} />
        <View style={{ backgroundColor: C.bg2, borderRadius: RADIUS.lg, borderWidth: 1, borderColor: C.border2, padding: SPACE.lg, gap: SPACE.md }}>
          <Text style={{ color: C.text, fontSize: T.title, fontWeight: "700" }}>Changed since you opened it</Text>
          <Text style={{ color: C.text2, fontSize: T.body, lineHeight: 21 }}>{dialog?.text}</Text>
          <View style={{ gap: SPACE.sm, paddingTop: SPACE.sm }}>
            <Btn tone="primary" label={dialog?.keep ?? ""} onPress={onKeep} disabled={busy} style={{ minHeight: 48 }} />
            {dialog?.overwrite ? (
              <Btn label={dialog.overwrite} onPress={onOverwrite} busy={busy} style={{ minHeight: 48 }} />
            ) : null}
          </View>
        </View>
      </View>
    </Modal>
  );
}
