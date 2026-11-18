/*
 * The Jira board in the Tasks tab: four lanes, a jump strip, Mine first, the
 * filter sheet and the states a board can be in.
 *
 * ── what is read, and how often ─────────────────────────────────────────
 * `/jira/views` is the local address book (no request to the site); one
 * `/jira/view?id=` is the board itself. The view's answer carries its rows, its
 * statuses and — when the site gave them — its columns. The four lanes come from
 * `shared/jiraLanes.ts`, which folds whatever number of statuses the site has;
 * this screen never lists a status name of its own.
 *
 * The linked pull requests are ONE extra read per board, not one per card:
 * `/jira/prs?project=` searches GitHub once for the project key and answers a
 * map from card key to its pull requests. It is deliberately not folded into
 * the board read — a repository with no GitHub, or a slow search, must cost the
 * board nothing but its PR line.
 *
 * ── one page is one lane ────────────────────────────────────────────────
 * The strip says which lane, the tab's height is the lane's, and no card is
 * half off the edge: a card dragged between columns on a 360-wide phone is a
 * second, worse way to say what the move sheet says, and the move sheet is the
 * write. The strip carries the counts, so the lane's own title row is not
 * drawn — the mock gives the cards that line back.
 *
 * ── what this screen does not do ────────────────────────────────────────
 * No JQL, no card creation, no epic tree, no work log — the phone's non-goals.
 * No write happens here at all; the card screen owns them.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, RefreshControl, ScrollView, Text, useWindowDimensions, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import type { CardPr, JiraBoardContext, JiraQuickFilter, JiraViewRead, JiraViews, ListStatus, ProviderTask } from "../../../shared/providers.ts";
import type { JiraLane } from "../../../shared/jiraLanes.ts";
import { ask } from "../lib/api.ts";
import { useAgentglass } from "../state/host-context.tsx";
import { usePaletteTick } from "../state/use-palette.ts";
import { openLinkedPr } from "../state/open-pr.ts";
import { boardCards, emptyLaneWords, jiraBoard, type JiraScope } from "../model/jiraBoard.ts";
import { jiraScope, onJiraScope, setJiraScope } from "../notifications/jiraScopePref.ts";
import { activeJiraChips, NO_JIRA_FILTERS, personOn, removeJiraFilter, type JiraFilters } from "../model/jiraFilters.ts";
import { Avatar } from "../Avatar.tsx";
import { Glyph } from "../nav/glyphs.tsx";
import { Note, Segmented, Sheet, SheetRow, TAP } from "../ui.tsx";
import { C, MONO, RADIUS, SPACE, T, tint } from "../theme.ts";
import { FilterChip, SourcePill, TasksTop, type TopMenuItem } from "../tasks/TasksTop.tsx";
import { JiraFiltersSheet } from "./Filters.tsx";
import { JiraState } from "./States.tsx";

type Phase = "reading" | "ready" | "no-account" | "no-source" | "offline";

/** The lane width: the phone's width, less the screen's own inset, so a swipe
 *  pages one column at a time and no card is half off the edge. */
const LANE_INSET = SPACE.md;

const keyOf = (c: ProviderTask): string => c.customId ?? c.id;

/** The type's mark: a letter, in the colour this app already gives that kind
 *  of work. The letter is the site's own word's first letter, not a map of
 *  Jira's six issue types — a site may have any number of them. */
function typeMark(type: string | undefined): { letter: string; ink: string } {
  const t = (type ?? "").trim();
  if (!t) return { letter: "·", ink: C.text3 };
  const lower = t.toLowerCase();
  const ink = lower === "bug" ? C.error : lower === "story" ? C.primary : lower === "epic" ? C.warning : C.text2;
  return { letter: t[0]!.toUpperCase(), ink };
}

function priorityInk(p: ProviderTask["priority"]): string {
  return p === "urgent" ? C.error : p === "high" ? C.warning : p === "low" ? C.text4 : C.text3;
}

