/*
 * What changed in one file, read on a phone.
 *
 * Source control lists the files git says have changed and stages them with one
 * tap, which left no way to see WHAT changed before committing it. This is that:
 * the server's `/git/file-diff` (a GET, so it works under a `read` grant),
 * against HEAD, drawn one row per line with the numbers a reader quotes. Lines
 * wrap rather than scroll sideways — a phone held upright is the width it is.
 */
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, RefreshControl, Text, View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import type { FileDiff } from "../../shared/types.ts";
import { ask } from "../src/lib/api.ts";
import { useAgentglass } from "../src/state/host-context.tsx";
import { usePaletteTick } from "../src/state/use-palette.ts";
import { gitDiffRows, gitDiffTotals, type GitDiffRow } from "../src/model/gitDiffRows.ts";
import { Card, Note } from "../src/ui.tsx";
import { C, MONO, SPACE, T, tint } from "../src/theme.ts";

const NUMBER_W = 34;

const Row = memo(function Row({ row }: { row: GitDiffRow }): React.ReactNode {
  if (row.kind === "hunk") {
    return (
      <Text style={{
        color: C.text3, fontSize: T.small, fontFamily: MONO, backgroundColor: C.bg2,
        paddingHorizontal: SPACE.sm, paddingVertical: SPACE.xs,
      }}>{row.text}</Text>
    );
  }
  const add = row.kind === "add", del = row.kind === "del";
  return (
    <View style={{ flexDirection: "row", backgroundColor: add ? tint(C.success, 0.14) : del ? tint(C.error, 0.14) : "transparent" }}>
      <Text style={{ width: NUMBER_W, textAlign: "right", color: C.text4, fontSize: 11, fontFamily: MONO, paddingTop: 1 }}>
        {row.new ?? row.old ?? ""}
      </Text>
      <Text style={{ width: 16, textAlign: "center", color: add ? C.success : del ? C.error : C.text4, fontSize: 12, fontFamily: MONO }}>
        {add ? "+" : del ? "−" : " "}
      </Text>
      <Text style={{ flex: 1, color: C.text, fontSize: 12, lineHeight: 17, fontFamily: MONO, paddingRight: SPACE.sm }}>
        {row.text || " "}
      </Text>
    </View>
  );
});

export default function GitDiffScreen(): React.ReactNode {
  usePaletteTick();
  const { host } = useAgentglass();
  const { root, path } = useLocalSearchParams<{ root: string; path: string }>();
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pulling, setPulling] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    if (!host || !root || !path) return;
    const answer = await ask<FileDiff>(
      host, `/git/file-diff?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`,
    );
    if (!answer.ok) { setError(answer.error); return; }
    if (answer.value.error) { setError(answer.value.error); return; }
    setError(null);
    setDiff(answer.value);
  }, [host, root, path]);

  useEffect(() => { void load(); }, [load]);

  const rows = useMemo(() => gitDiffRows(diff?.hunks ?? []), [diff]);
  const totals = useMemo(() => gitDiffTotals(diff?.hunks ?? []), [diff]);
  const name = (path ?? "").split("/").pop() || "Changes";

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Stack.Screen options={{ title: name }} />
      <FlatList
        data={rows}
        keyExtractor={(r) => r.key}
        renderItem={({ item }) => <Row row={item} />}
        contentContainerStyle={{ paddingBottom: SPACE.xl }}
        refreshControl={
          <RefreshControl
            refreshing={pulling}
            onRefresh={() => { setPulling(true); void load().finally(() => setPulling(false)); }}
            tintColor={C.text3}
          />
        }
        ListHeaderComponent={
          <View style={{ padding: SPACE.lg, gap: SPACE.xs }}>
            <Text style={{ color: C.text, fontSize: 13, fontFamily: MONO }}>{path}</Text>
            {diff && !diff.binary ? (
              <Text style={{ color: C.text3, fontSize: T.small }}>
                <Text style={{ color: C.success }}>{`+${totals.added}`}</Text>
                {"  "}
                <Text style={{ color: C.error }}>{`−${totals.removed}`}</Text>
                {"  ·  against the last commit"}
              </Text>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          error ? <View style={{ padding: SPACE.lg }}><Card><Note tone="bad">{error}</Note></Card></View>
          : diff === null ? <View style={{ padding: SPACE.xl }}><ActivityIndicator color={C.text3} /></View>
          : <View style={{ padding: SPACE.lg }}><Card><Note>{
            diff.binary ? "A binary file: there are no lines to show." : "No changes against the last commit."
          }</Note></Card></View>
        }
        ListFooterComponent={diff?.truncated ? (
          <View style={{ padding: SPACE.lg }}><Note>The diff is longer than this screen draws; the rest is on the computer.</Note></View>
        ) : null}
      />
    </View>
  );
}
