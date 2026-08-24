/*
 * The checkout, browsed and read.
 *
 * ── why it exists ────────────────────────────────────────────────────────
 * Everything this app could show you about a repository arrived through a
 * question somebody else had asked first: a pull request's diff, a commit's
 * subject, the files git happens to think are dirty. None of those answer "let
 * me look at that file", which is what somebody standing up actually wants
 * when a check has gone red and the log names a path.
 *
 * ── both calls are reads ─────────────────────────────────────────────────
 * `/files/tree` lists a directory and `/files/read` returns one file's text,
 * and both are GETs — so this whole screen works under a `read` grant, which
 * is the right shape for it. Looking at a file changes nothing, and the phone
 * most likely to be doing it is the one paired to look.
 *
 * ── one screen, two states ───────────────────────────────────────────────
 * A listing and a file, not two routes. The back gesture out of a file should
 * land on the directory it came from and nothing else, and a pushed route per
 * folder would build a stack somebody has to unwind a level at a time. The
 * crumb at the top is the way up, and it is the same control in both states.
 *
 * ── what it will not do ──────────────────────────────────────────────────
 * Edit. A file is read here and changed where agents change files, which is
 * the pane behind the star — the same division the rest of this app follows,
 * and the reason it is a `read` screen at all.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { ask } from "../src/lib/api.ts";
import { useAgentglass } from "../src/state/host-context.tsx";
import { usePaletteTick } from "../src/state/use-palette.ts";
import { ChevronIcon } from "../src/nav/icons.tsx";
import { Card, Label, Note, TAP, groupEdge } from "../src/ui.tsx";
import { C, MONO, RADIUS, SPACE, T } from "../src/theme.ts";

/** One row of `/files/tree`. Declared here rather than in shared/ — it is this
 *  route's reply and nothing else reads it. */
interface Entry { name: string; rel: string; dir: boolean }

/** How much of a file to draw.
 *
 *  A minified bundle is one line of four hundred kilobytes, and a phone asked
 *  to lay that out stops answering. The cap is on CHARACTERS rather than lines
 *  for that reason: a line count would let exactly that file through. */
const CAP = 60_000;

/** The parent of a relative path, or "" for the root. Written out rather than
 *  taken from a path module: this is a repo-relative POSIX path off the wire,
 *  and node's `dirname` answers "." for a bare name, which is not a rel the
 *  server would accept. */
function parentOf(rel: string): string {
  const cut = rel.lastIndexOf("/");
  return cut <= 0 ? "" : rel.slice(0, cut);
}