/** A pull request's line on a card, in the colour of what it is doing: green,
 *  amber for part of a run, red for failing — the one fact a thumb reads
 *  without opening anything. */
function prLine(pr: CardPr): { ink: string; word: string } {
  const state = pr.state.toUpperCase();
  if (state === "CLOSED") return { ink: C.error, word: "closed" };
  if (state === "MERGED") return { ink: C.primary, word: "merged" };
  if (pr.draft) return { ink: C.text3, word: "draft" };
  return { ink: C.success, word: "open" };
}

function BoardCard({ card, prs, onOpen, onPr }: {
  card: ProviderTask;
  prs: CardPr[] | undefined;
  onOpen: () => void;
  onPr: (pr: CardPr) => void;
}): React.ReactNode {
  const key = keyOf(card);
  const mark = typeMark(card.issueType);
  const who = personOn(card);
  const first = prs?.[0];
  const line = first ? prLine(first) : null;
  return (
    <Pressable
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={[
        key, card.title, card.issueType, card.priority, who ?? "unassigned",
        first ? `pull request ${first.number} ${first.state.toLowerCase()}` : "no pull request",
      ].filter(Boolean).join(", ")}
      style={({ pressed }) => ({
        backgroundColor: pressed ? C.bg3 : C.bg2, borderWidth: 1, borderColor: C.border,
        borderRadius: RADIUS.lg, paddingVertical: SPACE.sm, paddingHorizontal: SPACE.md, gap: 6,
        // A card of yours wears the accent down its left edge, as the mock's
        // does: it is the one thing on the board that is about you.
        ...(card.mine ? { borderLeftWidth: 3, borderLeftColor: tint(C.primary, 0.55) } : null),
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <View style={{
          width: 18, height: 18, borderRadius: 5, alignItems: "center", justifyContent: "center",
          backgroundColor: tint(mark.ink, 0.16),
        }}>
          <Text style={{ color: mark.ink, fontSize: 10, fontWeight: "700" }}>{mark.letter}</Text>
        </View>
        <Text style={{ color: C.text3, fontSize: T.small, fontFamily: MONO, fontWeight: "600" }}>{key}</Text>
        <View style={{ flex: 1 }} />
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: priorityInk(card.priority) }} />
          <Text style={{ color: priorityInk(card.priority), fontSize: T.small, fontWeight: "600" }}>
            {card.priority ? card.priority[0]!.toUpperCase() + card.priority.slice(1) : "—"}
          </Text>
        </View>
      </View>
      <Text numberOfLines={2} style={{ color: C.text, fontSize: 15, fontWeight: "600", lineHeight: 20 }}>
        {card.title}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        {who ? <Avatar name={who} initials={card.people?.find((p) => p.name === who)?.initials} size={22} /> : null}
        <Text numberOfLines={1} style={{ color: who ? C.text2 : C.text3, fontSize: T.small, flexShrink: 1 }}>
          {who ?? "unassigned"}
        </Text>
        <View style={{ flex: 1 }} />
        {first && line ? (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={`Open pull request ${first.number}`}
            onPress={() => onPr(first)}
            hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
            style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
          >
            <Glyph name="pr" color={line.ink} size={13} />
            <Text style={{ color: line.ink, fontSize: T.small, fontWeight: "600" }}>#{first.number}</Text>
            <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: line.ink }} />
            <Text style={{ color: line.ink, fontSize: T.eyebrow, fontWeight: "700" }}>{line.word}</Text>
          </Pressable>
        ) : (
          <Text style={{ color: C.text4, fontSize: T.small }}>no PR</Text>
        )}
      </View>
    </Pressable>
  );
}

