/*
 * Mock s29, "Save this view": name the board on screen and write it to the
 * computer's `/prs/views`, so the desk shows it as a chip too. What is saved is
 * the two hide rules this phone has (drafts, bots); the "everyone" scope is the
 * phone's own and is only said, not saved.
 */
import { useEffect, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { VIEW_LIMITS } from "../../../shared/prFilter.ts";
import type { LaneRules } from "../model/prBoard.ts";
import { Btn, Note, Sheet } from "../ui.tsx";
import { C, RADIUS, SPACE, T } from "../theme.ts";

export function SaveViewSheet({ open, onClose, repo, rules, everyone, onSave }: {
  open: boolean;
  onClose: () => void;
  repo: string;
  rules: LaneRules;
  everyone: boolean;
  /** Null on success, else the sentence to show. */
  onSave: (name: string) => Promise<string | null>;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setName(""); setError(null); setBusy(false); } }, [open]);
  const hides = [rules.drafts ? "drafts" : null, rules.bots ? "bots" : null].filter(Boolean).join(" and ");
  const save = async (): Promise<void> => {
    setBusy(true);
    const err = await onSave(name);
    setBusy(false);
    if (err) setError(err); else onClose();
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Save this view"
      subtitle={repo}
      footer={<Btn label="Save the view" tone="primary" busy={busy} disabled={busy} onPress={() => void save()} />}
    >
      <TextInput
        value={name}
        onChangeText={(t) => { setName(t); setError(null); }}
        placeholder="Name this view"
        placeholderTextColor={C.text4}
        accessibilityLabel="Name this view"
        maxLength={VIEW_LIMITS.name}
        autoFocus
        style={{
          minHeight: 48, borderRadius: RADIUS.md, borderWidth: 1, borderColor: C.border2,
          backgroundColor: C.bg3, color: C.text, fontSize: T.body, paddingHorizontal: SPACE.md,
          marginVertical: SPACE.sm,
        }}
      />
      <View style={{ paddingVertical: SPACE.xs }}>
        <Text style={{ color: C.text, fontSize: T.body }}>{hides ? `Hides ${hides}` : "Hides nothing"}</Text>
        {everyone ? <Text style={{ color: C.text3, fontSize: T.small }}>Everyone’s pull requests is on this phone only; it is not saved.</Text> : null}
      </View>
      {error ? <Text accessibilityRole="alert" style={{ color: C.error, fontSize: T.small, paddingVertical: SPACE.xs }}>{error}</Text> : null}
      <Note>A view is a name for the rules. It lives with the repository, so the computer shows the same chips.</Note>
    </Sheet>
  );
}
