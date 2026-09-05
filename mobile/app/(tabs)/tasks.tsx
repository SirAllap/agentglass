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
 * Status is drawn in the colour the workspace gave it and spelled the way the
 * workspace spells it. Renaming somebody's workflow is not ours to do, and a
 * board's colours are how its people read it at a glance. What the app decides
 * for itself is only `statusKind` — open, done, other — because status NAMES
 * are per-list and a workspace may have four words for "doing", so nothing may
 * branch on them.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { FlatList, Linking, Pressable, RefreshControl, Text, View } from "react-native";
import { useNavigation, useRouter } from "expo-router";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import type { ClickUpBoards, ProviderTask } from "../../../shared/providers.ts";
import type { LocalTask, TasksListResponse } from "../../../shared/types.ts";
import { ask } from "../../src/lib/api.ts";
import { useCardChanges, withCard } from "../../src/state/card-edits.ts";
import { useAgentglass } from "../../src/state/host-context.tsx";
import { usePaletteTick } from "../../src/state/use-palette.ts";
import { useTaskProvider } from "../../src/state/use-tracks-work.ts";
import { localMeta, visibleLocal } from "../../src/model/localTasks.ts";
import { Card, HeaderPick, Label, Note, Segmented, Sheet, SheetRow, groupEdge } from "../../src/ui.tsx";
import { dueIn } from "../../src/lib/dates.ts";
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
}

function Row({ task, prefix, onCopied, onOpen }: {
  task: ProviderTask;
  prefix: string;
  onCopied: (what: string) => void;
  onOpen: () => void;
}): React.ReactNode {
  const when = dueIn(task.due, new Date());
  // The workspace's colour, with a floor: some boards pick a status colour that
  // is legible on their own white background and vanishes on this one.
  const statusInk = task.statusColor && task.statusColor !== "#ffffff" ? task.statusColor : C.text3;

  return (
    <Pressable
      onPress={onOpen}
      onLongPress={() => {
        // The id, because it is what every skill, branch name and commit
        // message here is written against — and it is the one thing you cannot
        // retype from memory on a phone.
        const id = task.customId || task.id;
        void Clipboard.setStringAsync(id);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        onCopied(id);
      }}
    >
      {/* Padding, not a card. The surface and the border belong to the group
          this row sits in — see groupEdge in src/ui.tsx — and a Card here
          would draw a second one inside the first. */}
      <View style={{ padding: SPACE.lg, gap: SPACE.sm }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
          <Text style={{ color: C.text4, fontSize: T.eyebrow, fontFamily: MONO }}>
            {task.customId || task.id}
          </Text>
          <View style={{ flex: 1 }} />
          {when ? (
            <Text style={{ color: when.late ? C.error : C.text4, fontSize: T.eyebrow }}>{when.text}</Text>
          ) : null}
        </View>

        <Text style={{ color: C.text, fontSize: T.body, lineHeight: 19 }}>{task.title}</Text>

        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm, flexWrap: "wrap" }}>
          <View style={{
            paddingHorizontal: SPACE.sm, paddingVertical: 2, borderRadius: RADIUS.sm,
            borderWidth: 1, borderColor: statusInk,
          }}>
            <Text style={{ color: statusInk, fontSize: T.eyebrow }}>{task.status}</Text>
          </View>
          {task.list ? <Text style={{ color: C.text4, fontSize: T.eyebrow }}>{task.list}</Text> : null}
          {task.sprint ? <Text style={{ color: C.text4, fontSize: T.eyebrow }}>· {task.sprint}</Text> : null}
        </View>
      </View>
    </Pressable>
  );
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
          <Text style={{ color: C.text4, fontSize: T.eyebrow, fontFamily: MONO }}>
            {task.uuid.slice(0, 8)}
          </Text>
          <View style={{ flex: 1 }} />
          {when ? (
            <Text style={{ color: when.late ? C.error : C.text4, fontSize: T.eyebrow }}>{when.text}</Text>
          ) : null}
        </View>

        <Text style={{ color: task.status === "pending" ? C.text : C.text3, fontSize: T.body, lineHeight: 19 }}>
          {task.description}
        </Text>

        {meta.length ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm, flexWrap: "wrap" }}>
            {meta.map((piece, i) => (
              <Text key={`${piece}-${i}`} style={{ color: C.text4, fontSize: T.eyebrow }}>{piece}</Text>
            ))}
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

