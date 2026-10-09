/*
 * The cards, from the tracker you actually use.
 *
 * ── which tracker ────────────────────────────────────────────────────────
 * This screen read `/clickup/views` and `/clickup/view` whoever you were. On a
 * machine that tracks work in its own local store it drew an empty board and
 * offered to open cards in a product nobody there used. `useTaskProvider`
 * answers the question the screen should have asked (model/taskProviders.ts
 * has the rule): ClickUp connected is the board below; any other tracker set
 * up is `/tasks/list`, the provider-neutral route, drawn as the local rows in
 * `LocalRow`; nothing set up is said in words.
 *
 * ── the board ────────────────────────────────────────────────────────────
 * The views are the workspace's own — whatever was added on the desk, in the
 * order it was added — because a phone that shows a different slice of the
 * board than the computer is a second place to keep in your head.
 *
 * The board's own tools — the list selector, search, filters, Open/All and the
 * status sections — all run on the cards read once (model/cardBoard.ts): typing
 * and ticking cost the tracker nothing. Only choosing another list reads again.
 *
 * Status is drawn in the colour the workspace gave it and spelled the way the
 * workspace spells it. Renaming somebody's workflow is not ours to do, and a
 * board's colours are how its people read it at a glance. What the app decides
 * for itself is only `statusKind` — open, done, other — because status NAMES
 * are per-list and a workspace may have four words for "doing", so nothing may
 * branch on them.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FlatList, Linking, Pressable, RefreshControl, Text, View } from "react-native";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { ASSIGNED_VIEW_ID, type ClickUpBoards, type ListPlace, type ListStatus, type ProviderTask, type SavedView } from "../../../shared/providers.ts";
import type { LocalTask, TasksListResponse } from "../../../shared/types.ts";
import { ask } from "../../src/lib/api.ts";
import { writes } from "../../src/state/card-cache.ts";
import { withCard } from "../../src/state/card-edits.ts";
import { useCardChanges } from "../../src/state/useCardChanges.ts";
import { useAgentglass } from "../../src/state/host-context.tsx";
import { usePaletteTick } from "../../src/state/use-palette.ts";
import { useTaskProvider } from "../../src/state/use-tracks-work.ts";
import { localMeta, visibleLocal } from "../../src/model/localTasks.ts";
import { projectNames, scopeLocal } from "../../src/model/taskScope.ts";
import { matchesQuery } from "../../../shared/taskref.ts";
import { Btn, Card, Label, ListEmpty, Note, Segmented, groupEdge } from "../../src/ui.tsx";
import { dueIn } from "../../src/lib/dates.ts";
import { BoardHeader } from "../../src/cards/BoardHeader.tsx";
import { CardFilterSheet } from "../../src/cards/CardFilterSheet.tsx";
import { CardRow } from "../../src/cards/CardRow.tsx";
import { ListSheet } from "../../src/cards/ListSheet.tsx";
import { SectionHead } from "../../src/cards/SectionHead.tsx";
import { PrSearchRow } from "../../src/review/PrSearchRow.tsx";
import { useLearnedCardPrs } from "../../src/state/card-links.ts";
import {
  activeFacets, boardCount, cardSections, flatItems, NO_CARD_FILTERS, openAllView, prCount, truncatedNote, whyEmpty, type CardFilters,
} from "../../src/model/cardBoard.ts";
import { boardPath, listTarget } from "../../src/model/cardSelector.ts";
import { C, MONO, RADIUS, SPACE, T } from "../../src/theme.ts";

/*
 * `/clickup/views` answers `ClickUpBoards` — the shared type the server
 * compiles against. This screen used to declare its own three-field copy, and
 * the copy was the type boundary at which `connected`, `folders` and
 * `writeEnabled` fell off: the answer said whether a token existed and the
 * phone could not read it. `current` and `prefix` are optional there, as they
 * always were on the wire.
 */
type ViewsAnswer = ClickUpBoards;

interface ViewTasks {
  tasks: ProviderTask[];
  truncated: boolean;
  /** Every status the list accepts, in its own order — the section order. */
  statuses?: ListStatus[];
  /** Space / Folder / List, for the line above the board's name. */
  place?: ListPlace;
  /** A 200 that carries the failure: the read did not happen, and `tasks` is
   *  empty or the last good list. */
  error?: string;
}

