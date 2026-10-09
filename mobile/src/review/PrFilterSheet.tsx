/*
 * The PR list's filters, in one sheet.
 *
 * Three to four choices are a segmented control, the tracker's card statuses a
 * wrapped two-column checklist, and the author a list of its own reached by a
 * row (a person is one of many, which a control in a row cannot hold). The
 * footer never moves: Reset on the left, what pressing the other button will
 * show on the right. Edits are a draft until that button is pressed, so the list
 * behind the sheet does not churn while somebody is still choosing.
 *
 * What each choice means, and the count, is decided in model/prFilters.ts.
 */
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PrSummary } from "../../../shared/types.ts";
import { AVATAR, Avatar } from "../Avatar.tsx";
import { Glyph } from "../nav/glyphs.tsx";
import { Btn, CheckBox, CheckItem, Label, Note, Segmented, Sheet } from "../ui.tsx";
import {
  authorOptions, cardStatusOptions, CHECKS_SELS, DRAFT_SELS, effectiveState, NO_FILTERS, REVIEW_SELS, shownCount,
  toggled, type PrFilters,
} from "../model/prFilters.ts";
import { STATE_LABEL, STATE_VIEWS, type StateView } from "../model/prState.ts";
import { C, RADIUS, SPACE, T, tint } from "../theme.ts";

/** Rows are 52 high: the smallest a two-column checklist stays readable at. */
const ROW = 52;