export function JiraTasks({ onOtherSource, initialQuery = "", onSourcing }: {
  /** The source that always works, for the no-board state's one control. */
  onOtherSource: () => void;
  /** A card id handed over from a pull request's chip: it opens as the search,
   *  the same way the tracker list's search works. */
  initialQuery?: string;
  /** The sheet that says which sources this tab reads — the menu's one door to
   *  it, since the board's own header has no pill. */
  onSourcing: () => void;
}): React.ReactNode {
  usePaletteTick();
  const { host } = useAgentglass();
  const router = useRouter();
  const { width } = useWindowDimensions();
  // A page is the screen: `pagingEnabled` moves by the list's own width, and an
  // item narrower than that drifts a little further off with every swipe. The
  // lane's inset is padding INSIDE the page, not the page's width.
  const page = Math.max(280, width);

  const [views, setViews] = useState<JiraViews | null>(null);
  const [viewId, setViewId] = useState<string | null>(null);
  const [read, setRead] = useState<JiraViewRead | null>(null);
  const [phase, setPhase] = useState<Phase>("reading");
  const [error, setError] = useState<string | null>(null);
  const [pulling, setPulling] = useState(false);
  // The chip on a pull request hands its card id over as `?q=`; it lands in the
  // search box rather than in a sticky mode, so clearing it is typing.
  const [filters, setFilters] = useState<JiraFilters>(() =>
    initialQuery ? { ...NO_JIRA_FILTERS, text: initialQuery } : NO_JIRA_FILTERS);
  const [scope, setScope] = useState<JiraScope>(jiraScope);
  useEffect(() => { setScope(jiraScope()); return onJiraScope(() => setScope(jiraScope())); }, []);
  const [filtering, setFiltering] = useState(false);
  const [picking, setPicking] = useState(false);
  const [prs, setPrs] = useState<Record<string, CardPr[]>>({});
  /* The board's own quick filters are the one filter the DESKTOP sends to the
     server (`jiraView(id, { filters })`), so the card set is the server's, not
     a phone-side guess. Their ids go with the read; text, assignee, status and
     type narrow the rows afterwards, as they do on the desktop. */
  const [quickAll, setQuickAll] = useState<JiraQuickFilter[]>([]);
  const [quickOn, setQuickOn] = useState<string[]>([]);
  const [lane, setLane] = useState(0);
  /* The search field is the header's, and it starts open when a card id was
     handed over: a query somebody else typed has to be readable and clearable. */
  const [searching, setSearching] = useState(!!initialQuery);
  /* The first focus is the mount read below. A later one is a return from a
     card, which may have been moved, so the board is read again; the server
     holds a view for a minute, so a quick return costs nothing. */
  const focused = useRef<string | null>(null);

  const pager = useRef<FlatList<JiraLane>>(null);

  /* One read of the address book. `connected: false` is the computer having no
   * Jira sign-in — a state of its own, not a failure of this screen. */
  const loadViews = useCallback(async (): Promise<void> => {
    if (!host) return;
    const answer = await ask<JiraViews>(host, "/jira/views");
    if (!answer.ok) { setPhase("offline"); setError(answer.error); return; }
    setViews(answer.value);
    if (!answer.value.connected) { setPhase("no-account"); return; }
    if (!answer.value.views.length) { setPhase("no-source"); return; }
    setViewId((was) => was ?? answer.value.current ?? answer.value.views[0]?.id ?? null);
  }, [host]);

  useEffect(() => { void loadViews(); }, [loadViews]);

  useEffect(() => {
    setViews(null); setViewId(null); setRead(null); setPrs({}); setPhase("reading"); setError(null);
    setFilters(NO_JIRA_FILTERS); setLane(0); setSearching(false); setQuickAll([]); setQuickOn([]);
  }, [host?.origin]);

  /* A card id handed over later — the tab is already mounted when a chip is
     tapped — becomes the search; an empty one changes nothing. */
  useEffect(() => {
    if (initialQuery) { setFilters((f) => ({ ...f, text: initialQuery })); setSearching(true); }
  }, [initialQuery]);

  /* Only the newest board read may land; a slow answer for the view just left
     would replace the one on screen. */
  const asked = useRef(0);
  const load = useCallback(async (force = false): Promise<void> => {
    const mine = ++asked.current;
    if (!host || !viewId) return;
    const answer = await ask<JiraViewRead>(host, `/jira/view?id=${encodeURIComponent(viewId)}${force ? "&force=1" : ""}${quickOn.length ? `&filters=${encodeURIComponent(quickOn.join(","))}` : ""}`);
    if (mine !== asked.current) return;
    if (!answer.ok) {
      // A transport failure keeps the rows already on screen and says so.
      setPhase("offline"); setError(answer.error); return;
    }
    const value = answer.value;
    setRead(value);
    if (!value.ok) {
      if (value.unauthorised) { setPhase("no-account"); return; }
      setPhase("offline"); setError(value.error ?? "Jira did not answer"); return;
    }
    setPhase("ready"); setError(null);
  }, [host, viewId, quickOn]);

  /* The quick filters are the board's, read once per view; a board with none
     (a saved search) answers an empty list and the sheet shows no such row. */
  useEffect(() => {
    setQuickAll([]); setQuickOn([]);
    if (!host || !viewId) return;
    let gone = false;
    void ask<JiraBoardContext>(host, `/jira/board-context?id=${encodeURIComponent(viewId)}`)
      .then((a) => { if (!gone && a.ok && a.value.ok) setQuickAll(a.value.filters); });
    return () => { gone = true; };
  }, [host, viewId]);

  useEffect(() => { setRead(null); setError(null); void load(); }, [load]);

  /* One GitHub search for the whole board, and a failure costs only the PR
   * line: the board is still the board. */
  const project = read?.tasks.find((t) => t.listId)?.listId ?? null;
  useEffect(() => {
    if (!host || !project || phase !== "ready") return;
    let gone = false;
    void ask<{ ok: boolean; byCard?: Record<string, CardPr[]> }>(host, `/jira/prs?project=${encodeURIComponent(project)}`)
      .then((a) => { if (!gone && a.ok && a.value.byCard) setPrs(a.value.byCard); });
    return () => { gone = true; };
  }, [host, project, phase, read?.at]);

  useFocusEffect(useCallback(() => {
    if (!viewId) return;
    if (focused.current !== viewId) { focused.current = viewId; return; }
    void load();
  }, [viewId, load]));

  const onRefresh = useCallback((): void => {
    setPulling(true);
    void Promise.all([load(true), loadViews()]).finally(() => setPulling(false));
  }, [load, loadViews]);

  const statuses: ListStatus[] = useMemo(() => read?.statuses ?? [], [read]);
  // A board column holds cards, not their sub-tasks: a sub-task is a step of
  // the card above it, and drawing it as a card doubles the work. The site's
  // own word for the kind is the only portable test (a Story also has a
  // `parent` — its epic — so that field cannot be the test).
  const cards = useMemo(() => boardCards(read?.tasks ?? []), [read]);
  const board = useMemo(() => jiraBoard(statuses, cards, filters, scope), [statuses, cards, filters, scope]);
  const view = views?.views.find((v) => v.id === viewId) ?? read?.view;
  const boardName = view?.name || "This board";
  const at = read?.at ?? 0;

  const open = useCallback((card: ProviderTask): void => {
    router.push({ pathname: "/jira/[key]", params: { key: keyOf(card) } });
  }, [router]);

  const openPr = useCallback((pr: CardPr): void => {
    if (host) void openLinkedPr(host, router, pr.url);
  }, [host, router]);

  const jump = (index: number): void => {
    setLane(index);
    pager.current?.scrollToIndex({ index, animated: true });
  };

  /* A page is the width, so the list's pixel offset means a different lane
     after a rotate: the strip would light one lane and the pager show another.
     Put the same lane back rather than trusting the offset. */
  const laidOut = useRef(page);
  useEffect(() => {
    if (laidOut.current === page) return;
    laidOut.current = page;
    if (lane < board.lanes.length) pager.current?.scrollToIndex({ index: lane, animated: false });
  }, [page, lane, board.lanes.length]);

  const menu: TopMenuItem[] = [
    { key: "source", label: "Where the cards come from", icon: "list", note: "Jira", onPress: onSourcing },
    { key: "refresh", label: "Read the board again", icon: "refresh", onPress: () => { void load(true); } },
    ...(views?.views.length ? [{
      key: "board", label: "This board", icon: "grid" as const, note: boardName, onPress: () => setPicking(true),
    }] : []),
    { key: "settings", label: "Settings", icon: "sliders", gap: true, onPress: () => router.push("/settings") },
  ];

  const header = (
    <TasksTop
      search={filters.text}
      onSearch={(text) => setFilters((f) => ({ ...f, text }))}
      searching={searching}
      onCloseSearch={() => setSearching(false)}
      onFilter={() => setFiltering(true)}
      filterOn={board.active > 0 || quickOn.length > 0}
      items={menu}
      note={read?.cached ? "Showing the last read kept on this phone." : at ? `Read at ${clock(at)}.` : undefined}
    />
  );

  const unready = phase === "no-account" ? (
    <JiraState kind="no-account" board={boardName} onSettings={() => router.push("/trackers")} />
  ) : phase === "no-source" ? (
    <JiraState kind="no-source" board="Jira" onIssues={onOtherSource} />
  ) : !read && (phase === "reading" || !viewId) ? (
    <JiraState kind="loading" board={boardName} onRetry={() => { void load(true); }} />
  ) : !read ? (
    <JiraState kind="offline" board={boardName} error={error} onRetry={() => { void load(true); }} />
  ) : phase === "offline" && !read.tasks.length ? (
    <JiraState kind="offline" board={boardName} at={at} error={error} onRetry={() => { void load(true); }} />
  ) : null;

  if (!host) return null;
  if (unready) {
    return (
      <View style={{ flex: 1 }}>
        {header}
        <View style={{ paddingHorizontal: SPACE.sm, paddingTop: SPACE.md }}>
          <SourcePill title={boardName} icon="list" onPress={() => setPicking(true)} />
        </View>
        {unready}
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      {header}

      {/* The lanes, as the strip: the name, its count, and the accent under the
          one on screen. A strip and not a row of pills — a pill fills its face
          on selection and there are four of them, which is four coloured boxes
          above a board that is already four lanes. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        accessibilityRole="tablist"
        accessibilityLabel={`Statuses on ${boardName}`}
        style={{ flexGrow: 0, flexShrink: 0, borderBottomWidth: 1, borderBottomColor: C.border }}
        contentContainerStyle={{ paddingHorizontal: SPACE.xs }}
      >
        {board.lanes.map((l, i) => {
          const on = i === lane;
          return (
            <Pressable
              key={l.id}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              accessibilityLabel={`${l.name}, ${l.cards.length} ${l.cards.length === 1 ? "card" : "cards"}`}
              onPress={() => jump(i)}
              style={{ minHeight: TAP, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: SPACE.md }}
            >
              <Text style={{ color: on ? C.text : C.text3, fontSize: T.small, fontWeight: "600" }}>
                {l.name}
              </Text>
              <Text style={{ color: on ? C.primary : C.text4, fontSize: T.small, fontWeight: "700" }}>
                {l.cards.length}
              </Text>
              <View style={{
                position: "absolute", left: 9, right: 9, bottom: 0, height: 2, borderRadius: 1,
                backgroundColor: on ? C.primary : "transparent",
              }} />
            </Pressable>
          );
        })}
      </ScrollView>

      {/* Whose cards: one visible switch, as on the PR board, always drawn and
          remembered on this phone. The filters in force follow it. */}
      <View style={{ paddingHorizontal: SPACE.sm, paddingTop: SPACE.sm }}>
        <Segmented
          options={[{ id: "mine", label: "Mine", count: board.mine }, { id: "everyone", label: "Everyone", count: board.total }]}
          value={scope}
          onChange={setJiraScope}
        />
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        accessibilityLabel="Filters in force"
        style={{ flexGrow: 0, flexShrink: 0 }}
        contentContainerStyle={{ alignItems: "center", gap: 6, paddingHorizontal: SPACE.sm, paddingVertical: SPACE.sm }}
      >
        {activeJiraChips(filters).map((chip) => (
          <FilterChip
            key={chip.id}
            label={chip.label}
            on
            onPress={() => setFilters(removeJiraFilter(filters, chip.id))}
          />
        ))}
        <FilterChip label="Filter" add onPress={() => setFiltering(true)} />
      </ScrollView>

      {error ? (
        <View style={{ paddingHorizontal: SPACE.md, paddingBottom: SPACE.sm }}>
          <Note tone="bad">
            {error} Showing the last read already on this phone; moving a card waits for the computer.
          </Note>
        </View>
      ) : null}

      {board.shown === 0 && board.active > 0 ? (
        <JiraState kind="empty" board={boardName} filters onClear={() => setFilters(NO_JIRA_FILTERS)} />
      ) : (
        <FlatList
          ref={pager}
          data={board.lanes}
          horizontal
          pagingEnabled
          keyExtractor={(l) => l.id}
          showsHorizontalScrollIndicator={false}
          getItemLayout={(_, i) => ({ length: page, offset: page * i, index: i })}
          onMomentumScrollEnd={(e) => setLane(Math.round(e.nativeEvent.contentOffset.x / page))}
          style={{ flex: 1 }}
          renderItem={({ item }) => (
            <View style={{ width: page }}>
              <ScrollView
                contentContainerStyle={{ paddingHorizontal: LANE_INSET, paddingTop: SPACE.sm, paddingBottom: SPACE.xl, gap: 6 }}
                refreshControl={<RefreshControl refreshing={pulling} onRefresh={onRefresh} tintColor={C.text3} />}
              >
                {item.cards.map((card) => (
                  <BoardCard
                    key={keyOf(card)}
                    card={card}
                    prs={prs[keyOf(card)]}
                    onOpen={() => open(card)}
                    onPr={openPr}
                  />
                ))}
                {item.cards.length ? null : (
                  <Text style={{ color: C.text3, fontSize: T.small, paddingVertical: SPACE.lg, textAlign: "center" }}>
                    {emptyLaneWords(filters)}
                  </Text>
                )}
              </ScrollView>
            </View>
          )}
        />
      )}

      <JiraFiltersSheet
        open={filtering}
        onClose={() => setFiltering(false)}
        cards={cards}
        filters={filters}
        statusOrder={statuses.map((s) => s.status)}
        onChange={setFilters}
        quick={quickAll}
        quickOn={quickOn}
        onQuick={setQuickOn}
      />

      <Sheet open={picking} onClose={() => setPicking(false)} title="This board" subtitle="Saved on the computer; the cards below change with it">
        {(views?.views ?? []).map((v) => (
          <SheetRow
            key={v.id}
            label={v.name}
            sub={v.id === read?.view?.id ? "Open now" : "Read when you pick it"}
            on={v.id === viewId}
            onPress={() => { setViewId(v.id); setPicking(false); setFilters(NO_JIRA_FILTERS); }}
          />
        ))}
        {views && views.views.length === 0 ? (
          <SheetRow label="No board saved" sub="Add one in the app on the computer." disabled onPress={() => {}} />
        ) : null}
      </Sheet>
    </View>
  );
}

/** The board's read, as a clock in the phone's own day: "Read at 09:12." */
function clock(at: number): string {
  const d = new Date(at);
  if (!Number.isFinite(d.getTime()) || at <= 0) return "";
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}
