/*
 * A comment on one card, written in a sheet whose only job is the writing.
 *
 * The card screen already has a composer under its comments, and that is where
 * a reply belongs. This sheet is the other door — "Add" beside the Comments
 * title — and its shape is the mock's: the field gets the room, one row says
 * who will see it, one line says what a comment is NOT (a status change).
 *
 * The write is the same POST the inline composer makes, and the answer's card
 * is handed back so both doors agree on what the card says afterwards.
 */
import { useEffect, useState } from "react";
import { Text, TextInput, View } from "react-native";
import type { TaskDetail } from "../../../shared/providers.ts";
import { ask } from "../lib/api.ts";
import type { Host } from "../lib/host.ts";
import { Btn, Chip, Note, Sheet, TAP } from "../ui.tsx";
import { Glyph } from "../nav/glyphs.tsx";
import { C, RADIUS, SPACE, T } from "../theme.ts";

export function CommentSheet({ open, onClose, host, cardKey, onPosted }: {
  open: boolean;
  onClose: () => void;
  host: Host;
  cardKey: string;
  /** The card as the server answered the comment, and how many more it has. */
  onPosted: (detail: TaskDetail, more: number) => void;
}): React.ReactNode {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);

  useEffect(() => { if (open) { setText(""); setSaid(null); setBusy(false); } }, [open, cardKey]);

  const send = async (): Promise<void> => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setSaid(null);
    const answer = await ask<{ ok: boolean; error?: string; detail?: TaskDetail; more?: number }>(
      host, "/jira/comment", { method: "POST", body: { key: cardKey, text: text.trim() } },
    );
    setBusy(false);
    if (!answer.ok) { setSaid(answer.error); return; }
    if (!answer.value.ok) { setSaid(answer.value.error ?? "Jira did not take that comment."); return; }
    if (answer.value.detail) onPosted(answer.value.detail, answer.value.more ?? 0);
    onClose();
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`Comment on ${cardKey}`}
      subtitle="The comment is written as you, through the computer."
      footer={
        <View style={{ flex: 1 }}>
          <Btn label="Add the comment" tone="primary" busy={busy} disabled={!text.trim()} onPress={() => { void send(); }} />
        </View>
      }
    >
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder="Say what changed, or what you need…"
        placeholderTextColor={C.text4}
        accessibilityLabel={`Comment on ${cardKey}`}
        multiline
        autoFocus
        style={{
          minHeight: 120, color: C.text, fontSize: 14, textAlignVertical: "top", lineHeight: 20,
          borderWidth: 1, borderColor: C.border2, borderRadius: RADIUS.md, padding: SPACE.md, backgroundColor: C.bg2,
        }}
      />
      <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm, minHeight: TAP, paddingTop: SPACE.xs }}>
        <Glyph name="eye" color={C.text3} size={17} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: C.text, fontSize: 14, fontWeight: "600" }}>Visible to everyone on the board</Text>
          <Text style={{ color: C.text3, fontSize: T.small }}>No internal-only comment on this board.</Text>
        </View>
        <Chip label="public" />
      </View>
      <Note>A comment is not a status change. Moving the card is the move sheet, one tap back on the card.</Note>
      {said ? <Note tone="bad">{said}</Note> : null}
    </Sheet>
  );
}
