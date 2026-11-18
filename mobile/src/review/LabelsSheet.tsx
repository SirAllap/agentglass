/*
 * Labels on one pull request, picked from the repository's own list.
 *
 * The repository is asked for its labels rather than reading them off the rows
 * on screen: a facet list built from twenty loaded rows is a sample, and the
 * one label somebody wants is routinely the hundredth. The pull request's own
 * labels are merged in even when that read fails, so a label already applied
 * can always be taken off.
 *
 * Saving posts the DIFFERENCE — `{add, remove}` — which is the shape
 * `/prs/labels` takes. An unchanged sheet has nothing to send and says so.
 */
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";
import { ask } from "../lib/api.ts";
import type { Host } from "../lib/host.ts";
import { labelChoices, labelDiff, findLabels, type LabelLike } from "../model/prManage.ts";
import { Btn, Note, Sheet } from "../ui.tsx";
import { Glyph } from "../nav/glyphs.tsx";
import { C, RADIUS, SPACE, T, ink } from "../theme.ts";

export function LabelsSheet({ open, onClose, host, root, number, current, mayWrite, blocked, onSaved }: {
  open: boolean;
  onClose: () => void;
  host: Host | null;
  root: string;
  number: number;
  current: string[];
  mayWrite: boolean;
  /** Why this phone may not write, from model/prManage.ts, or null. */
  blocked: string | null;
  onSaved: () => void;
}): React.ReactNode {
  const [repo, setRepo] = useState<LabelLike[]>([]);
  const [picked, setPicked] = useState<string[]>(current);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [readErr, setReadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const currentKey = current.join("\u0000");
  useEffect(() => {
    if (!open) return;
    setPicked(current);
    setText("");
    setErr(null);
    if (!host) return;
    let gone = false;
    setLoading(true);
    void (async () => {
      const answer = await ask<{ ok: boolean; data?: { labels?: LabelLike[] }; error?: string }>(
        host, `/prs/facets?root=${encodeURIComponent(root)}`,
      );
      if (gone) return;
      setLoading(false);
      if (!answer.ok) { setReadErr(answer.error); return; }
      if (!answer.value.ok) { setReadErr(answer.value.error ?? "The repository's labels could not be read."); return; }
      setReadErr(null);
      setRepo(answer.value.data?.labels ?? []);
    })();
    return () => { gone = true; };
  }, [open, host, root, currentKey]); // `current` enters as its joined value; the array is a new one each render

  const choices = labelChoices(repo, current);
  const shown = findLabels(choices, text);
  const diff = labelDiff(current, picked);
  const changes = diff.add.length + diff.remove.length;

  const toggle = (name: string): void => {
    setPicked((was) => (was.includes(name) ? was.filter((n) => n !== name) : [...was, name]));
  };

  const save = useCallback(async (): Promise<void> => {
    if (!host || !mayWrite || !changes || busy) return;
    setBusy(true);
    setErr(null);
    const answer = await ask<{ ok: boolean; error?: string }>(host, "/prs/labels", {
      method: "POST",
      body: { root, number, add: diff.add, remove: diff.remove },
    });
    setBusy(false);
    if (!answer.ok) { setErr(answer.error); return; }
    if (!answer.value.ok) { setErr(answer.value.error ?? "GitHub refused that label edit."); return; }
    onSaved();
    onClose();
  }, [host, mayWrite, changes, busy, root, number, diff.add, diff.remove, onSaved, onClose]);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`Labels on #${number}`}
      subtitle={blocked ?? "A label is one GitHub keeps. Updating here updates it everywhere."}
      tall
      footer={
        <Btn
          label={changes ? `Save ${changes} label${changes === 1 ? "" : "s"}` : "No change"}
          tone="primary"
          busy={busy}
          disabled={!mayWrite || !changes || busy}
          onPress={() => { void save(); }}
          style={{ flex: 1 }}
        />
      }
    >
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder="Find a label"
        placeholderTextColor={C.text4}
        accessibilityLabel="Find a label"
        style={{
          minHeight: 48, borderRadius: RADIUS.md, borderWidth: 1, borderColor: C.border2,
          backgroundColor: C.bg3, color: C.text, fontSize: T.body, paddingHorizontal: SPACE.md,
          marginVertical: SPACE.sm,
        }}
      />

      {loading && !choices.length ? (
        <View style={{ padding: SPACE.lg, alignItems: "center" }}><ActivityIndicator color={C.text3} /></View>
      ) : null}
      {readErr ? (
        <View style={{ paddingBottom: SPACE.sm }}>
          <Note tone="bad">
            The repository's labels could not be read ({readErr}). Only the ones on this pull request are drawn.
          </Note>
        </View>
      ) : null}

      {shown.length ? (
        <View style={{ paddingTop: SPACE.sm }}>
          {shown.map((l) => {
            const on = picked.includes(l.name);
            return (
              <Pressable
                key={l.name}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                accessibilityLabel={l.name}
                onPress={() => toggle(l.name)}
                style={({ pressed }) => ({
                  minHeight: 59, flexDirection: "row", alignItems: "center", gap: SPACE.md,
                  paddingVertical: SPACE.sm, opacity: pressed ? 0.6 : 1,
                })}
              >
                <View style={{
                  width: 30, height: 30, borderRadius: 10, alignItems: "center", justifyContent: "center",
                  backgroundColor: C.bg3,
                }}>
                  {l.color
                    ? <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: `#${l.color.replace(/^#/, "")}` }} />
                    : <Glyph name="tag" color={C.text2} size={16} weight={1.8} />}
                </View>
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <Text numberOfLines={1} style={{ color: C.text, fontSize: 14.5, fontWeight: "600" }}>{l.name}</Text>
                  <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.small }}>
                    {on ? `On #${number} now` : "Off. It stays in the repository."}
                  </Text>
                </View>
                <View style={{
                  width: 26, height: 26, borderRadius: 8, alignItems: "center", justifyContent: "center",
                  borderWidth: on ? 0 : 1, borderColor: C.border2,
                  backgroundColor: on ? C.primary : "transparent",
                }}>
                  {on ? (
                    <View style={{
                      width: 11, height: 6, borderLeftWidth: 2, borderBottomWidth: 2,
                      borderColor: ink(C.primary), transform: [{ rotate: "-45deg" }], marginTop: -2,
                    }} />
                  ) : null}
                </View>
              </Pressable>
            );
          })}
        </View>
      ) : (
        <View style={{ paddingVertical: SPACE.md }}>
          <Note>{text.trim() ? `No label matches “${text.trim()}”.` : "This repository has no labels."}</Note>
        </View>
      )}

      <View style={{ paddingTop: SPACE.md }}>
        <Note>
          <Text style={{ fontWeight: "700", color: C.text2 }}>Off removes the label from #{number} only.</Text>
          {" "}The label itself stays in the repository for the next pull request.
        </Note>
      </View>
      {err ? <View style={{ paddingTop: SPACE.sm }}><Note tone="bad">{err}</Note></View> : null}
    </Sheet>
  );
}
