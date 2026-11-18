/*
 * Past sessions: what the agents ran in this project, grouped by when, and the
 * way back into one.
 *
 * It was a list inside the terminal's ··· sheet — eight rows that said nothing
 * about the hundred that did not — and the mock gives it a screen of its own
 * with the checkout first, the days as headings, and a search one tap away.
 *
 * Two reads, both of them the terminal's: `/agent/sessions` for the rows and
 * `/git/repos` only when the route did not carry a checkout (a deep link or a
 * cold start). Nothing here writes.
 *
 * A ceiling, stated: "All checkouts" is every checkout of THIS project — the
 * server folds a worktree to its repository, and `/agent/sessions` answers for
 * one project at a time. Sessions from a second project are not in this list.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { AgentSessionRow, GitRepoRef } from "../../shared/types.ts";
import { ask } from "../src/lib/api.ts";
import { useAgentglass } from "../src/state/host-context.tsx";
import { usePaletteTick } from "../src/state/use-palette.ts";
import {
  CHIPS, PAGE, countLine, filterSessions, groupsOf, page, sessionLine, type PastChip,
} from "../src/model/pastSessions.ts";
import { leafOf } from "../src/terminal/windows.ts";
import { Field, FilterChips, Note, Sheet, TAP } from "../src/ui.tsx";
import { ChevronIcon } from "../src/nav/icons.tsx";
import { Glyph } from "../src/nav/glyphs.tsx";
import { C, RADIUS, SPACE, T } from "../src/theme.ts";

export default function SessionsScreen(): React.ReactNode {
  usePaletteTick(); // a scene repaints only if it asks — see use-palette.ts
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { host } = useAgentglass();
  const params = useLocalSearchParams<{ root?: string }>();
  const [root, setRoot] = useState(params.root ?? "");
  const [project, setProject] = useState<string | null>(null);
  const [rows, setRows] = useState<AgentSessionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chip, setChip] = useState<PastChip>("checkout");
  const [shown, setShown] = useState(PAGE);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");

  /* A route that did not say which checkout: the most recently used one is
     what "this checkout" means to somebody who just left the terminal. */
  useEffect(() => {
    if (root || !host) return;
    let gone = false;
    void (async () => {
      const answer = await ask<{ repos: GitRepoRef[] }>(host, "/git/repos");
      if (gone) return;
      const first = answer.ok ? answer.value.repos?.[0]?.root : undefined;
      if (first) setRoot(first);
    })();
    return () => { gone = true; };
  }, [host, root]);

  /* The name that goes under the title: the repository, not the worktree's
     folder. `orbit-wt` is where this phone is attached; `orbit` is what the
     person calls the work. One read, and the folder is the fallback. */
  useEffect(() => {
    if (!root || !host) { setProject(null); return; }
    let gone = false;
    void (async () => {
      const answer = await ask<{ repo: GitRepoRef }>(host, `/git/repo?root=${encodeURIComponent(root)}`);
      if (gone) return;
      const repo = answer.ok ? answer.value.repo : undefined;
      const main = repo?.worktreeOf ?? repo?.root;
      setProject(main ? leafOf(main) : leafOf(root));
    })();
    return () => { gone = true; };
  }, [host, root]);

  const read = useCallback(async (): Promise<void> => {
    if (!host) return;
    setError(null);
    if (!root) return;
    const answer = await ask<{ ok: boolean; sessions?: AgentSessionRow[] }>(
      host, `/agent/sessions?root=${encodeURIComponent(root)}`,
    );
    if (!answer.ok) { setRows([]); setError(answer.error); return; }
    setRows(answer.value.ok ? answer.value.sessions ?? [] : []);
  }, [host, root]);

  useEffect(() => { void read(); }, [read]);

  const filtered = useMemo(
    () => filterSessions(rows ?? [], { chip, root }),
    [rows, chip, root],
  );
  const p = useMemo(() => page(filtered, shown), [filtered, shown]);
  const groups = useMemo(() => groupsOf(p.rows), [p.rows]);

  const open = (row: AgentSessionRow): void => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    /* A session already running is gone TO, not resumed: two agents appending
       to one transcript is the one thing this screen must not start. */
    if (row.openIn) {
      router.push({ pathname: "/terminal", params: { pane: row.openIn.paneId } });
      return;
    }
    router.push({ pathname: "/terminal", params: { session: row.id, cwd: row.cwd } });
  };

  const copyId = (row: AgentSessionRow): void => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    void Clipboard.setStringAsync(row.id);
  };

  const list = (listChip: PastChip, listQuery: string, onOpen: (row: AgentSessionRow) => void): React.ReactNode => {
    const listRows = filterSessions(rows ?? [], { chip: listChip, query: listQuery, root });
    const paged = page(listRows, shown);
    const lines = groupsOf(paged.rows);
    if (rows === null) return <Note>Asking the computer…</Note>;
    if (error) return <Note tone="bad">{error}</Note>;
    if (!listRows.length) {
      return (
        <Note>
          {listQuery
            ? `No session matches “${listQuery}”.`
            : listChip === "checkout"
              ? "No agent has run in this checkout yet."
              : "No session in this scope."}
        </Note>
      );
    }
    return (
      <View style={{ gap: SPACE.lg }}>
        {lines.map((group) => (
          <View key={group.id} style={{ gap: SPACE.xs }}>
            <Text style={{
              color: C.text3, fontSize: T.eyebrow, fontWeight: "700", letterSpacing: 0.8,
              textTransform: "uppercase", paddingHorizontal: SPACE.xs,
            }}>{group.label}</Text>
            <View style={{
              borderRadius: RADIUS.lg, borderWidth: 1, borderColor: C.border,
              backgroundColor: C.bg2, overflow: "hidden",
            }}>
              {group.rows.map((row, index) => (
                <Pressable
                  key={row.id}
                  onPress={() => onOpen(row)}
                  onLongPress={() => copyId(row)}
                  accessibilityRole="button"
                  accessibilityLabel={`${row.title || row.id}, ${sessionLine(row)}. Hold to copy the session id.`}
                  style={({ pressed }) => ({
                    minHeight: TAP, flexDirection: "row", alignItems: "center", gap: SPACE.sm,
                    paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm,
                    borderTopWidth: index ? 1 : 0, borderTopColor: C.border,
                    backgroundColor: pressed ? C.bg3 : "transparent",
                  })}
                >
                  {row.openIn ? (
                    <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: C.success }} />
                  ) : null}
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text numberOfLines={1} style={{ color: C.text, fontSize: T.body, fontWeight: "600" }}>
                      {row.title.trim() || row.id.slice(0, 12)}
                    </Text>
                    <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.small }}>
                      {sessionLine(row)}
                    </Text>
                  </View>
                  {row.openIn ? (
                    <View style={{
                      paddingHorizontal: SPACE.sm, height: 24, justifyContent: "center",
                      borderRadius: RADIUS.sm, backgroundColor: C.bg4,
                    }}>
                      <Text style={{ color: C.primary, fontSize: T.small, fontWeight: "700" }}>open</Text>
                    </View>
                  ) : (
                    <ChevronIcon color={C.text3} size={18} />
                  )}
                </Pressable>
              ))}
            </View>
          </View>
        ))}
        {paged.more > 0 ? (
          <Pressable
            onPress={() => setShown((n) => n + PAGE)}
            accessibilityRole="button"
            accessibilityLabel={`Show older sessions, ${paged.more} more`}
            style={({ pressed }) => ({
              minHeight: TAP, alignItems: "center", justifyContent: "center",
              borderRadius: RADIUS.lg, borderWidth: 1, borderColor: C.border,
              backgroundColor: pressed ? C.bg3 : "transparent",
            })}
          >
            <Text style={{ color: C.text, fontSize: T.body, fontWeight: "600" }}>
              Show older sessions · {paged.more}
            </Text>
          </Pressable>
        ) : (
          <Text style={{ color: C.text3, fontSize: T.small, textAlign: "center" }}>{countLine(paged)}</Text>
        )}
      </View>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: C.bg, paddingTop: insets.top }}>
      <View style={{
        flexDirection: "row", alignItems: "center", minHeight: 52, paddingHorizontal: SPACE.xs,
        borderBottomWidth: 1, borderBottomColor: C.border,
      }}>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={({ pressed }) => ({
            width: TAP, height: TAP, alignItems: "center", justifyContent: "center",
            borderRadius: RADIUS.md, backgroundColor: pressed ? C.bg3 : "transparent",
          })}
        >
          <View style={{ transform: [{ rotate: "180deg" }] }}><ChevronIcon color={C.text} size={20} /></View>
        </Pressable>
        <View style={{ flex: 1, minWidth: 0, paddingLeft: SPACE.xs }}>
          <Text numberOfLines={1} style={{ color: C.text, fontSize: T.title, fontWeight: "600" }}>Past sessions</Text>
          <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.small }}>
            {project ? `${project} first` : "Every checkout"}
          </Text>
        </View>
        <Pressable
          onPress={() => setSearching(true)}
          accessibilityRole="button"
          accessibilityLabel="Search sessions"
          style={({ pressed }) => ({
            width: TAP, height: TAP, alignItems: "center", justifyContent: "center",
            borderRadius: RADIUS.md, backgroundColor: pressed ? C.bg3 : "transparent",
          })}
        >
          <Glyph name="search" color={C.text2} size={22} />
        </Pressable>
      </View>

      <View style={{ paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm }}>
        <View style={{ flexDirection: "row", gap: 3, padding: 3, borderRadius: RADIUS.md, backgroundColor: C.bg3 }}>
          {(["checkout", "all"] as const).map((id) => {
            const on = chip === id;
            return (
              <Pressable
                key={id}
                onPress={() => { setChip(id); setShown(PAGE); }}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                style={({ pressed }) => ({
                  flex: 1, minHeight: TAP, alignItems: "center", justifyContent: "center",
                  borderRadius: RADIUS.sm, backgroundColor: on ? C.bg : "transparent",
                  borderWidth: 1, borderColor: on ? C.border2 : "transparent",
                  opacity: pressed ? 0.7 : 1,
                })}
              >
                <Text style={{ color: on ? C.text : C.text3, fontSize: T.small, fontWeight: on ? "700" : "400" }}>
                  {id === "checkout" ? "This checkout" : "All checkouts"}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: SPACE.md, paddingBottom: SPACE.xl, gap: SPACE.md }}
      >
        {root && rows === null && !error ? (
          <View style={{ paddingTop: SPACE.xl, alignItems: "center" }}><ActivityIndicator color={C.primary} /></View>
        ) : (
          list(chip, "", open)
        )}
        <Text style={{ color: C.text3, fontSize: T.small, textAlign: "center", paddingTop: SPACE.xs }}>
          A long press copies the session id.
        </Text>
      </ScrollView>

      {/* s61: the same rows, narrowed by a search. A sheet because it is a
          question asked of this list and answered behind the thumb, and the
          list is still under it when it closes. */}
      <Sheet
        open={searching}
        onClose={() => setSearching(false)}
        title="Search past sessions"
        subtitle={`${project ?? "Every checkout"} first. Words match the title and the last thing the agent said.`}
        tall
        footer={(
          <Pressable
            onPress={() => setSearching(false)}
            accessibilityRole="button"
            style={({ pressed }) => ({
              flex: 1, minHeight: TAP, alignItems: "center", justifyContent: "center",
              borderRadius: RADIUS.md, borderWidth: 1, borderColor: C.border,
              backgroundColor: pressed ? C.bg3 : C.bg2,
            })}
          >
            <Text style={{ color: C.text, fontSize: T.body, fontWeight: "600" }}>Back to the list</Text>
          </Pressable>
        )}
      >
        <View style={{ gap: SPACE.sm, paddingBottom: SPACE.md }}>
          <Field value={query} onChangeText={setQuery} placeholder="key bar, error, test…" kind="text" />
          <FilterChips
            label="What the search reads"
            options={[...CHIPS]}
            value={chip}
            onChange={(next) => { setChip(next); setShown(PAGE); }}
          />
          {list(chip, query, (row) => { setSearching(false); open(row); })}
          <Note>Search reads the rows this phone already has. A session from another checkout opens in that checkout's window.</Note>
        </View>
      </Sheet>
    </View>
  );
}