export default function TasksScreen(): React.ReactNode {
  usePaletteTick(); // a scene repaints only if it asks — see use-palette.ts
  const { host } = useAgentglass();
  const navigation = useNavigation();
  const router = useRouter();
  const [views, setViews] = useState<ViewsAnswer | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [tasks, setTasks] = useState<ProviderTask[] | null>(null);
  const [local, setLocal] = useState<LocalTask[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pulling, setPulling] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [openOnly, setOpenOnly] = useState(true);
  /* Which tracker this machine keeps its work in — the same read the Inbox
     uses to decide whether to offer this screen at all. `undefined` while it
     is in the air, `null` when there is none; either way nothing is fetched
     until it is known, because fetching ClickUp's board on a Taskwarrior
     machine is the bug this screen had. */
  const provider = useTaskProvider(host);
  const board = provider?.id === "clickup";
  const localList = !!provider && !board;

  useEffect(() => {
    if (!host || !board) return;
    void (async () => {
      const answer = await ask<ViewsAnswer>(host, "/clickup/views");
      if (!answer.ok) { setError(answer.error); return; }
      setViews(answer.value);
      setChosen((current) => current ?? answer.value.current ?? answer.value.views[0]?.id ?? null);
    })();
  }, [host, board]);

  const load = useCallback(async (): Promise<void> => {
    if (!host) return;
    if (localList) {
      const answer = await ask<TasksListResponse>(host, "/tasks/list");
      if (!answer.ok) { setError(answer.error); setLocal([]); return; }
      // The route answers 200 with `ok: false` and `error` when the tool is
      // there and the read failed; `tasks` is then the last good list, kept.
      setError(answer.value.ok ? null : answer.value.error ?? "The task list could not be read.");
      setLocal(Array.isArray(answer.value.tasks) ? answer.value.tasks : []);
      return;
    }
    if (!board || !chosen) return;
    const answer = await ask<ViewTasks>(host, `/clickup/view?id=${encodeURIComponent(chosen)}`);
    if (!answer.ok) { setError(answer.error); setTasks([]); return; }
    setError(null);
    setTasks(Array.isArray(answer.value.tasks) ? answer.value.tasks : []);
  }, [host, board, localList, chosen]);

  useEffect(() => { setTasks(null); setLocal(null); void load(); }, [load]);

  /* A card moved or claimed on its own screen lands here without a refetch —
     the card screen hands the server's answer over (state/card-edits.ts). The
     callback is stable so the subscription is made once. */
  useCardChanges(useCallback((task: ProviderTask) => setTasks((was) => withCard(was, task)), []));

  const shown = useMemo(
    // Done cards are the bulk of any board and none of them are work you owe.
    // Kept behind a switch rather than dropped, because "did I close that?" is
    // a real question somebody asks from a sofa.
    () => (tasks ?? []).filter((t) => (openOnly ? t.statusKind !== "done" : true)),
    [tasks, openOnly],
  );
  const shownLocal = useMemo(() => visibleLocal(local, openOnly), [local, openOnly]);

  const onRefresh = useCallback((): void => {
    setPulling(true);
    void load().finally(() => setPulling(false));
  }, [load]);

  const view = views?.views.find((v) => v.id === chosen) ?? null;

  // The view is the title — see prs.tsx for why this is setOptions and not an
  // inline options object. On the local list there is no view to pick, so the
  // title is the tracker's own name and does not open anything.
  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitleAlign: "center",
      headerTitle: () => (
        board
          ? <HeaderPick label={view?.name ?? "Cards"} onPress={() => setPicking(true)} />
          : <Text style={{ color: C.text, fontSize: T.body, fontWeight: "600" }}>{provider?.title ?? "Cards"}</Text>
      ),
    });
  }, [navigation, view?.name, board, provider?.title]);

  if (!host) return null;

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      {/* What was a chip at the end of a scrolling strip is a segment, because
          it was never a filter among filters — it is the only two-state thing
          on the screen, and a chip that toggles looks exactly like a chip that
          selects. Two segments say which of two lists you are looking at. */}
      {/* And not drawn over the "no tracker" card: a switch between two views
          of nothing is the filter that card warns people not to go looking for. */}
      {provider !== null ? (
        <View style={{ paddingHorizontal: SPACE.lg, paddingTop: SPACE.md }}>
          <Segmented
            value={openOnly ? "open" : "all"}
            onChange={(id) => setOpenOnly(id === "open")}
            options={[
              { id: "open" as const, label: "Open" },
              { id: "all" as const, label: "All" },
            ]}
          />
        </View>
      ) : null}

      <Sheet open={picking && board} onClose={() => setPicking(false)} title="View">
        {(views?.views ?? []).map((view) => (
          <SheetRow
            key={view.id}
            label={view.name}
            sub={view.builtin ? "built in" : undefined}
            on={view.id === chosen}
            onPress={() => { setChosen(view.id); setPicking(false); }}
          />
        ))}
        <View style={{ paddingTop: SPACE.md }}>
          <Note>
            These are the workspace&apos;s own saved views, in the order they were added on the
            computer — so the board says the same thing in both places.
          </Note>
        </View>
      </Sheet>

      {said ? (
        <View style={{ paddingHorizontal: SPACE.lg, paddingVertical: SPACE.xs, backgroundColor: C.bg2 }}>
          <Text style={{ color: C.success, fontSize: T.eyebrow }}>{said} copied</Text>
        </View>
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
            <Label text="No tracker here" />
            <Note>
              This computer is not connected to a task tracker, so there are no cards to show.
              It is connected at the computer, in Settings, not from here.
            </Note>
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
              <Card>
                <Label text={error ? "Cannot read the list" : "Nothing here"} />
                <Note tone={error ? "bad" : "quiet"}>
                  {error ?? "Nothing is still open. The switch above shows the rest."}
                </Note>
              </Card>
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
          data={shown}
          keyExtractor={(task) => task.id}
          /* No gap between rows: they are one card divided by hairlines, not a
             stack of cards. See groupEdge in src/ui.tsx. */
          contentContainerStyle={{ padding: SPACE.lg, paddingBottom: SPACE.xl }}
          refreshControl={<RefreshControl refreshing={pulling} onRefresh={onRefresh} tintColor={C.text3} />}
          ListEmptyComponent={
            tasks === null ? null : (
              <Card>
                <Label text={error ? "Cannot read the board" : "Nothing here"} />
                <Note tone={error ? "bad" : "quiet"}>
                  {error ?? "This view has no cards that are still open. The switch above shows the rest."}
                </Note>
              </Card>
            )
          }
          renderItem={({ item, index }) => (
            <View style={groupEdge(index === 0, index === shown.length - 1)}>
              <Row
                task={item}
                prefix={views?.prefix ?? ""}
                onCopied={(id) => { setSaid(id); setTimeout(() => setSaid(null), 1600); }}
                onOpen={() => router.push({ pathname: "/card/[id]", params: { id: item.id } })}
              />
            </View>
          )}
        />
      )}

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