export function PrFilterSheet({ open, onClose, scope, filters, onApply, rows, loaded, searching, hasMore, moreAuthors }: {
  open: boolean;
  onClose: () => void;
  /** What the filters apply to, in words: "Review · acme/orbit". */
  scope: string;
  filters: PrFilters;
  onApply: (f: PrFilters) => void;
  /** Every loaded row, before the state split and the filters. */
  rows: readonly PrSummary[];
  /** The state the loaded rows were asked for. */
  loaded: StateView;
  searching: boolean;
  hasMore: boolean;
  /** The repository's contributors, read on demand (5 GitHub reads, cached). */
  moreAuthors: () => Promise<string[]>;
}): React.ReactNode {
  const [draft, setDraft] = useState<PrFilters>(filters);
  const [page, setPage] = useState<"filters" | "author">("filters");
  const [extra, setExtra] = useState<string[]>([]);
  const [asking, setAsking] = useState(false);
  // Each opening starts from what is applied, not from the last abandoned draft.
  useEffect(() => { if (open) { setDraft(filters); setPage("filters"); } }, [open, filters]);

  const { statuses, none } = cardStatusOptions(rows);
  const n = shownCount(rows, draft, loaded, searching);
  const set = (p: Partial<PrFilters>): void => setDraft((d) => ({ ...d, ...p }));
  const state = effectiveState(draft, searching);
  const people = authorOptions(rows, [...extra, ...draft.authors]);

  const footer = (
    <>
      <Btn label="Reset" onPress={() => setDraft(NO_FILTERS)} style={{ minHeight: 48, minWidth: 96 }} />
      <Btn
        tone="primary"
        label={n === null ? "Show pull requests" : `Show ${n} pull request${n === 1 ? "" : "s"}`}
        onPress={() => { onApply(draft); onClose(); }}
        style={{ minHeight: 48, flex: 1 }}
      />
    </>
  );

  const authorPage = (
    <>
      <Pressable
        accessibilityRole="button" accessibilityLabel="Back to filters" onPress={() => setPage("filters")}
        style={{ minHeight: 48, flexDirection: "row", alignItems: "center", gap: SPACE.sm }}
      >
        <View style={{ transform: [{ rotate: "90deg" }] }}><Glyph name="down" color={C.primary} size={18} /></View>
        <Text style={{ color: C.primary, fontSize: T.body, fontWeight: "600" }}>Filters</Text>
      </Pressable>
      <View style={{ gap: SPACE.sm }}>
        {people.map((a) => {
          const on = draft.authors.includes(a.login);
          return (
            <Pressable
              key={a.login} accessibilityRole="checkbox" accessibilityState={{ checked: on }}
              accessibilityLabel={`${a.login}, ${a.count}`}
              onPress={() => set({ authors: toggled(draft.authors, a.login) })}
              style={({ pressed }) => ({
                minHeight: ROW, flexDirection: "row", alignItems: "center", gap: SPACE.md, paddingHorizontal: SPACE.md,
                borderRadius: RADIUS.md, borderWidth: 1, borderColor: on ? C.primary : C.border,
                backgroundColor: on ? tint(C.primary, 0.12) : C.bg2, opacity: pressed ? 0.7 : 1,
              })}
            >
              <CheckBox on={on} />
              <Avatar name={a.login} login={a.login} size={AVATAR.sheet} />
              <Text numberOfLines={1} style={{ flex: 1, color: C.text, fontSize: T.body, fontWeight: on ? "700" : "500" }}>{a.login}</Text>
              <Text style={{ color: C.text3, fontSize: T.small, fontVariant: ["tabular-nums"] }}>{a.count}</Text>
            </Pressable>
          );
        })}
        <Btn
          label="Everyone in the repository" busy={asking}
          onPress={() => { setAsking(true); void moreAuthors().then(setExtra).finally(() => setAsking(false)); }}
          style={{ minHeight: 48 }}
        />
        <Note>The people above wrote the pull requests loaded so far. The button reads the repository's contributors once (5 GitHub reads).</Note>
      </View>
    </>
  );

  const filtersPage = (
    <View style={{ gap: SPACE.lg, paddingBottom: SPACE.md }}>
      {/* First, because the card is what a pull request is FOR; only drawn
          when a loaded row has one, so nobody without a tracker sees it. */}
      {statuses.length ? (
        <View style={{ gap: SPACE.sm }}>
          <Label text="ClickUp card status · from the loaded rows" />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACE.sm }}>
            {statuses.map((s) => (
              <CheckItem
                key={s.status} label={s.status} count={s.count} on={draft.cardStatus.includes(s.status)}
                onPress={() => set({ cardStatus: toggled(draft.cardStatus, s.status) })}
              />
            ))}
            <CheckItem label="No card" count={none} on={draft.noCard} onPress={() => set({ noCard: !draft.noCard })} />
          </View>
        </View>
      ) : null}
      <View style={{ gap: SPACE.sm }}>
        <Label text="State" />
        <Segmented
          value={state} onChange={(id) => set({ state: id })}
          options={STATE_VIEWS.map((id) => ({ id, label: STATE_LABEL[id] }))}
        />
      </View>
      <View style={{ gap: SPACE.sm }}>
        <Label text="Review" />
        <Segmented value={draft.review} onChange={(review) => set({ review })} options={REVIEW_SELS} />
      </View>
      <View style={{ gap: SPACE.sm }}>
        <Label text="Checks" />
        <Segmented value={draft.checks} onChange={(checks) => set({ checks })} options={CHECKS_SELS} />
      </View>
      <View style={{ gap: SPACE.sm }}>
        <Label text="Draft" />
        <Segmented value={draft.draft} onChange={(d) => set({ draft: d })} options={DRAFT_SELS} />
      </View>
      <Pressable
        accessibilityRole="button" accessibilityLabel={`Author, ${draft.authors.length ? draft.authors.join(", ") : "anyone"}`}
        onPress={() => setPage("author")}
        style={({ pressed }) => ({
          minHeight: ROW, flexDirection: "row", alignItems: "center", gap: SPACE.md, paddingHorizontal: SPACE.md,
          borderRadius: RADIUS.md, borderWidth: 1, borderColor: C.border, backgroundColor: C.bg2, opacity: pressed ? 0.7 : 1,
        })}
      >
        <Glyph name="people" color={C.text2} size={20} />
        <View style={{ flex: 1 }}>
          <Text style={{ color: C.text, fontSize: T.body, fontWeight: "600" }}>Author</Text>
          <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.small }}>
            {draft.authors.length ? draft.authors.join(", ") : "Anyone"}
          </Text>
        </View>
        <View style={{ transform: [{ rotate: "-90deg" }] }}><Glyph name="down" color={C.text3} size={18} /></View>
      </Pressable>
      {hasMore ? <Note>Filters narrow the pull requests loaded so far. “Load more” on the list widens them.</Note> : null}
    </View>
  );

  /* One sheet for both pages: a second Modal would slide up again on every
     drill, and the footer is the same in both. */
  return (
    <Sheet
      open={open} onClose={onClose} tall footer={footer}
      title={page === "author" ? "Author" : "Filters"}
      subtitle={page === "author" ? scope : `Applies to ${scope}`}
    >
      {page === "author" ? authorPage : filtersPage}
    </Sheet>
  );
}
