/*
 * Who is on a card: one sheet, everybody who can be, one button that applies.
 *
 * Tapping a person only stages: the row is tinted and says Add or Remove, and
 * the footer says the whole change in one line ("+ cy − bob") over a button
 * that counts it. That line and that button are the confirmation; there is no
 * dialog after them. The footer is one block whose lines never move, so the
 * thumb that pressed a row finds Apply where it was before.
 *
 * You are first, then the list's people in the order ClickUp gives them, then
 * anybody already on the card the list did not name, so they can still be
 * taken off. Search narrows by name or email and never changes what is staged.
 */
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, View, type TextStyle } from "react-native";
import type { ProviderTask } from "../../../shared/providers.ts";
import { AVATAR, Avatar } from "../Avatar.tsx";
import { SNACK_MS } from "./Snackbar.tsx";
import { PrSearchRow } from "../review/PrSearchRow.tsx";
import { Btn, CheckBox, Note, Sheet } from "../ui.tsx";
import {
  applyLabel, assigneeOptions, currentIds, nameIn, peopleKey, rowTag, stagedDiff, summaryParts, type Diff, type Person,
} from "../model/cardAssignees.ts";
import { toggled } from "../model/prFilters.ts";
import { C, RADIUS, SPACE, T, tint } from "../theme.ts";

const pill = (ink: string): TextStyle => ({
  color: ink, fontSize: T.eyebrow, fontWeight: "700", letterSpacing: 0.6,
  paddingHorizontal: SPACE.sm, paddingVertical: 3, borderRadius: 6, backgroundColor: tint(ink, 0.14), overflow: "hidden",
});

export function AssigneeSheet({ open, onClose, id, members, error, onRetry, current, onApply }: {
  open: boolean;
  onClose: () => void;
  /** The card's id, for the line under the title. */
  id: string;
  /** Null while they are being read. */
  members: readonly Person[] | null;
  error: string | null;
  onRetry: () => void;
  current: ProviderTask["people"];
  onApply: (diff: Diff) => void;
}): React.ReactNode {
  const was = currentIds(current);
  const [picked, setPicked] = useState<number[]>(was);
  const [query, setQuery] = useState("");
  // Each opening starts from who is on the card, not from an abandoned draft.
  // Keyed by WHO is on the card, not by the card object: a background refresh
  // hands over a new object with the same people and must not untick the draft.
  const onCard = peopleKey(current);
  useEffect(() => { if (open) { setPicked(currentIds(current)); setQuery(""); } }, [open, onCard]);

  const all = members ?? [];
  const options = assigneeOptions(all, current, query);
  const diff = stagedDiff(was, picked);
  const go = applyLabel(diff);
  const known = [...all, ...(current ?? [])];
  const parts = summaryParts(diff, (n) => nameIn(known, n));

  return (
    <Sheet
      open={open}
      onClose={onClose}
      tall
      title="Assignees"
      subtitle={`${id} · pick any number`}
      footer={(
        <View style={{ flex: 1, gap: SPACE.sm }}>
          <View style={{ height: 24, flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
            <Text numberOfLines={1} style={{ flex: 1, fontSize: T.small, fontWeight: "600", color: C.text3 }}>
              {parts.length
                ? parts.map((p, i) => (
                  <Text key={p} style={{ color: p.startsWith("+") ? C.success : C.error }}>{i ? "  " : ""}{p}</Text>
                ))
                : "No changes yet"}
            </Text>
            <Text style={{ color: C.text3, fontSize: T.small }}>one write · undo for {SNACK_MS / 1000} s</Text>
          </View>
          <View style={{ flexDirection: "row", gap: SPACE.md }}>
            <Btn label="Cancel" onPress={onClose} style={{ minHeight: 48, minWidth: 96 }} />
            <Btn
              tone="primary" label={go.label} disabled={!go.enabled}
              onPress={() => onApply(diff)}
              style={{ minHeight: 48, flex: 1 }}
            />
          </View>
        </View>
      )}
    >
      <View style={{ gap: SPACE.md, paddingBottom: SPACE.md }}>
        <PrSearchRow value={query} onChange={setQuery} placeholder="Find a person" label="Find a person" />
        {members === null && !error ? (
          <View style={{ minHeight: 120, alignItems: "center", justifyContent: "center" }}>
            <ActivityIndicator color={C.text3} />
          </View>
        ) : null}
        {error ? (
          <View style={{ gap: SPACE.sm }}>
            <Note tone="bad">{error}</Note>
            <Btn label="Try again" onPress={onRetry} style={{ minHeight: 48 }} />
          </View>
        ) : null}
        {members !== null ? (
          options.length ? (
            <View style={{ borderRadius: RADIUS.lg, borderWidth: 1, borderColor: C.border, overflow: "hidden" }}>
              {options.map((p, i) => {
                const on = picked.includes(p.id);
                const tag = rowTag(p.id, was, picked);
                return (
                  <Pressable
                    key={p.id}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: on }}
                    accessibilityLabel={`${p.name}${p.me ? ", you" : ""}${tag ? `, ${tag.toLowerCase()}` : ""}`}
                    onPress={() => setPicked((cur) => toggled(cur, p.id))}
                    style={{
                      minHeight: 64, flexDirection: "row", alignItems: "center", gap: SPACE.md, paddingHorizontal: SPACE.md,
                      borderTopWidth: i ? 1 : 0, borderTopColor: C.border,
                      backgroundColor: tag ? tint(C.primary, 0.12) : "transparent",
                    }}
                  >
                    <Avatar name={p.name} avatar={p.avatar} initials={p.initials} color={p.color} size={AVATAR.sheet} />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
                        <Text numberOfLines={1} style={{ flexShrink: 1, color: C.text, fontSize: T.body, fontWeight: on ? "700" : "500" }}>{p.name}</Text>
                        {p.me ? <Text style={pill(C.primary)}>YOU</Text> : null}
                      </View>
                      {p.email ? <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.small }}>{p.email}</Text> : null}
                    </View>
                    {tag ? <Text style={pill(tag === "Add" ? C.success : C.error)}>{tag.toUpperCase()}</Text> : null}
                    <CheckBox on={on} />
                  </Pressable>
                );
              })}
            </View>
          ) : <Note>{query.trim() ? "Nobody matches that." : "Nobody can be put on this card."}</Note>
        ) : null}
      </View>
    </Sheet>
  );
}
