/*
 * The cards, from the board you actually use.
 *
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
import type { ProviderTask } from "../../../shared/providers.ts";
import { ask } from "../../src/lib/api.ts";
import { useAgentglass } from "../../src/state/host-context.tsx";
import { usePaletteTick } from "../../src/state/use-palette.ts";
import { Card, HeaderPick, Label, Note, Segmented, Sheet, SheetRow, groupEdge } from "../../src/ui.tsx";
import { dueIn } from "../../src/lib/dates.ts";
import { C, MONO, RADIUS, SPACE, T } from "../../src/theme.ts";

interface SavedView {
  id: string;
  name: string;
  url: string;
  builtin?: boolean;
}

interface ViewsAnswer {
  views: SavedView[];
  current: string;
  prefix: string;
}

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

export default function TasksScreen(): React.ReactNode {
  usePaletteTick(); // a scene repaints only if it asks — see use-palette.ts
  const { host } = useAgentglass();
  const navigation = useNavigation();
  const router = useRouter();
  const [views, setViews] = useState<ViewsAnswer | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [tasks, setTasks] = useState<ProviderTask[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pulling, setPulling] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [openOnly, setOpenOnly] = useState(true);

  useEffect(() => {
    if (!host) return;
    void (async () => {
      const answer = await ask<ViewsAnswer>(host, "/clickup/views");
      if (!answer.ok) { setError(answer.error); return; }
      setViews(answer.value);
      setChosen((current) => current ?? answer.value.current ?? answer.value.views[0]?.id ?? null);
    })();
  }, [host]);

  const load = useCallback(async (): Promise<void> => {
    if (!host || !chosen) return;
    const answer = await ask<ViewTasks>(host, `/clickup/view?id=${encodeURIComponent(chosen)}`);
    if (!answer.ok) { setError(answer.error); setTasks([]); return; }
    setError(null);
    setTasks(Array.isArray(answer.value.tasks) ? answer.value.tasks : []);
  }, [host, chosen]);

  useEffect(() => { setTasks(null); void load(); }, [load]);

  const shown = useMemo(
    // Done cards are the bulk of any board and none of them are work you owe.
    // Kept behind a switch rather than dropped, because "did I close that?" is
    // a real question somebody asks from a sofa.
    () => (tasks ?? []).filter((t) => (openOnly ? t.statusKind !== "done" : true)),
    [tasks, openOnly],
  );

  const onRefresh = useCallback((): void => {
    setPulling(true);
    void load().finally(() => setPulling(false));
  }, [load]);

  const view = views?.views.find((v) => v.id === chosen) ?? null;

  // The view is the title — see prs.tsx for why this is setOptions and not an
  // inline options object.
  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitleAlign: "center",
      headerTitle: () => (
        <HeaderPick label={view?.name ?? "Cards"} onPress={() => setPicking(true)} />
      ),
    });
  }, [navigation, view?.name]);

  if (!host) return null;

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      {/* What was a chip at the end of a scrolling strip is a segment, because
          it was never a filter among filters — it is the only two-state thing
          on the screen, and a chip that toggles looks exactly like a chip that
          selects. Two segments say which of two lists you are looking at. */}
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

      <Sheet open={picking} onClose={() => setPicking(false)} title="View">
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

      <View style={{ paddingHorizontal: SPACE.lg, paddingBottom: SPACE.sm }}>
        <Note>Tap opens the card here. Hold copies its id.</Note>
      </View>
    </View>
  );
}