export default function FilesScreen(): React.ReactNode {
  usePaletteTick(); // a scene repaints only if it asks — see use-palette.ts
  const { host } = useAgentglass();
  const { root } = useLocalSearchParams<{ root: string }>();

  /** Where in the tree. "" is the top of the checkout. */
  const [rel, setRel] = useState("");
  const [entries, setEntries] = useState<Entry[] | null>(null);
  /** The file being read, and its text. Held together so a slow read cannot
   *  land under a file somebody has already moved on from. */
  const [open, setOpen] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!host || !root || open) return;
    let gone = false;
    setEntries(null);
    void (async () => {
      const query = `root=${encodeURIComponent(root)}&rel=${encodeURIComponent(rel)}`;
      const answer = await ask<{ ok: boolean; entries?: Entry[]; error?: string }>(
        host, `/files/tree?${query}`,
      );
      if (gone) return;
      if (!answer.ok) { setError(answer.error); return; }
      if (!answer.value.ok) { setError(answer.value.error || "That folder could not be read."); return; }
      setError(null);
      setEntries(answer.value.entries ?? []);
    })();
    return () => { gone = true; };
  }, [host, root, rel, open]);

  const read = useCallback(async (entry: Entry): Promise<void> => {
    if (!host || !root) return;
    setOpen(entry.rel);
    setText(null);
    setError(null);
    const query = `root=${encodeURIComponent(root)}&rel=${encodeURIComponent(entry.rel)}`;
    const answer = await ask<{ ok: boolean; text?: string; error?: string }>(
      host, `/files/read?${query}`,
    );
    if (!answer.ok) { setError(answer.error); return; }
    if (!answer.value.ok) { setError(answer.value.error || "That file could not be read."); return; }
    setText(answer.value.text ?? "");
  }, [host, root]);

  /** Folders first, then files, each alphabetical — the order every file
   *  browser has used since there were folders, and the one that makes a
   *  directory of two hundred scannable. */
  const sorted = useMemo(() => [...(entries ?? [])].sort((a, b) => (
    a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1
  )), [entries]);

  const shown = text === null ? "" : text.length > CAP ? text.slice(0, CAP) : text;

  /** Up one, or out of the file back to its folder. One control for both,
   *  because "where am I" and "how do I leave" are the same question here. */
  const up = useCallback((): void => {
    if (open) { setOpen(null); setText(null); setError(null); return; }
    setRel((at) => parentOf(at));
  }, [open]);

  const where = open ?? rel;

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Stack.Screen options={{ title: "Files" }} />

      {/* The crumb. Pressable when there is anywhere above, and drawn plainly
          when there is not — a chevron that does nothing is worse than none. */}
      <Pressable
        onPress={up}
        disabled={!open && !rel}
        accessibilityRole="button"
        accessibilityLabel={open ? "Back to the folder" : "Up one folder"}
        style={({ pressed }) => ({
          flexDirection: "row", alignItems: "center", gap: SPACE.sm,
          paddingHorizontal: SPACE.lg, minHeight: TAP,
          borderBottomWidth: 1, borderBottomColor: C.border,
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <Text style={{ color: !open && !rel ? C.text4 : C.primary, fontSize: T.title }}>
          {!open && !rel ? "" : "‹"}
        </Text>
        <Text
          numberOfLines={1}
          ellipsizeMode="head"
          style={{ color: C.text2, fontSize: T.small, fontFamily: MONO, flex: 1 }}
        >
          {where || "/"}
        </Text>
      </Pressable>

      {error ? (
        <View style={{ padding: SPACE.lg }}>
          <Card><Label text="Cannot read it" /><Note tone="bad">{error}</Note></Card>
        </View>
      ) : null}

      {open ? (
        <ScrollView contentContainerStyle={{ padding: SPACE.lg, paddingBottom: SPACE.xl }}>
          {text === null && !error ? (
            <View style={{ padding: SPACE.xl }}><ActivityIndicator color={C.text3} /></View>
          ) : null}
          {text !== null ? (
            <>
              {text.length > CAP ? (
                <Note>
                  Showing the first {Math.round(CAP / 1000)}k characters of {Math.round(text.length / 1000)}k.
                </Note>
              ) : null}
              {/* Its own horizontal scroller: a line of code is as long as it
                  is, and wrapping one at 393 points makes it unreadable in a
                  different way. The page never scrolls sideways; this does. */}
              <ScrollView horizontal contentContainerStyle={{ padding: SPACE.md }} style={{
                backgroundColor: C.bg2, borderRadius: RADIUS.md,
                borderWidth: 1, borderColor: C.border, marginTop: SPACE.sm,
              }}>
                <Text selectable style={{
                  color: C.text2, fontSize: 10.5, fontFamily: MONO, lineHeight: 16,
                }}>{shown || "(empty)"}</Text>
              </ScrollView>
            </>
          ) : null}
        </ScrollView>
      ) : (
        <ScrollView contentContainerStyle={{ padding: SPACE.lg, paddingBottom: SPACE.xl }}>
          {entries === null && !error ? (
            <View style={{ padding: SPACE.xl }}><ActivityIndicator color={C.text3} /></View>
          ) : null}
          {entries && !entries.length ? <Card><Note>This folder is empty.</Note></Card> : null}
          {sorted.map((entry, i) => (
            <Pressable
              key={entry.rel}
              accessibilityRole="button"
              onPress={() => { if (entry.dir) setRel(entry.rel); else void read(entry); }}
              style={({ pressed }) => [
                groupEdge(i === 0, i === sorted.length - 1),
                {
                  flexDirection: "row", alignItems: "center", gap: SPACE.md,
                  paddingHorizontal: SPACE.lg, minHeight: TAP,
                  opacity: pressed ? 0.6 : 1,
                },
              ]}
            >
              {/* A folder reads as a folder before the name is read. Drawn as
                  two rules rather than a glyph, for the reason the whole of
                  src/nav/icons.tsx exists: Android's font has no dependable
                  mark for this and the fallback runs out at an empty box. */}
              <View style={{ width: 14, alignItems: "center" }}>
                {entry.dir ? (
                  <View style={{
                    width: 13, height: 10, borderRadius: 2,
                    borderWidth: 1, borderColor: C.text3,
                  }} />
                ) : (
                  <View style={{
                    width: 9, height: 12, borderRadius: 1,
                    borderWidth: 1, borderColor: C.text4,
                  }} />
                )}
              </View>
              <Text
                numberOfLines={1}
                style={{
                  color: entry.dir ? C.text : C.text2, fontSize: T.small,
                  fontFamily: MONO, flex: 1,
                  fontWeight: entry.dir ? "600" : "400",
                }}
              >{entry.name}</Text>
              {entry.dir ? <ChevronIcon color={C.text4} size={16} /> : null}
            </Pressable>
          ))}
        </ScrollView>
      )}
    </View>
  );
}
