/*
 * The filter sheet: text, assignee, status and type, with a count on every chip
 * and the number of cards the whole sheet is about to leave.
 *
 * It applies on "Show N cards" rather than on every tick: a board that redraws
 * under each finger makes a person lose the card they were looking at, and the
 * counts are live so the outcome is known before the press. "Clear all" resets
 * every question at once and applies immediately — clearing is not a choice
 * anybody wants to confirm.
 *
 * No JQL field. The board's own saved filter lives on the computer; this is
 * four questions a thumb can answer, and the model (model/jiraFilters.ts) is
 * what decides the answers.
 *
 * ── wrapped, not scrolled ────────────────────────────────────────────────
 * The chips used to sit in one sideways row per question, so a board with six
 * people hid three of them off the right edge of a 360-point screen: the
 * question "who is it on?" was answered by a gesture nobody makes. They wrap
 * now, and the sheet is tall enough to show every answer at once.
 */
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { JiraQuickFilter, ProviderTask } from "../../../shared/providers.ts";
import {
  activeJiraFilters, applyJiraFilters, facetsOf, NO_JIRA_FILTERS,
  type JiraFilters,
} from "../model/jiraFilters.ts";
import { Btn, Field, Note, Sheet, TAP } from "../ui.tsx";
import { C, RADIUS, SPACE, T, tint } from "../theme.ts";

function ToggleChip({ label, count, on, face, onPress }: {
  label: string;
  count?: number;
  on: boolean;
  /** A mark before the word: the type's letter, or the "you" face. */
  face?: React.ReactNode;
  onPress: () => void;
}): React.ReactNode {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      accessibilityLabel={count === undefined ? label : `${label}, ${count} ${count === 1 ? "card" : "cards"}`}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row", alignItems: "center", gap: 6, height: TAP - 4, paddingHorizontal: SPACE.md,
        borderRadius: RADIUS.md, borderWidth: 1,
        borderColor: on ? C.primary : C.border,
        backgroundColor: on ? tint(C.primary, 0.14) : pressed ? C.bg3 : C.bg2,
      })}
    >
      {face}
      <Text style={{ color: on ? C.primary : C.text2, fontSize: T.small, fontWeight: "600" }}>{label}</Text>
      {count === undefined ? null : <Text style={{ color: on ? C.primary : C.text3, fontSize: T.small, fontWeight: "700" }}>{count}</Text>}
    </Pressable>
  );
}

/** A heading and the line that says what the question means. */
function Head({ label, note }: { label: string; note: string }): React.ReactNode {
  return (
    <View style={{ flexDirection: "row", alignItems: "baseline", gap: SPACE.sm, paddingHorizontal: 2, paddingTop: SPACE.md, paddingBottom: SPACE.xs }}>
      <Text style={{ color: C.text2, fontSize: T.small, fontWeight: "600" }}>{label}</Text>
      <View style={{ flex: 1 }} />
      <Text style={{ color: C.text4, fontSize: T.small }}>{note}</Text>
    </View>
  );
}

const toggle = (list: readonly string[], value: string): string[] =>
  list.some((v) => v.toLowerCase() === value.toLowerCase())
    ? list.filter((v) => v.toLowerCase() !== value.toLowerCase())
    : [...list, value];

