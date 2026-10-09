/*
 * One commit, and the files it changed.
 *
 * Log rows used to be dead: a commit could be read on the computer or not at
 * all. This is the middle step — the commit, then its files, then one file's
 * diff — and it is read-only end to end: `/git/commit-diff` is a GET, so it
 * works under a `read` grant, and the only thing a tap here changes is a tick
 * that never leaves the phone.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import type { GitFileChange } from "../../shared/types.ts";
import { ask } from "../src/lib/api.ts";
import { useAgentglass } from "../src/state/host-context.tsx";
import { usePaletteTick } from "../src/state/use-palette.ts";
import { useViewed, viewedKey } from "../src/state/git-viewed.ts";
import { commitFiles, commitTotals, viewedLabel } from "../src/model/gitReview.ts";
import { PullHint, Stats, StatusBadge, ViewedBox } from "../src/git-ui.tsx";
import { Card, Note, Snack, TAP, groupEdge, useFlash } from "../src/ui.tsx";
import { Glyph } from "../src/nav/glyphs.tsx";
import { C, MONO, RADIUS, SPACE, T } from "../src/theme.ts";

export default function GitCommitScreen(): React.ReactNode {
  usePaletteTick();
  const { host } = useAgentglass();
  const router = useRouter();
  const navigation = useNavigation();
  const p = useLocalSearchParams<{ root: string; hash: string; short?: string; subject?: string; author?: string; date?: string }>();
  const root = String(p.root ?? ""), hash = String(p.hash ?? "");
  const [changes, setChanges] = useState<GitFileChange[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pulling, setPulling] = useState(false);
  const [copied, flash] = useFlash();
  const [viewed, toggle] = useViewed(viewedKey(root, hash));

  const load = useCallback(async (): Promise<void> => {
    if (!host || !root || !hash) return;
    const answer = await ask<{ changes?: GitFileChange[] }>(
      host, `/git/commit-diff?root=${encodeURIComponent(root)}&hash=${encodeURIComponent(hash)}`,
    );
    if (!answer.ok) { setError(answer.error); return; }
    setError(null);
    setChanges(answer.value.changes ?? []);
  }, [host, root, hash]);
  useEffect(() => { void load(); }, [load]);

  const files = useMemo(() => commitFiles(root, changes ?? []), [root, changes]);
  const totals = useMemo(() => commitTotals(files), [files]);
  const paths = useMemo(() => files.map((f) => f.path), [files]);
  const short = String(p.short ?? hash.slice(0, 7));

  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: () => (
        <View>
          <Text style={{ color: C.text, fontSize: T.title, fontWeight: "600" }}>{`Commit ${short}`}</Text>
        </View>
      ),
      headerRight: () => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Copy the commit hash"
          onPress={() => { void Clipboard.setStringAsync(hash); void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); flash(); }}
          style={({ pressed }) => ({
            width: TAP, height: TAP, marginRight: SPACE.xs, borderRadius: TAP / 2,
            alignItems: "center", justifyContent: "center", backgroundColor: pressed ? C.bg3 : "transparent",
          })}
        >
          <Glyph name="copy" color={C.text2} size={22} />
        </Pressable>
      ),
    });
  }, [navigation, short, hash, flash]);

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <FlatList
        data={files}
        keyExtractor={(f) => f.path}
        contentContainerStyle={{ padding: SPACE.lg, paddingBottom: SPACE.xl * 2 }}
        refreshControl={
          <RefreshControl
            refreshing={pulling}
            onRefresh={() => { setPulling(true); void load().finally(() => setPulling(false)); }}
            tintColor={C.text3}
          />
        }
        ListHeaderComponent={
          <View style={{ gap: SPACE.md, paddingBottom: SPACE.md }}>
            <Text style={{ color: C.text, fontSize: T.head, fontWeight: "700", lineHeight: 26 }}>{p.subject ?? short}</Text>
            {p.author || p.date ? (
              <Text style={{ color: C.text3, fontSize: T.body }}>
                {[p.author, p.date].filter(Boolean).join(" · ")}
              </Text>
            ) : null}
            <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm, paddingTop: SPACE.xs }}>
              <Text style={{ color: C.text3, fontSize: T.small, fontWeight: "600", letterSpacing: 0.6, flex: 1 }} numberOfLines={1}>
                {changes === null ? "FILES" : `${files.length} ${files.length === 1 ? "FILE" : "FILES"}`}
                {changes !== null && files.length ? <Text style={{ fontWeight: "400" }}>{`  ·  +${totals.added} −${totals.removed}`}</Text> : null}
              </Text>
              {files.length ? (
                <View style={{ height: 28, paddingHorizontal: SPACE.sm, borderRadius: RADIUS.sm, backgroundColor: C.bg3, justifyContent: "center" }}>
                  <Text style={{ color: C.text2, fontSize: T.small, fontWeight: "600" }}>{viewedLabel(paths, viewed)}</Text>
                </View>
              ) : null}
            </View>
          </View>
        }
        ListEmptyComponent={
          error ? <Card><Note tone="bad">{error}</Note></Card>
          : changes === null ? <View style={{ padding: SPACE.xl }}><ActivityIndicator color={C.text3} /></View>
          : <Card><Note>This commit changed no files (a merge shows nothing against its first parent here).</Note></Card>
        }
        ListFooterComponent={files.length ? (
          <View>
            <PullHint text="Tick a file when you have read it. The ticks stay on this phone and nothing is sent anywhere." />
          </View>
        ) : null}
        renderItem={({ item, index }) => (
          <View style={[groupEdge(index === 0, index === files.length - 1), { flexDirection: "row", alignItems: "center" }]}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Read the diff of ${item.path}`}
              onPress={() => router.push({ pathname: "/git-diff", params: { root, hash, path: item.path } })}
              style={({ pressed }) => ({
                flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: SPACE.md,
                minHeight: 56, paddingLeft: SPACE.lg, backgroundColor: pressed ? C.bg3 : "transparent",
              })}
            >
              <StatusBadge status={item.status} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text numberOfLines={1} ellipsizeMode="head" style={{ color: C.text, fontSize: 13.5, fontFamily: MONO, fontWeight: "500" }}>
                  {item.path}
                </Text>
              </View>
              {item.binary ? <Text style={{ color: C.text3, fontSize: T.small }}>binary</Text> : <Stats added={item.added} removed={item.removed} />}
            </Pressable>
            <ViewedBox on={viewed.has(item.path)} path={item.path} onPress={() => toggle(item.path)} />
          </View>
        )}
      />
      {copied ? <Snack text="Commit hash copied" /> : null}
    </View>
  );
}
