/*
 * The card list's filters, in one sheet.
 *
 * Statuses are a wrapped two-column checklist, people a list of their own with
 * faces (a person is one of many, and a face is what tells two of them apart),
 * grouping a switch. The footer never moves: Reset on the left, what pressing
 * the other button will show on the right. Edits are a draft until that button
 * is pressed, so the list behind the sheet does not churn while somebody is
 * still choosing. Everything runs on the cards already loaded; what each
 * choice means, and the count, is decided in model/cardBoard.ts.
 */
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { ListStatus } from "../../../shared/providers.ts";
import { AVATAR, Avatar } from "../Avatar.tsx";
import { Btn, CheckBox, CheckItem, Group, Label, Note, Row, Sheet, Switch } from "../ui.tsx";
import {
  NO_CARD_FILTERS, personOptions, scopeCards, shownCount, statusOptions, UNASSIGNED, type BoardCard, type CardFilters,
} from "../model/cardBoard.ts";
import { toggled } from "../model/prFilters.ts";
import { C, SPACE, T } from "../theme.ts";

function Person({ name, sub, on, count, onPress, face }: {
  name: string; sub?: string; on: boolean; count?: number; onPress: () => void; face: React.ReactNode;
}): React.ReactNode {
  return (
    <Pressable
      accessibilityRole="checkbox" accessibilityState={{ checked: on }}
      accessibilityLabel={count === undefined ? name : `${name}, ${count}`}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 56, flexDirection: "row", alignItems: "center", gap: SPACE.md, paddingHorizontal: SPACE.lg,
        backgroundColor: pressed ? C.bg3 : "transparent",
      })}
    >
      {face}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ color: C.text, fontSize: T.body, fontWeight: on ? "700" : "500" }}>{name}</Text>
        {sub ? <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.small }}>{sub}</Text> : null}
      </View>
      {count === undefined ? null : <Text style={{ color: C.text3, fontSize: T.small, fontVariant: ["tabular-nums"] }}>{count}</Text>}
      <CheckBox on={on} />
    </Pressable>
  );
}

export function CardFilterSheet({ open, onClose, scope, filters, onApply, cards, statuses, query, openOnly, truncated }: {
  open: boolean;
  onClose: () => void;
  /** What the filters apply to, in words: the board's name. */
  scope: string;
  filters: CardFilters;
  onApply: (f: CardFilters) => void;
  /** Every loaded card, before the search, Open/All and the filters. */
  cards: readonly BoardCard[];
  /** The list's own statuses, for their order. */
  statuses: readonly ListStatus[];
  query: string;
  openOnly: boolean;
  /** The board read stopped at its page limit. */
  truncated: boolean;
}): React.ReactNode {
  const [draft, setDraft] = useState<CardFilters>(filters);
  // Each opening starts from what is applied, not from the last abandoned draft.
  useEffect(() => { if (open) setDraft(filters); }, [open, filters]);

  const inScope = scopeCards(cards, query, openOnly);
  const options = statusOptions(inScope, statuses, draft.statuses);
  const { people, unassigned } = personOptions(inScope, draft.people, cards);
  const n = shownCount(cards, draft, query, openOnly);
  const set = (p: Partial<CardFilters>): void => setDraft((d) => ({ ...d, ...p }));

  const footer = (
    <>
      <Btn label="Reset" onPress={() => setDraft(NO_CARD_FILTERS)} style={{ minHeight: 48, minWidth: 96 }} />
      <Btn
        tone="primary" label={`Show ${n} card${n === 1 ? "" : "s"}`}
        onPress={() => { onApply(draft); onClose(); }}
        style={{ minHeight: 48, flex: 1 }}
      />
    </>
  );

  return (
    <Sheet open={open} onClose={onClose} tall footer={footer} title="Filter cards" subtitle={`${scope} · runs on the loaded cards`}>
      <View style={{ gap: SPACE.lg, paddingBottom: SPACE.md }}>
        <View style={{ gap: SPACE.sm }}>
          <Label text="Status" />
          {options.length ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACE.sm }}>
              {options.map((s) => (
                <CheckItem
                  key={s.status} label={s.status} count={s.count} dot={s.color} on={draft.statuses.includes(s.status)}
                  onPress={() => set({ statuses: toggled(draft.statuses, s.status) })}
                />
              ))}
            </View>
          ) : <Note>No card here to narrow by status.</Note>}
        </View>
        <View style={{ gap: SPACE.sm }}>
          <Label text="Assignee" />
          <Group inset={SPACE.lg + AVATAR.sheet}>
            {[
              ...people.map((p) => (
                <Person
                  key={p.key} name={p.name} sub={p.sub} count={p.count} on={draft.people.includes(p.key)}
                  onPress={() => set({ people: toggled(draft.people, p.key) })}
                  face={<Avatar name={p.sub ?? p.name} avatar={p.avatar} initials={p.initials} color={p.color} size={AVATAR.sheet} />}
                />
              )),
              unassigned || draft.people.includes(UNASSIGNED) ? (
                <Person
                  key="none" name="Unassigned" count={unassigned} on={draft.people.includes(UNASSIGNED)}
                  onPress={() => set({ people: toggled(draft.people, UNASSIGNED) })}
                  face={<Avatar name="Unassigned" initials="?" color={C.bg4} size={AVATAR.sheet} />}
                />
              ) : null,
            ]}
          </Group>
        </View>
        <Group>
          {[
            <Row
              key="group" title="Group by status" sub="Section headers, like the desk board" checked={draft.group}
              onPress={() => set({ group: !draft.group })} trail={<Switch on={draft.group} />}
            />,
          ]}
        </Group>
        {truncated ? <Note>The board is longer than what was read. Filters narrow the cards loaded so far.</Note> : null}
      </View>
    </Sheet>
  );
}