/**
 * One row of the machine's own list. Its own component rather than `Row` with
 * gaps: a local task has a uuid and no url, a project and no list, a letter
 * for priority and no colour, and a row built for the other shape would draw
 * empty chips where those go.
 */
function LocalRow({ task, onCopied }: {
  task: LocalTask;
  onCopied: (what: string) => void;
}): React.ReactNode {
  const when = dueIn(task.due, new Date());
  const meta = localMeta(task);
  const link = task.urls[0];
  return (
    <Pressable
      // A tap opens the task's first link when it has one — the nearest thing
      // a local task has to a page of its own. There is no detail screen to
      // push: the list IS the tracker, and everything it knows is on the row.
      onPress={link ? () => { void Linking.openURL(link); } : undefined}
      onLongPress={() => {
        void Clipboard.setStringAsync(task.uuid);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        onCopied(task.uuid.slice(0, 8));
      }}
    >
      <View style={{ padding: SPACE.lg, gap: SPACE.sm }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
          {/* The short uuid, the way the tool itself prints one. */}
          <Text style={{ color: C.text3, fontSize: T.eyebrow, fontFamily: MONO }}>
            {task.uuid.slice(0, 8)}
          </Text>
          <View style={{ flex: 1 }} />
          {when ? (
            <Text style={{ color: when.late ? C.error : C.text3, fontSize: T.eyebrow }}>{when.text}</Text>
          ) : null}
        </View>

        <Text numberOfLines={4} style={{ color: task.status === "pending" ? C.text : C.text3, fontSize: T.body, lineHeight: 19 }}>
          {task.description}
        </Text>

        {meta.length ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm, flexWrap: "wrap" }}>
            {meta.map((piece, i) => (
              <Text key={`${piece}-${i}`} style={{ color: C.text3, fontSize: T.eyebrow }}>{piece}</Text>
            ))}
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

/** What an empty board says, by what is narrowing it. */
const EMPTY_TEXT = {
  none: "This list has no cards.",
  search: "No card matches what is typed above. Clear the search to see the rest.",
  filters: "No card has this status and assignee. Reset the filters to see the rest.",
  "all-done": "Nothing is still open. The switch above shows the rest.",
} as const;

export default function TasksScreen(): React.ReactNode {
  usePaletteTick(); // a scene repaints only if it asks — see use-palette.ts
  const { host } = useAgentglass();
  const navigation = useNavigation();
  const router = useRouter();
  const [views, setViews] = useState<ViewsAnswer | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [filtering, setFiltering] = useState(false);
  const [tasks, setTasks] = useState<ProviderTask[] | null>(null);
  const [statuses, setStatuses] = useState<ListStatus[]>([]);
  const [place, setPlace] = useState<ListPlace | undefined>(undefined);
  const [truncated, setTruncated] = useState(false);
  /* What the search box says and what the sheet ticked. Both narrow the cards
     already loaded, so neither is a request; both are this board's, so
     choosing another list clears them. */
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<CardFilters>(NO_CARD_FILTERS);
  /* Said under the selector when adding a list did not work; the board on
     screen is then still the one that was. */
  const [notice, setNotice] = useState<string | null>(null);
  const learned = useLearnedCardPrs(host);
  const [local, setLocal] = useState<LocalTask[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pulling, setPulling] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [openOnly, setOpenOnly] = useState(true);
  /* The open project(s) the server was paired for — the same `workspaces`
     every other list here already honours. `null` until asked, and `[]` on an
     unscoped server, where there is no project to be inside of and the switch
     below is not drawn. The tab opens INSIDE the project: a phone paired for
     one project should not start on the whole machine's task store. */
  const [names, setNames] = useState<string[] | null>(null);
  const [everything, setEverything] = useState(false);
  /* Which tracker this machine keeps its work in — the same read the Inbox
     uses to decide whether to offer this screen at all. `undefined` while it
     is in the air, `null` when there is none; either way nothing is fetched
     until it is known, because fetching ClickUp's board on a Taskwarrior
     machine is the bug this screen had. */
  const provider = useTaskProvider(host);
  /*
   * An id handed over from somewhere else — today, the chip on a pull request
   * that names the item it came from.
   *
   * It goes into the search box, which filters what this screen already has
   * rather than asking the tracker, and that is the whole reason it works for
   * everybody: the rows are whatever the connected provider returned, and
   * "every word appears somewhere in the row" is a question that can be asked
   * of a card, a Taskwarrior task, or whatever comes next. Nothing here knows
   * which one it is looking at. The box's own clear button is the way out, and
   * it is typed text rather than a sticky mode, so it cannot still be
   * filtering tomorrow.
   */
  const { q } = useLocalSearchParams<{ q?: string }>();
  useEffect(() => { if (q && q.trim()) setSearch(q.trim()); }, [q]);
  const board = provider?.id === "clickup";
  const localList = !!provider && !board;

  /* Another computer (re-paired, or switched) is another board: nothing chosen
     or read from the old one may be drawn, filtered or searched on the new. */
  const origin = useRef(host?.origin);
  useEffect(() => {
    if (origin.current === host?.origin) return;
    origin.current = host?.origin;
    setViews(null); setChosen(null); setTasks(null); setLocal(null); setStatuses([]); setPlace(undefined);
    setTruncated(false); setError(null); setNotice(null); setFilters(NO_CARD_FILTERS); setSearch("");
  }, [host?.origin]);

  useEffect(() => {
    if (!host || !board) return;
    let gone = false;
    void (async () => {
      const answer = await ask<ViewsAnswer>(host, "/clickup/views");
      if (gone) return;
      if (!answer.ok) { setError(answer.error); return; }
      setViews(answer.value);
      // The card screen asks the same question; it is answered here already.
      writes.put(host.origin, answer.value.writeEnabled === true);
      setChosen((current) => current ?? answer.value.current ?? answer.value.views[0]?.id ?? null);
    })();
    return () => { gone = true; };
  }, [host, board]);

  /* Only the newest read may land: a slow answer for the board you just left
     would otherwise replace the one you are looking at. Every call bumps it,
     including one that returns at once, so a change to "nothing to read" also
     cancels what was in flight. */
  const asked = useRef(0);
  const load = useCallback(async (): Promise<void> => {
    const mine = ++asked.current;
    if (!host) return;
    if (localList) {
      // A failed read of the scope is "no scope", not an error of the list: the
      // rows below are still the machine's, and the switch simply is not there.
      const [scope, answer] = await Promise.all([
        ask<{ workspaces?: string[] }>(host, "/projects"),
        ask<TasksListResponse>(host, "/tasks/list"),
      ]);
      if (mine !== asked.current) return;
      setNames(scope.ok ? projectNames(scope.value.workspaces) : []);
      if (!answer.ok) { setError(answer.error); setLocal([]); return; }
      // The route answers 200 with `ok: false` and `error` when the tool is
      // there and the read failed; `tasks` is then the last good list, kept.
      setError(answer.value.ok ? null : answer.value.error ?? "The task list could not be read.");
      setLocal(Array.isArray(answer.value.tasks) ? answer.value.tasks : []);
      return;
    }
    if (!board || !chosen) return;
    const answer = await ask<ViewTasks>(host, `/clickup/view?id=${encodeURIComponent(chosen)}`);
    if (mine !== asked.current) return;
    if (!answer.ok) { setError(answer.error); setTasks([]); return; }
    setError(answer.value.error ?? null);
    setStatuses(answer.value.statuses ?? []);
    setPlace(answer.value.place);
    setTruncated(!!answer.value.truncated);
    setTasks(Array.isArray(answer.value.tasks) ? answer.value.tasks : []);
  }, [host, board, localList, chosen]);

  useEffect(() => { setTasks(null); setLocal(null); void load(); }, [load]);

  /* A card moved or claimed on its own screen lands here without a refetch —
     the card screen hands the server's answer over (state/card-edits.ts). The
     callback is stable so the subscription is made once. */
  useCardChanges(useCallback((task: ProviderTask) => setTasks((was) => withCard(was, task)), []));

  /* Done cards are the bulk of any board and none of them are work you owe.
     Kept behind the Open / All switch rather than dropped, because "did I
     close that?" is a real question somebody asks from a sofa. */
  const { shown, counts } = useMemo(() => openAllView(tasks ?? [], search, filters, openOnly), [tasks, search, filters, openOnly]);
  const items = useMemo(() => flatItems(cardSections(shown, statuses, filters.group)), [shown, statuses, filters.group]);
  const scoped = !!names?.length && !everything;
  const shownLocal = useMemo(
    () => visibleLocal(scopeLocal(local, scoped ? names ?? [] : []), openOnly)
      .filter((t) => !search.trim() || matchesQuery([t.description, t.project, ...t.tags], search)),
    [local, openOnly, search, scoped, names],
  );

  const onRefresh = useCallback((): void => {
    setPulling(true);
    void load().finally(() => setPulling(false));
  }, [load]);

  const view = views?.views.find((v) => v.id === chosen) ?? null;

  /* The screen is "Cards" on the board, like every destination is its own
     name. On the machine's own list it is the tracker's name, because that is
     what the list IS. Which list is open is the selector under the title: a
     title that is secretly a picker is a control nobody finds. */

  /* Choosing another list: the filters and the search were about the old one. */
  const choose = useCallback((id: string): void => {
    setNotice(null);
    if (id === chosen) return;
    setChosen(id); setFilters(NO_CARD_FILTERS); setSearch("");
  }, [chosen]);

  /* A list from the workspace. One the computer already keeps a board for is
     free; any other is added first, the way the desk's "the list itself" does,
     which is one read of the list from the tracker. */
  const openList = useCallback((listId: string): void => {
    if (!host) return;
    const target = listTarget(listId, views?.views ?? []);
    if ("view" in target) { choose(target.view); return; }
    setNotice(null);
    void ask<{ ok: boolean; error?: string; view?: SavedView }>(host, "/clickup/views/add", { method: "POST", body: { url: target.add } })
      .then((a) => {
        const added = a.ok && a.value.ok ? a.value.view : undefined;
        if (!added) { setNotice(a.ok ? a.value.error ?? "That list could not be opened." : a.error); return; }
        setViews((was) => (was ? { ...was, views: [...was.views.filter((v) => v.id !== added.id), added] } : was));
        choose(added.id);
      });
  }, [host, views, choose]);
  useLayoutEffect(() => {
    navigation.setOptions({ title: board || !provider ? "Cards" : provider.title });
  }, [navigation, board, provider]);

  const cut = board && tasks ? truncatedNote(tasks.length, truncated) : null;

  if (!host) return null;

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      {/* Open / All is a segment, because it was never a filter among filters —
          it is the only two-state thing on the screen, and a chip that toggles
          looks exactly like a chip that selects. Two segments say which of two
          lists you are looking at, and on the board each says how many. */}
      {/* And not drawn over the "no tracker" card: a switch between two views
          of nothing is the filter that card warns people not to go looking for. */}
      {provider !== null ? (
        <View style={{ paddingHorizontal: SPACE.lg, paddingTop: SPACE.md, gap: SPACE.md }}>
          {board ? (
            <>
              <BoardHeader path={boardPath(view ?? undefined, place)} name={view?.name ?? "…"} onPress={() => setPicking(true)} />
              <PrSearchRow
                value={search} onChange={setSearch} active={activeFacets(filters)} onFilters={() => setFiltering(true)}
                placeholder="Search this board" label="Search this board"
              />
            </>
          ) : (
            <PrSearchRow value={search} onChange={setSearch} placeholder="Search this list" label="Search this list" />
          )}
          <Segmented
            value={openOnly ? "open" : "all"}
            onChange={(id) => setOpenOnly(id === "open")}
            options={[
              { id: "open" as const, label: "Open", count: board && tasks ? boardCount(counts.open, truncated) : undefined },
              { id: "all" as const, label: "All", count: board && tasks ? boardCount(counts.all, truncated) : undefined },
            ]}
          />
          {cut ? <Note>{cut}</Note> : null}
          {localList && names?.length ? (
            <Segmented
              value={everything ? "everything" : "project"}
              onChange={(id) => setEverything(id === "everything")}
              options={[
                { id: "project" as const, label: names.join(", ") },
                { id: "everything" as const, label: "Everything" },
              ]}
            />
          ) : null}
          {notice ? <Note tone="bad">{notice}</Note> : null}
        </View>
      ) : null}

      {board ? (
        <>
          <ListSheet
            open={picking} onClose={() => setPicking(false)} host={host} views={views?.views ?? []} current={chosen}
            onBoard={choose} onList={openList}
          />
          <CardFilterSheet
            open={filtering} onClose={() => setFiltering(false)} scope={view?.name ?? "This board"}
            filters={filters} onApply={setFilters} cards={tasks ?? []} statuses={statuses}
            query={search} openOnly={openOnly} truncated={truncated}
          />
        </>
      ) : null}

      {/*
        Three states, where there were two.

        "No board is connected" used to be drawn as "this view has no cards
        that are still open", which asserts two things that are both false on
        a machine with no tracker: that there is a board, and that it is
        empty. Somebody reading it would go looking for a filter.

        `provider === null` is the tracker-less machine, said in words that
        name no product. `undefined` — still asking — draws nothing, because
        the wrong empty state for a second reads as a flash of a lie.
      */}
      {provider === null ? (
        <View style={{ padding: SPACE.lg }}>
          <Card>
            <Label text="No tracker on this computer" />
            <Note>
              Cards come from ClickUp or Taskwarrior, and neither is connected. Connect one on the
              computer and this tab fills in by itself.
            </Note>
            <View style={{ paddingTop: SPACE.sm }}>
              <Btn label="See why in Settings" onPress={() => router.push("/trackers")} />
            </View>
          </Card>
        </View>
      ) : localList ? (
        <FlatList
          data={shownLocal}
          keyExtractor={(task) => task.uuid}
          contentContainerStyle={{ padding: SPACE.lg, paddingBottom: SPACE.xl }}
          refreshControl={<RefreshControl refreshing={pulling} onRefresh={onRefresh} tintColor={C.text3} />}
          ListEmptyComponent={
            local === null ? null : (
              <ListEmpty
                error={error}
                errorTitle="Cannot read the list"
                emptyTitle="Nothing here"
                emptyText={scoped
                  ? "Nothing for this project. Tap Everything above to see the rest of the machine."
                  : "Nothing is still open. The switch above shows the rest."}
                onRetry={() => { void load(); }}
              />
            )
          }
          renderItem={({ item, index }) => (
            <View style={groupEdge(index === 0, index === shownLocal.length - 1)}>
              <LocalRow
                task={item}
                onCopied={(id) => { setSaid(id); setTimeout(() => setSaid(null), 1600); }}
              />
            </View>
          )}
        />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => item.key}
          extraData={learned}
          contentContainerStyle={{ padding: SPACE.lg, paddingTop: SPACE.sm, paddingBottom: SPACE.xl }}
          refreshControl={<RefreshControl refreshing={pulling} onRefresh={onRefresh} tintColor={C.text3} />}
          ListEmptyComponent={
            tasks === null ? null : (
              <ListEmpty
                error={error}
                errorTitle="Cannot read the board"
                emptyTitle="Nothing here"
                emptyText={EMPTY_TEXT[whyEmpty(tasks, search, filters, openOnly) ?? "none"]}
                onRetry={() => { void load(); }}
              />
            )
          }
          renderItem={({ item }) => item.kind === "head" ? (
            <SectionHead label={item.section.label ?? ""} color={item.section.color} count={item.section.cards.length} />
          ) : (
            <View style={{ paddingBottom: SPACE.sm }}>
              <CardRow
                task={item.card}
                prs={prCount(item.card, learned(item.card.id))}
                query={search}
                showList={chosen === ASSIGNED_VIEW_ID}
                onCopied={(id) => { setSaid(id); setTimeout(() => setSaid(null), 1600); }}
                onOpen={() => router.push({ pathname: "/card/[id]", params: { id: item.card.id } })}
              />
            </View>
          )}
        />
      )}

      {/* A snackbar, over the list and above the bar, rather than a strip
          pushed in at the top: the strip moved every row down by its height
          under the thumb that had just long-pressed one of them. */}
      {said ? (
        <View
          accessibilityLiveRegion="polite"
          style={{
            position: "absolute", left: SPACE.lg, right: SPACE.lg, bottom: SPACE.xl + SPACE.lg,
            minHeight: 48, justifyContent: "center", paddingHorizontal: SPACE.lg,
            borderRadius: RADIUS.sm, backgroundColor: C.text,
          }}
        >
          <Text style={{ color: C.bg, fontSize: T.body }}>{said} copied</Text>
        </View>
      ) : null}

      {provider ? (
        <View style={{ paddingHorizontal: SPACE.lg, paddingBottom: SPACE.sm }}>
          <Note>
            {board
              ? "Tap opens the card here. Hold copies its id."
              : "Tap opens a task's link, when it has one. Hold copies its id."}
          </Note>
        </View>
      ) : null}
    </View>
  );
}
