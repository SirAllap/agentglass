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
import { Btn, CheckBox, CheckItem, Chip, Label, Note, Segmented, Sheet, Switch, TAP } from "../ui.tsx";
import {
  activeChips, authorOptions, cardStatusOptions, CHECKS_SELS, DRAFT_SELS, effectiveState, NO_FILTERS,
  REVIEW_SELS, shownCount, toggled, type PrFilters,
} from "../model/prFilters.ts";
import type { LaneRules } from "../model/prBoard.ts";
import type { PrView } from "../../../shared/prFilter.ts";
import type { ViewsCondition } from "../state/pr-views.ts";
import { STATE_LABEL, STATE_VIEWS, type StateView } from "../model/prState.ts";
import { C, RADIUS, SPACE, T, tint } from "../theme.ts";

/** Rows are 52 high: the smallest a two-column checklist stays readable at. */
const ROW = 52;

export function PrFilterSheet({ open, onClose, scope, filters, onApply, rows, loaded, searching, hasMore, moreAuthors, rules, onRules, views, viewsCondition, onRetryViews, activeMissing, hiddenByView, viewId, onView, everyone, onEveryone }: {
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
  /** What the board hides by default. Edited here rather than in a sheet of
   *  its own: a rule and a filter are the same sentence to the person writing
   *  one, and the mock keeps them on one page (screen 30). */
  rules: LaneRules;
  onRules: (next: LaneRules) => void;
  /** The views the computer holds for this repository, with the board each one
   *  counts (mock 30's "Views" row). The phone inherits them; it does not make
   *  or edit them. */
  views?: { view: PrView; count: number }[];
  /** What the read produced: loading, ready, empty and failed say different things. */
  viewsCondition?: ViewsCondition;
  onRetryViews?: () => void;
  /** This phone's view was removed on the desk. */
  activeMissing?: boolean;
  /** Rows the active view keeps out, so the phone says what it is not drawing. */
  hiddenByView?: number;
  viewId?: string;
  onView?: (next: PrView) => void;
  /** Everyone's pull requests on the board, or only the ones that are yours
   *  to act on (mock 30's switch). */
  everyone: boolean;
  onEveryone: (next: boolean) => void;
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
  const ruleCount = Object.values(rules).filter(Boolean).length;

  const footer = (
    <View style={{ flex: 1, gap: SPACE.sm }}>
      <Btn
        tone="primary"
        label={n === null ? "Show pull requests" : `Show ${n} pull request${n === 1 ? "" : "s"}`}
        onPress={() => { onApply(draft); onClose(); }}
        style={{ minHeight: 48 }}
      />
      <Btn
        label={ruleCount ? `Clear the ${ruleCount} rule${ruleCount === 1 ? "" : "s"}` : "Reset"}
        onPress={() => {
          if (ruleCount) onRules({ drafts: false, bots: false });
          else setDraft(NO_FILTERS);
        }}
        style={{ minHeight: 48 }}
      />
    </View>
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
      {/* What is on, as tokens, above the controls that set it — the mock's
          query row (30), in the app's own words. There is no `is:conflict`
          grammar here, so these are drawn as the facets read and the controls
          below are what changes them. */}
      {activeChips(draft, (s) => STATE_LABEL[s]).length ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {activeChips(draft, (s) => STATE_LABEL[s]).map((c) => <Chip key={c.id} label={c.label} />)}
        </View>
      ) : null}

      {/* The state split first, as the mock's screen 30 has it: it is the one
          choice that changes what the rest counts. */}
      <View style={{ gap: SPACE.sm }}>
        <Segmented
          value={state} onChange={(id) => set({ state: id })}
          options={STATE_VIEWS.map((id) => ({ id, label: STATE_LABEL[id] }))}
        />
      </View>

      {/* Then the views: a view is what the rest of this sheet is about, and
          picking one is applying it. A read that is still running, one that
          found nothing, and one that failed are three different sentences; no
          chips for all three is what made a failed read look like an empty file. */}
      {views?.length || viewsCondition ? (
        <View style={{ gap: SPACE.sm }}>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <Label text="Views" />
            <View style={{ flex: 1 }} />
            <Text style={{ color: C.text3, fontSize: T.small }}>saved with this repository</Text>
          </View>
          {/* The line sits above the chips too: a forced read over a held list
              is still a read running, and the chips under it are the old ones. */}
          {viewsCondition === "loading" || viewsCondition === "idle" ? (
            <Note>Reading this repository’s views…</Note>
          ) : null}
          {viewsCondition === "failed" ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="the views could not be read, try again"
              onPress={() => onRetryViews?.()}
              style={({ pressed }) => ({
                minHeight: TAP, flexDirection: "row", alignItems: "center", gap: SPACE.sm,
                paddingHorizontal: SPACE.md, borderRadius: 12, borderWidth: 1, borderColor: C.border,
                backgroundColor: C.bg2, opacity: pressed ? 0.7 : 1,
              })}
            >
              <Text style={{ flex: 1, color: C.text2, fontSize: T.small }}>the views could not be read · try again</Text>
              <Glyph name="refresh" color={C.text2} size={16} />
            </Pressable>
          ) : null}
          {viewsCondition === "empty" ? <Note>The desk has not saved a view for this repository.</Note> : null}
          {views?.length ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACE.sm }}>
              {views.map(({ view: v, count }) => {
                const on = v.id === viewId;
                return (
                  <Pressable
                    key={v.id}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                    accessibilityLabel={`${v.name}, ${count} pull request${count === 1 ? "" : "s"}`}
                    onPress={() => { onView?.(v); onClose(); }}
                    style={({ pressed }) => ({
                      minHeight: TAP, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: SPACE.md,
                      borderRadius: 12, borderWidth: on ? 0 : 1, borderColor: C.border,
                      backgroundColor: on ? tint(C.primary, 0.14) : C.bg2, opacity: pressed ? 0.7 : 1,
                    })}
                  >
                    <Text style={{ color: on ? C.primary : C.text2, fontSize: T.small, fontWeight: "600" }}>{v.name}</Text>
                    <Text style={{ color: on ? C.primary : C.text4, fontSize: T.small, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{count}</Text>
                  </Pressable>
                );
              })}
            </View>
          ) : null}
          {activeMissing ? (
            <Note>The view this phone had on is no longer saved on the desk.</Note>
          ) : null}
          {hiddenByView ? (
            <Note>
              {hiddenByView} pull request{hiddenByView === 1 ? "" : "s"} hidden by this view. The desk’s drawer can show them.
            </Note>
          ) : null}
        </View>
      ) : null}

      {/* The board's own rules, on the same page as the filters: a rule and a
          filter are the same sentence to the person writing one (mock 30). */}
      <View style={{ gap: SPACE.sm }}>
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <Label text="Hide" />
          <View style={{ flex: 1 }} />
          <Text style={{ color: C.text3, fontSize: T.small }}>
            {ruleCount} rule{ruleCount === 1 ? "" : "s"}
          </Text>
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACE.sm }}>
          {(["drafts", "bots"] as const).map((k) => {
            const on = rules[k];
            return (
              <Pressable
                key={k}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                accessibilityLabel={`${on ? "Stop hiding" : "Hide"} ${k}`}
                onPress={() => onRules({ ...rules, [k]: !on })}
                style={({ pressed }) => ({
                  minHeight: TAP, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: SPACE.md,
                  borderRadius: 12, borderWidth: 1,
                  borderColor: on ? C.border : C.border2,
                  borderStyle: on ? "solid" : "dashed",
                  backgroundColor: on ? C.bg3 : "transparent",
                  opacity: pressed ? 0.7 : 1,
                })}
              >
                <Text style={{ color: on ? C.text2 : C.text3, fontSize: T.small, fontWeight: "600" }}>
                  {k === "drafts" ? "Drafts" : "Bots"}
                </Text>
                <Glyph name={on ? "close" : "plus"} color={on ? C.text3 : C.text4} size={13} weight={2} />
              </Pressable>
            );
          })}
        </View>
      </View>

      <View style={{ gap: SPACE.sm }}>
        <Label text="Show only" />
      </View>
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

      {/* Whose pull requests the board is about. On is the mock's default and
          the one that makes five lanes worth filing: off leaves only the rows
          that are yours to act on. */}
      <Pressable
        accessibilityRole="switch"
        accessibilityState={{ checked: everyone }}
        accessibilityLabel="Show everyone’s PRs"
        onPress={() => onEveryone(!everyone)}
        style={({ pressed }) => ({
          flexDirection: "row", alignItems: "center", gap: SPACE.md, paddingVertical: SPACE.sm,
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: C.text, fontSize: 14.5, fontWeight: "700" }}>Show everyone’s PRs</Text>
          <Text style={{ color: C.text3, fontSize: T.small, lineHeight: 17 }}>
            Off leaves only the pull requests where you are the author or the reviewer.
          </Text>
        </View>
        <Switch on={everyone} />
      </Pressable>
      <Text style={{ color: C.success, fontSize: T.small, fontWeight: "700", fontVariant: ["tabular-nums"] }}>
        {everyone ? "Everyone’s pull requests" : "Only the ones that are yours"} · {rows.length} loaded
      </Text>

      {hasMore ? <Note>Filters narrow the pull requests loaded so far. “Load more” on the list widens them.</Note> : null}
      <Note>
        <Text style={{ fontWeight: "700", color: C.text2 }}>Every lane keeps its drawer.</Text>
        {" "}A rule takes cards out of the lane, not off the board: the drawer says how many and Peek shows which.
      </Note>
    </View>
  );

  /* One sheet for both pages: a second Modal would slide up again on every
     drill, and the footer is the same in both. */
  return (
    <Sheet
      open={open} onClose={onClose} tall footer={footer}
      title={page === "author" ? "Author" : "Filters and rules"}
      subtitle={page === "author"
        ? scope
        : `${scope}${n === null ? "" : ` · ${n} of ${rows.length} left in`}${ruleCount ? ` · ${ruleCount} hidden by your rules` : ""}`}
    >
      {page === "author" ? authorPage : filtersPage}
    </Sheet>
  );
}