export function JiraFiltersSheet({ open, onClose, cards, filters, statusOrder, onChange, quick = [], quickOn = [], onQuick }: {
  open: boolean;
  onClose: () => void;
  cards: readonly ProviderTask[];
  filters: JiraFilters;
  /** The view's status names, so the chips read in the board's order. */
  statusOrder: readonly string[];
  onChange: (f: JiraFilters) => void;
  /** The board's own quick filters; the server applies them, so they are read again, not counted here. */
  quick?: readonly JiraQuickFilter[];
  quickOn?: readonly string[];
  onQuick?: (ids: string[]) => void;
}): React.ReactNode {
  const [draft, setDraft] = useState<JiraFilters>(filters);
  // Each opening starts from what the board is actually showing, never from a
  // half-edited sheet somebody closed with the back gesture.
  useEffect(() => { if (open) setDraft(filters); }, [open, filters]);
  const [draftQuick, setDraftQuick] = useState<string[]>([...quickOn]);
  useEffect(() => { if (open) setDraftQuick([...quickOn]); }, [open, quickOn]);

  const facets = facetsOf(cards, draft, statusOrder);
  const shown = applyJiraFilters(cards, draft).length;
  const personOn = (name: string): boolean =>
    name === "" ? draft.assignee?.kind === "none" : draft.assignee?.kind === "person" && draft.assignee.name === name;
  const pickPerson = (name: string): void => setDraft({
    ...draft,
    assignee: personOn(name) ? null : name === "" ? { kind: "none" } : { kind: "person", name },
  });
  const mine = cards.filter((c) => c.mine === true).length;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Filter the ORBIT board"
      subtitle={`${cards.length} ${cards.length === 1 ? "card" : "cards"} · ${mine} yours · no JQL, just the four questions the board asks`}
      tall
      footer={
        <View style={{ flex: 1, gap: SPACE.sm }}>
          <Btn label={`Show ${shown} ${shown === 1 ? "card" : "cards"}`} tone="primary" onPress={() => { onChange(draft); onQuick?.(draftQuick); onClose(); }} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Clear all filters"
            accessibilityState={{ disabled: (activeJiraFilters(draft) + draftQuick.length) === 0 }}
            disabled={(activeJiraFilters(draft) + draftQuick.length) === 0}
            onPress={() => { setDraft(NO_JIRA_FILTERS); setDraftQuick([]); onChange(NO_JIRA_FILTERS); onQuick?.([]); onClose(); }}
            style={({ pressed }) => ({
              minHeight: TAP, alignItems: "center", justifyContent: "center",
              opacity: (activeJiraFilters(draft) + draftQuick.length) === 0 ? 0.45 : pressed ? 0.6 : 1,
            })}
          >
            <Text style={{ color: C.text2, fontSize: T.body, fontWeight: "600" }}>Clear all</Text>
          </Pressable>
        </View>
      }
    >
      <View style={{ paddingHorizontal: 2 }}>
        <Field value={draft.text} onChangeText={(text) => setDraft({ ...draft, text })} placeholder="Text in a key, a title or a label" />
      </View>
      {quick.length ? (
        <>
          <Head label="Board filters" note="the board's own, asked of Jira" />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, paddingHorizontal: 2 }}>
            {quick.map((q) => (
              <ToggleChip
                key={q.id}
                label={q.name}
                on={draftQuick.includes(q.id)}
                onPress={() => setDraftQuick(toggle(draftQuick, q.id))}
              />
            ))}
          </View>
        </>
      ) : null}
      <Head label="Assignee" note="one at a time" />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, paddingHorizontal: 2 }}>
        {facets.assignees.map((a) => (
          <ToggleChip
            key={a.name || "unassigned"}
            label={a.name === "" ? "Unassigned" : a.me ? `you · ${a.name}` : a.name}
            count={a.count}
            on={personOn(a.name)}
            onPress={() => pickPerson(a.name)}
          />
        ))}
        {facets.assignees.length === 0 ? <Note>No card here names an assignee.</Note> : null}
      </View>

      <Head label="Status" note="any of these" />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, paddingHorizontal: 2 }}>
        {facets.statuses.map((s) => (
          <ToggleChip
            key={s.name}
            label={s.name}
            count={s.count}
            on={draft.statuses.some((v) => v.toLowerCase() === s.name.toLowerCase())}
            onPress={() => setDraft({ ...draft, statuses: toggle(draft.statuses, s.name) })}
          />
        ))}
      </View>

      <Head label="Type" note="any of these" />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, paddingHorizontal: 2 }}>
        {facets.types.map((t) => (
          <ToggleChip
            key={t.name}
            label={t.name}
            count={t.count}
            on={draft.types.some((v) => v.toLowerCase() === t.name.toLowerCase())}
            onPress={() => setDraft({ ...draft, types: toggle(draft.types, t.name) })}
          />
        ))}
      </View>

      <View style={{ paddingTop: SPACE.md }}>
        <Note>
          Filters stay on this phone until you clear them. The board on the computer keeps its own.
          Nothing here is saved as a JQL string.
        </Note>
      </View>

      {facets.statuses.length === 0 && cards.length > 0 ? (
        <View style={{ paddingTop: SPACE.sm }}>
          <Note>This view reports no statuses, so the status row has nothing to offer. The board still files cards by their own status.</Note>
        </View>
      ) : null}
    </Sheet>
  );
}
