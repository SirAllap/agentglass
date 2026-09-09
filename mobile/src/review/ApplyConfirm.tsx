/*
 * "Commit this to the branch?" — the one question in the review flow that has
 * to be asked out loud.
 *
 * Applying a suggestion writes a commit to somebody else's branch. Everything
 * else here can be undone by saying something; that cannot, so it names whose
 * branch, which lines, and who gets the credit, and it shows the text itself.
 *
 * A card over the screen rather than a sheet: what it is confirming is TEXT,
 * and a sheet you have to scroll to see what you are agreeing to is a sheet
 * nobody reads to the bottom.
 */
import { ScrollView, Text, View } from "react-native";
import type { PrThread } from "../../../shared/types.ts";
import { whereOf } from "../model/threads.ts";
import { Btn, Label, Note } from "../ui.tsx";
import { C, MONO, RADIUS, SCRIM, SPACE, T } from "../theme.ts";

export function ApplyConfirm({ thread, text, branch, onCancel, onApply }: {
  thread: PrThread;
  text: string;
  branch: string | null | undefined;
  onCancel: () => void;
  onApply: () => void;
}): React.ReactNode {
  return (
    <View style={{
      position: "absolute", left: 0, right: 0, bottom: 0, top: 0,
      backgroundColor: SCRIM, justifyContent: "flex-end",
    }}>
      <View style={{
        backgroundColor: C.bg2, borderTopLeftRadius: RADIUS.lg, borderTopRightRadius: RADIUS.lg,
        padding: SPACE.lg, gap: SPACE.md, maxHeight: "80%",
      }}>
        <Label text="Commit this to the branch?" />
        <Text style={{ color: C.text2, fontSize: T.small }}>
          {whereOf(thread)} on {branch ?? "the head branch"}
        </Text>
        <ScrollView style={{ maxHeight: 220 }}>
          <Text style={{
            color: C.text, fontFamily: MONO, fontSize: 11, lineHeight: 17,
            backgroundColor: C.bg, padding: SPACE.sm, borderRadius: RADIUS.sm,
          }}>{text === "" ? "(removes those lines)" : text}</Text>
        </ScrollView>
        <Note>
          It is committed through GitHub, credited to {thread.comments[0]?.author ?? "whoever wrote it"},
          and refused if anybody has pushed since this was read.
        </Note>
        <View style={{ flexDirection: "row", gap: SPACE.sm }}>
          <Btn label="Cancel" style={{ flex: 1 }} onPress={onCancel} />
          <Btn label="Apply" tone="primary" style={{ flex: 1 }} onPress={onApply} />
        </View>
      </View>
    </View>
  );
}
