/*
 * The checkout, found and read.
 *
 * ── why it exists ────────────────────────────────────────────────────────
 * Everything this app could show you about a repository arrived through a
 * question somebody else had asked first: a pull request's diff, a commit's
 * subject, the files git happens to think are dirty. None of those answer "let
 * me look at that file", which is what somebody standing up actually wants
 * when a check has gone red and the log names a path.
 *
 * ── every call is a read ─────────────────────────────────────────────────
 * `/files/tree`, `/files/read`, `/files/find`, `/files/grep` and the two
 * `/git/changes-v2` modes are all GETs — so this whole screen works under a
 * `read` grant, which is the right shape for it. Looking at a file changes
 * nothing, and the phone most likely to be doing it is the one paired to look.
 *
 * ── one screen, three states ─────────────────────────────────────────────
 * The landing (what changed on this branch, then the folder), the search, and a
 * file. Not three routes: the hardware Back out of a file should land on the
 * folder or the results it came from and nothing else, and a pushed route per
 * folder would build a stack somebody has to unwind a level at a time. Where
 * Back goes from each state is `backTarget` in src/model/files.ts.
 *
 * ── what it will not do ──────────────────────────────────────────────────
 * Edit. A file is read here and changed where agents change files, which is
 * the pane behind the star — the same division the rest of this app follows,
 * and the reason it is a `read` screen at all.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator, BackHandler, FlatList, Keyboard, Pressable, RefreshControl, ScrollView, Text, TextInput, View,
  useWindowDimensions, type RefreshControlProps,
} from "react-native";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import type { ChangeRow, ChangeRowsResult } from "../../shared/types.ts";
import { ask } from "../src/lib/api.ts";
import { useAgentglass } from "../src/state/host-context.tsx";
import { useRecents } from "../src/state/file-recents.ts";
import { useKeyboardLift } from "../src/state/keyboard-lift.ts";
import { usePaletteTick } from "../src/state/use-palette.ts";
import {
  START, SEARCH_MODES, backTarget, changedFiles, changedLine, changedNote, changedUnder, diffParams, dirOf,
  findLabel, findMatches, groupHits, hitParts, hitSummary, matchesByLine, nameOf, nameResults, recentMatching, searchPlan,
  searching, sizeLabel, stepMatch, type Changed, type FilesState, type Hit,
} from "../src/model/files.ts";
import { highlight, withMarks, type Mark, type Token, type TokenKind } from "../src/model/syntax.ts";
import { CHAR_W } from "../src/model/gitReview.ts";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { BackIcon, ChevronIcon, ReposIcon } from "../src/nav/icons.tsx";
import { Glyph, type GlyphName } from "../src/nav/glyphs.tsx";
import { Card, Group, GroupTitle, Label, Note, Row, Segmented, Snack, TAP, useFlash } from "../src/ui.tsx";
import { PullHint, StatusBadge } from "../src/git-ui.tsx";
import { C, MONO, RADIUS, SPACE, T, tint } from "../src/theme.ts";

/** One row of `/files/tree`. Declared here rather than in shared/ — it is this
 *  route's reply and nothing else reads it. */
interface Entry { name: string; rel: string; dir: boolean; size?: number }

type Results =
  | { kind: "find"; files: string[]; dirs: string[]; truncated: boolean }
  | { kind: "grep"; hits: Hit[]; files: number; truncated: boolean };

/** How much of a file to draw.
 *
 *  A minified bundle is one line of four hundred kilobytes, and a phone asked
 *  to lay that out stops answering. The cap is on CHARACTERS rather than lines
 *  for that reason: a line count would let exactly that file through. */
const CAP = 60_000;

/** The changed files shown before "Show all": a branch with forty of them
 *  would otherwise push the folder off the first screen. */
const CHANGED_FIRST = 5;

/** A line of code, in points. One number: the rows are a fixed height when
 *  they do not wrap, which is what lets Find jump to a line without measuring. */
const LINE_H = 20;

const ink = (kind: TokenKind): string => (
  kind === "keyword" ? C.primary : kind === "call" ? C.info : kind === "string" ? C.success
    : kind === "number" ? C.warning : kind === "comment" ? C.text4 : C.text
);

const CodeLine = memo(function CodeLine({ n, tokens, marks, numW, wide }: {
  n: number; tokens: readonly Token[]; marks?: readonly Mark[]; numW: number; wide: number | null;
}): React.ReactNode {
  return (
    <View style={{ flexDirection: "row", width: wide ?? undefined, minHeight: LINE_H, height: wide ? LINE_H : undefined }}>
      <Text style={{
        width: numW, textAlign: "right", color: C.text4, fontSize: 11.5, lineHeight: LINE_H, fontFamily: MONO, paddingRight: SPACE.md,
      }}>{n}</Text>
      <Text
        numberOfLines={wide ? 1 : undefined}
        ellipsizeMode="clip"
        style={{ flex: 1, color: C.text, fontSize: 12, lineHeight: LINE_H, fontFamily: MONO, paddingRight: SPACE.md }}
      >
        {withMarks(tokens, marks ?? []).map((t, i) => (
          <Text
            key={i}
            style={{
              color: ink(t.kind),
              backgroundColor: t.mark === "current" ? tint(C.warning, 0.75) : t.mark ? tint(C.warning, 0.28) : undefined,
            }}
          >{t.text}</Text>
        ))}
      </Text>
    </View>
  );
});

/** One of the three buttons under a file: an icon and a word, the same width. */
function BarBtn({ icon, label, on, tone, disabled, onPress }: {
  icon: GlyphName; label: string; on?: boolean; tone?: "primary"; disabled?: boolean; onPress: () => void;
}): React.ReactNode {
  const face = tone === "primary" ? C.primary : on ? tint(C.primary, 0.16) : C.bg2;
  const fg = tone === "primary" ? C.bg : on ? C.primary : C.text;
  return (
    <Pressable
      accessibilityRole={tone === "primary" ? "button" : "switch"}
      accessibilityState={tone === "primary" ? { disabled: !!disabled } : { checked: !!on, disabled: !!disabled }}
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1, minHeight: 52, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: SPACE.sm,
        borderRadius: RADIUS.md, borderWidth: tone === "primary" ? 0 : 1, borderColor: on ? C.primary : C.border,
        backgroundColor: face, opacity: disabled ? 0.45 : pressed ? 0.8 : 1,
      })}
    >
      <Glyph name={icon} color={fg} size={18} />
      <Text style={{ color: fg, fontSize: T.body, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

const FileMark = (): React.ReactNode => (
  <View style={{ width: 32, height: 32, borderRadius: RADIUS.sm, backgroundColor: C.bg3, alignItems: "center", justifyContent: "center" }}>
    <Glyph name="file" color={C.text2} size={18} />
  </View>
);

export default function FilesScreen(): React.ReactNode {
  usePaletteTick(); // a scene repaints only if it asks — see use-palette.ts
  const { host } = useAgentglass();
  const router = useRouter();
  const { width: screenW } = useWindowDimensions();
  const { root: rootParam, file } = useLocalSearchParams<{ root: string; file?: string }>();
  const root = rootParam ? String(rootParam) : "";

  /** Where on the screen: folder, file, search, find. Every Back decision is a
   *  function of this one value. */
  const [s, setS] = useState<FilesState>(START);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [changed, setChanged] = useState<Changed[]>([]);
  const [showAll, setShowAll] = useState(false);
  /** The file's text, held with the path it belongs to so a slow read cannot
   *  land under a file somebody has already moved on from. */
  const [text, setText] = useState<{ rel: string; body: string } | null>(null);
  /** The folder and the file fail separately: a file that cannot be read must
   *  not leave its red card on the folder landing after Back. */
  const [error, setError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  /** The folder and the file the newest request is for; an older answer that
   *  lands after the screen has moved on is dropped, not drawn. */
  const treeFor = useRef<string | null>(null);
  const readFor = useRef<string | null>(null);
  const [pulling, setPulling] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [recents, remember] = useRecents(root);
  const [focused, setFocused] = useState(false);
  const input = useRef<TextInput>(null);
  const lifted = useKeyboardLift();

  // --- the folder ---------------------------------------------------------

  const loadTree = useCallback(async (rel: string): Promise<void> => {
    if (!host || !root) return;
    const query = `root=${encodeURIComponent(root)}&rel=${encodeURIComponent(rel)}`;
    const answer = await ask<{ ok: boolean; entries?: Entry[]; error?: string }>(host, `/files/tree?${query}`);
    if (treeFor.current !== rel) return;
    if (!answer.ok) { setError(answer.error); return; }
    if (!answer.value.ok) { setError(answer.value.error || "That folder could not be read."); return; }
    setError(null);
    setEntries(answer.value.entries ?? []);
  }, [host, root]);

  useEffect(() => {
    setEntries(null);
    treeFor.current = s.rel;
    void loadTree(s.rel);
  }, [loadTree, s.rel]);

  /** What changed on this branch: the working tree and what is already
   *  committed, both from the routes the Git screens use. A failure leaves the
   *  block out — the folder is what this screen is for, and the block is an
   *  offer on top of it. */
  const loadChanged = useCallback(async (): Promise<void> => {
    if (!host || !root) return;
    const [working, committed] = await Promise.all([
      ask<ChangeRowsResult>(host, "/git/changes-v2?mode=working"),
      ask<ChangeRowsResult>(host, "/git/changes-v2?mode=committed"),
    ]);
    const rows = (r: typeof working): ChangeRow[] => (r.ok ? r.value.rows ?? [] : []);
    setChanged(changedFiles(root, rows(working), rows(committed)));
  }, [host, root]);
  useEffect(() => { void loadChanged(); }, [loadChanged]);

  // --- a file -------------------------------------------------------------

  const read = useCallback(async (rel: string): Promise<void> => {
    if (!host || !root) return;
    setFileError(null);
    readFor.current = rel;
    const query = `root=${encodeURIComponent(root)}&rel=${encodeURIComponent(rel)}`;
    const answer = await ask<{ ok: boolean; text?: string; error?: string }>(host, `/files/read?${query}`);
    if (readFor.current !== rel) return;
    if (!answer.ok) { setFileError(answer.error); return; }
    if (!answer.value.ok) { setFileError(answer.value.error || "That file could not be read."); return; }
    setText({ rel, body: answer.value.text ?? "" });
  }, [host, root]);

  const openFile = useCallback((rel: string, fromSearch: boolean, arrived = false): void => {
    setS((was) => ({ ...was, open: rel, fromSearch, arrived, rel: fromSearch ? was.rel : dirOf(rel), finding: false }));
    setText(null);
    remember(rel);
    void read(rel);
  }, [read, remember]);

  // A link in: the diff's "Whole file" arrives with the file it was reading.
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (!file || !host || opened.current === String(file)) return;
    opened.current = String(file);
    openFile(String(file), false, true);
  }, [file, host, openFile]);

  const open = s.open;
  const body = open && text?.rel === open ? text.body : null;
  const shown = body === null ? "" : body.length > CAP ? body.slice(0, CAP) : body;
  // A file's final newline ends its last line; it does not start another.
  const lines = useMemo(() => (shown ? shown.replace(/\n$/, "").split("\n") : []), [shown]);
  const tokens = useMemo(() => highlight(lines, open ?? ""), [lines, open]);
  const here = open ? changed.find((c) => c.path === open) : undefined;

  // --- find in the file ---------------------------------------------------

  const [fq, setFq] = useState("");
  const [at, setAt] = useState(0);
  // Closing the bar takes the highlights with it, whatever was typed in it.
  const query = s.finding ? fq : "";
  const found = useMemo(() => findMatches(lines, query), [lines, query]);
  const byLine = useMemo(() => matchesByLine(found), [found]);
  const list = useRef<FlatList<string>>(null);
  const jump = useCallback((line: number): void => {
    list.current?.scrollToIndex({ index: line, viewPosition: 0.3, animated: false });
  }, []);
  useEffect(() => { setAt(0); if (found[0]) jump(found[0].line); }, [found, jump]);
  const step = (dir: 1 | -1): void => {
    const next = stepMatch(at, found.length, dir);
    setAt(next);
    if (found[next]) jump(found[next].line);
  };

  // --- search -------------------------------------------------------------

  const [results, setResults] = useState<Results | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const plan = useMemo(() => searchPlan(root, s.query, s.mode), [root, s.query, s.mode]);
  useEffect(() => {
    setResults(null); setSearchError(null);
    if (!host || (plan.kind !== "find" && plan.kind !== "grep")) { setAsking(false); return; }
    let gone = false;
    setAsking(true);
    // A search per keystroke is a request per keystroke, and the answer to the
    // first letters is thrown away by the next; wait for the thumb to pause.
    const timer = setTimeout(() => {
      void (async () => {
        const answer = await ask<Record<string, unknown> & { ok: boolean; error?: string }>(host, plan.path);
        if (gone) return;
        setAsking(false);
        if (!answer.ok) { setSearchError(answer.error); return; }
        const v = answer.value;
        if (!v.ok) { setSearchError(v.error || "The search could not run."); return; }
        setResults(plan.kind === "find"
          ? { kind: "find", files: (v.files as string[]) ?? [], dirs: (v.dirs as string[]) ?? [], truncated: !!v.truncated }
          : { kind: "grep", hits: (v.hits as Hit[]) ?? [], files: Number(v.files ?? 0), truncated: !!v.truncated });
      })();
    }, 250);
    return () => { gone = true; clearTimeout(timer); };
  }, [host, plan]);

  // The keyboard closing is the first thing Back does; the box should not go on looking focused.
  useEffect(() => {
    const sub = Keyboard.addListener("keyboardDidHide", () => input.current?.blur());
    return () => sub.remove();
  }, []);

  // --- Back ---------------------------------------------------------------

  const goBack = useCallback((): void => {
    const next = backTarget(s);
    if (next) setS(next); else router.back();
  }, [s, router]);
  useFocusEffect(useCallback(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      const next = backTarget(s);
      if (!next) return false;
      setS(next);
      return true;
    });
    return () => sub.remove();
  }, [s]));

  // --- small things -------------------------------------------------------

  const [copied, flash] = useFlash();
  const copyPath = useCallback((): void => {
    if (!open) return;
    void Clipboard.setStringAsync(open);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    flash();
  }, [open, flash]);

  const pull = (fn: () => Promise<unknown>): React.ReactElement<RefreshControlProps> => (
    <RefreshControl
      refreshing={pulling}
      onRefresh={() => { setPulling(true); void fn().finally(() => setPulling(false)); }}
      tintColor={C.text3}
    />
  );

  const leaf = root.split("/").filter(Boolean).pop() ?? "checkout";
  const parts = (open ?? s.rel).split("/").filter(Boolean);
  const goTo = (depth: number): void => setS((was) => ({ ...was, rel: parts.slice(0, depth).join("/") }));

  const sorted = useMemo(() => [...(entries ?? [])].sort((a, b) => (
    a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1
  )), [entries]);

  const inFolder = changedUnder(changed, s.rel);
  const visibleChanged = showAll ? inFolder : inFolder.slice(0, CHANGED_FIRST);
  const numW = String(lines.length).length * 8 + SPACE.lg + SPACE.md;
  const longest = useMemo(() => lines.reduce((m, l) => Math.max(m, l.length), 0), [lines]);
  const wide = wrap ? null : Math.max(screenW, Math.ceil(numW + longest * CHAR_W + SPACE.lg));

  const header = (
    <Stack.Screen
      options={{
        headerTitle: () => (
          <View style={{ maxWidth: screenW - TAP * 2 - SPACE.xl }}>
            <Text numberOfLines={1} style={{ color: C.text, fontSize: T.title, fontWeight: "600" }}>
              {open ? nameOf(open) : "Files"}
            </Text>
            <Text numberOfLines={1} ellipsizeMode="head" style={{ color: C.text3, fontSize: T.small, fontFamily: MONO }}>
              {open ? [leaf, ...dirOf(open).split("/").filter(Boolean)].join("/") : leaf}
            </Text>
          </View>
        ),
        headerLeft: () => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back"
            onPress={goBack}
            style={({ pressed }) => ({
              width: TAP, height: TAP, borderRadius: TAP / 2, alignItems: "center", justifyContent: "center",
              backgroundColor: pressed ? C.bg3 : "transparent",
            })}
          >
            <BackIcon color={C.text} size={22} />
          </Pressable>
        ),
        headerRight: open ? () => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Copy the path"
            onPress={copyPath}
            style={({ pressed }) => ({
              width: TAP, height: TAP, borderRadius: TAP / 2, alignItems: "center", justifyContent: "center",
              backgroundColor: pressed ? C.bg3 : "transparent",
            })}
          >
            <Glyph name="copy" color={C.text2} size={20} />
          </Pressable>
        ) : undefined,
      }}
    />
  );

  // --- a file on screen ---------------------------------------------------

  if (open) {
    const cur = found[at];
    return (
      <View ref={lifted.ref} style={{ flex: 1, backgroundColor: C.bg, paddingBottom: lifted.lift }}>
        {header}
        {changedNote(here) ? (
          <View style={{ paddingHorizontal: SPACE.lg, paddingBottom: SPACE.sm, flexDirection: "row" }}>
            <View style={{
              flexDirection: "row", alignItems: "center", gap: 6, height: 36, paddingHorizontal: SPACE.md,
              borderRadius: RADIUS.pill, backgroundColor: tint(C.warning, 0.16),
            }}>
              <Glyph name="file" color={C.warning} size={14} />
              <Text style={{ color: C.warning, fontSize: T.body, fontWeight: "600" }}>{changedNote(here)}</Text>
            </View>
          </View>
        ) : null}

        {fileError ? <View style={{ padding: SPACE.lg }}><Card><Label text="Cannot read it" /><Note tone="bad">{fileError}</Note></Card></View> : null}
        {body === null && !fileError ? <View style={{ padding: SPACE.xl }}><ActivityIndicator color={C.text3} /></View> : null}

        {body !== null ? (
          <View style={{ flex: 1, borderTopWidth: 1, borderTopColor: C.border }}>
            {body.length > CAP ? (
              <View style={{ padding: SPACE.lg }}>
                <Note>Showing the first {Math.round(CAP / 1000)}k characters of {Math.round(body.length / 1000)}k.</Note>
              </View>
            ) : null}
            {/* Its own horizontal scroller when lines do not wrap: a line of
                code is as long as it is, and the page never scrolls sideways —
                this does. Wrap off is the default because indentation is the
                point of code; Wrap turns it on for reading prose or a long string. */}
            {(() => {
              const listEl = (
                <FlatList
                  ref={list}
                  style={{ flex: 1 }}
                  data={lines}
                  extraData={[at, query, wrap]}
                  keyExtractor={(_, i) => String(i)}
                  initialNumToRender={40}
                  getItemLayout={wrap ? undefined : (_, i) => ({ length: LINE_H, offset: LINE_H * i, index: i })}
                  onScrollToIndexFailed={({ index, averageItemLength }) => {
                    // Wrapped rows have no known height until they are drawn: go near, then ask again.
                    list.current?.scrollToOffset({ offset: averageItemLength * index, animated: false });
                    setTimeout(() => jump(index), 60);
                  }}
                  renderItem={({ index }) => (
                    <CodeLine
                      n={index + 1}
                      tokens={tokens[index] ?? []}
                      marks={byLine.get(index)?.map((f) => ({ at: f.at, len: f.len, current: f === cur }))}
                      numW={numW}
                      wide={wide}
                    />
                  )}
                  refreshControl={pull(() => read(open))}
                  ListEmptyComponent={<Text style={{ color: C.text3, padding: SPACE.lg }}>(empty)</Text>}
                  ListFooterComponent={
                    <Text style={{ color: C.text3, fontSize: T.small, padding: SPACE.lg }}>
                      {sizeLabel(body.length)} · {lines.length} {lines.length === 1 ? "line" : "lines"} · read only
                    </Text>
                  }
                  contentContainerStyle={{ paddingTop: SPACE.sm }}
                />
              );
              return wrap ? listEl : (
                <ScrollView horizontal style={{ flex: 1 }} contentContainerStyle={{ width: wide ?? undefined }} nestedScrollEnabled>
                  {listEl}
                </ScrollView>
              );
            })()}
          </View>
        ) : <View style={{ flex: 1 }} />}

        {s.finding ? (
          <View style={{
            flexDirection: "row", alignItems: "center", gap: SPACE.sm, paddingHorizontal: SPACE.lg, paddingVertical: SPACE.sm,
            borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.bg2,
          }}>
            <TextInput
              autoFocus
              value={fq}
              onChangeText={setFq}
              onSubmitEditing={() => step(1)}
              placeholder="Find in this file"
              placeholderTextColor={C.text4}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              returnKeyType="search"
              accessibilityLabel="Find in this file"
              style={{
                flex: 1, minHeight: TAP, borderWidth: 1, borderColor: C.border, borderRadius: RADIUS.md, backgroundColor: C.bg,
                color: C.text, paddingHorizontal: SPACE.md, fontSize: T.body,
              }}
            />
            <Text style={{ color: found.length || !query ? C.text3 : C.error, fontSize: T.small, minWidth: 48, textAlign: "center" }}>
              {findLabel(at, found.length, query, body !== null && body.length > CAP ? CAP : undefined)}
            </Text>
            {(["Previous match", "Next match"] as const).map((label, i) => (
              <Pressable
                key={label}
                accessibilityRole="button"
                accessibilityLabel={label}
                disabled={!found.length}
                onPress={() => step(i ? 1 : -1)}
                style={({ pressed }) => ({
                  width: TAP, height: TAP, borderRadius: TAP / 2, alignItems: "center", justifyContent: "center",
                  opacity: found.length ? 1 : 0.4, backgroundColor: pressed ? C.bg3 : "transparent",
                })}
              >
                <View style={{ transform: [{ rotate: i ? "90deg" : "-90deg" }] }}><ChevronIcon color={C.text2} size={18} /></View>
              </Pressable>
            ))}
          </View>
        ) : null}

        <View style={{
          flexDirection: "row", gap: SPACE.sm, padding: SPACE.lg, borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.bg,
        }}>
          <BarBtn
            icon="search"
            label="Find"
            on={s.finding}
            onPress={() => setS((was) => ({ ...was, finding: !was.finding }))}
          />
          <BarBtn icon="wrap" label="Wrap" on={wrap} onPress={() => setWrap((w) => !w)} />
          {here && here.status !== "untracked" ? (
            <BarBtn icon="branch" label="See diff" tone="primary" onPress={() => router.push({ pathname: "/git-diff", params: diffParams(here) })} />
          ) : null}
        </View>
        {copied ? <Snack text="Path copied" /> : null}
      </View>
    );
  }

  // --- the landing and the search ----------------------------------------

  const active = focused || searching(s.query, s.mode);
  const recent = plan.kind === "recent" ? recentMatching(recents, plan.needle) : [];

  const fileRow = (rel: string, sub?: string, trail?: React.ReactNode): React.ReactNode => (
    <Row key={rel} title={nameOf(rel)} sub={sub ?? dirOf(rel)} lead={<FileMark />} trail={trail} onPress={() => openFile(rel, true)} />
  );

  let resultsEl: React.ReactNode = null;
  if (active) {
    if (plan.kind === "short") resultsEl = <Note>{plan.says}</Note>;
    else if (searchError) resultsEl = <Card><Label text="Cannot search" /><Note tone="bad">{searchError}</Note></Card>;
    else if (plan.kind === "idle") resultsEl = <Note>Type part of a file name. Text looks inside the files; Recent is what you opened on this phone.</Note>;
    else if (plan.kind === "recent") {
      resultsEl = recent.length
        ? <Group>{recent.map((rel) => fileRow(rel))}</Group>
        : <Note>{recents.length ? "None of the files you opened match." : "Files you open on this phone show up here."}</Note>;
    } else if (asking || !results) resultsEl = <View style={{ padding: SPACE.xl }}><ActivityIndicator color={C.text3} /></View>;
    else if (results.kind === "find") {
      const rows = nameResults(results.files, results.dirs);
      resultsEl = rows.length ? (
        <>
          <Text style={{ color: C.text3, fontSize: T.small, paddingBottom: SPACE.sm }}>
            {rows.length}{results.truncated ? "+" : ""} {rows.length === 1 && !results.truncated ? "result" : "results"}
          </Text>
          <Group>
            {rows.map((r) => r.dir
              ? (
                <Row
                  key={`d:${r.rel}`} title={nameOf(r.rel)} sub={dirOf(r.rel) || "folder"} chevron
                  lead={<View style={{ width: 32, alignItems: "center" }}><ReposIcon color={C.primary} size={20} /></View>}
                  onPress={() => { setS((was) => ({ ...was, rel: r.rel, query: "", mode: "name" })); Keyboard.dismiss(); }}
                />
              )
              : fileRow(r.rel))}
          </Group>
        </>
      ) : <Note>No file has that in its name.</Note>;
    } else {
      const groups = groupHits(results.hits);
      resultsEl = groups.length ? (
        <>
          <Text style={{ color: C.text3, fontSize: T.small, paddingBottom: SPACE.sm }}>
            {hitSummary(results.hits.length, results.files || groups.length, results.truncated)}
          </Text>
          <Group>
            {groups.map((g) => (
              <View key={g.rel}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${g.rel}, ${g.hits.length} ${g.hits.length === 1 ? "match" : "matches"}`}
                  onPress={() => openFile(g.rel, true)}
                  style={({ pressed }) => ({ paddingHorizontal: SPACE.lg, paddingVertical: SPACE.sm, backgroundColor: pressed ? C.bg3 : "transparent" })}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
                    <FileMark />
                    <Text numberOfLines={1} style={{ color: C.text, fontSize: 15, fontWeight: "600", flexShrink: 1 }}>{g.name}</Text>
                    <Text numberOfLines={1} ellipsizeMode="head" style={{ color: C.text3, fontSize: T.small, flex: 1 }}>{g.dir}</Text>
                    <View style={{ minWidth: 28, height: 24, borderRadius: 6, backgroundColor: C.bg3, alignItems: "center", justifyContent: "center", paddingHorizontal: 6 }}>
                      <Text style={{ color: C.text2, fontSize: T.small, fontWeight: "600" }}>{g.hits.length}</Text>
                    </View>
                  </View>
                  {g.hits.slice(0, 5).map((h) => {
                    const p = hitParts(h);
                    return (
                      <View key={h.line} style={{ flexDirection: "row", gap: SPACE.sm, paddingTop: 4 }}>
                        <Text style={{ width: 28, textAlign: "right", color: C.text4, fontSize: 12, fontFamily: MONO }}>{h.line}</Text>
                        <Text numberOfLines={1} style={{ flex: 1, color: C.text2, fontSize: 12, fontFamily: MONO }}>
                          {p.before}
                          <Text style={{ backgroundColor: tint(C.warning, 0.3), color: C.text }}>{p.match}</Text>
                          {p.after}
                        </Text>
                      </View>
                    );
                  })}
                  {g.hits.length > 5 ? <Text style={{ color: C.text3, fontSize: T.small, paddingTop: 4 }}>{g.hits.length - 5} more in this file</Text> : null}
                </Pressable>
              </View>
            ))}
          </Group>
        </>
      ) : <Note>{`Nothing in the files says "${s.query.trim()}".`}</Note>;
    }
  }

  return (
    <View ref={lifted.ref} style={{ flex: 1, backgroundColor: C.bg, paddingBottom: lifted.lift }}>
      {header}
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: SPACE.lg, paddingBottom: SPACE.xl, gap: SPACE.sm }}
        refreshControl={pull(() => Promise.all([loadTree(s.rel), loadChanged()]))}
      >
        <View style={{
          flexDirection: "row", alignItems: "center", gap: SPACE.sm, minHeight: TAP, paddingLeft: SPACE.md, borderRadius: RADIUS.md,
          borderWidth: 1, borderColor: focused ? C.primary : C.border, backgroundColor: C.bg2,
        }}>
          <Glyph name="search" color={C.text3} size={20} />
          <TextInput
            ref={input}
            value={s.query}
            onChangeText={(query) => setS((was) => ({ ...was, query }))}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder={`Find a file or text in ${leaf}`}
            placeholderTextColor={C.text4}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            returnKeyType="search"
            accessibilityLabel="Find a file or text"
            style={{ flex: 1, minHeight: TAP, color: C.text, fontSize: T.body }}
          />
          {s.query ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Clear the search"
              onPress={() => { setS((was) => ({ ...was, query: "" })); input.current?.focus(); }}
              style={({ pressed }) => ({
                width: TAP, height: TAP, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? C.bg3 : "transparent",
                borderTopRightRadius: RADIUS.md, borderBottomRightRadius: RADIUS.md,
              })}
            >
              <Glyph name="close" color={C.text2} size={18} />
            </Pressable>
          ) : null}
        </View>

        {active ? (
          <>
            <Segmented
              options={SEARCH_MODES}
              value={s.mode}
              onChange={(mode) => setS((was) => ({ ...was, mode }))}
            />
            {resultsEl}
          </>
        ) : (
          <>
            {/* The crumbs: the checkout, then each folder down to where you are,
                each one a way straight back to it. 40 tall with 12 of padding
                either side of the name, and 4 of reach above and below so the
                thumb still has 48. */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ alignItems: "center", gap: 2, paddingVertical: SPACE.xs }}>
              {[leaf, ...parts].map((name, i, all) => {
                const last = i === all.length - 1;
                return (
                  <View key={`${i}:${name}`} style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
                    {i ? <ChevronIcon color={C.text3} size={14} /> : null}
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={last ? `${name}, here` : `Go to ${name}`}
                      disabled={last}
                      hitSlop={{ top: 4, bottom: 4 }}
                      onPress={() => goTo(i)}
                      style={({ pressed }) => ({
                        height: 40, justifyContent: "center", paddingHorizontal: 12, borderRadius: RADIUS.sm,
                        backgroundColor: pressed ? C.bg3 : "transparent",
                      })}
                    >
                      <Text style={{ color: last ? C.text : C.primary, fontSize: 13, fontFamily: MONO, fontWeight: last ? "600" : "500" }}>{name}</Text>
                    </Pressable>
                  </View>
                );
              })}
            </ScrollView>

            {error ? <Card><Label text="Cannot read it" /><Note tone="bad">{error}</Note></Card> : null}

            {inFolder.length ? (
              <>
                <GroupTitle text="Changed on this branch" />
                <Group>
                  {visibleChanged.map((c) => (
                    <Row
                      key={c.path}
                      title={nameOf(c.path)}
                      sub={changedLine(c)}
                      lead={<StatusBadge status={c.status === "typechange" ? "type-changed" : c.status} />}
                      chevron
                      onPress={() => {
                        if (c.status === "deleted") router.push({ pathname: "/git-diff", params: diffParams(c) });
                        else openFile(c.path, false);
                      }}
                    />
                  ))}
                </Group>
                {inFolder.length > CHANGED_FIRST ? (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => setShowAll((a) => !a)}
                    style={({ pressed }) => ({ minHeight: TAP, justifyContent: "center", paddingHorizontal: SPACE.xs, backgroundColor: pressed ? C.bg3 : "transparent", borderRadius: RADIUS.sm })}
                  >
                    <Text style={{ color: C.primary, fontSize: T.body, fontWeight: "600" }}>
                      {showAll ? "Show fewer" : `Show all ${inFolder.length}`}
                    </Text>
                  </Pressable>
                ) : null}
              </>
            ) : null}

            <GroupTitle text={s.rel || leaf} />
            {entries === null && !error ? <View style={{ padding: SPACE.xl }}><ActivityIndicator color={C.text3} /></View> : null}
            {entries && !entries.length ? <Card><Note>This folder is empty.</Note></Card> : null}
            {sorted.length ? (
              <Group>
                {sorted.map((entry) => (
                  <Row
                    key={entry.rel}
                    title={entry.name}
                    lead={entry.dir
                      ? <View style={{ width: 32, alignItems: "center" }}><ReposIcon color={C.primary} size={20} /></View>
                      : <FileMark />}
                    trail={!entry.dir && entry.size !== undefined
                      ? <Text style={{ color: C.text3, fontSize: T.small }}>{sizeLabel(entry.size)}</Text>
                      : undefined}
                    chevron={entry.dir}
                    onPress={() => { if (entry.dir) setS((was) => ({ ...was, rel: entry.rel })); else openFile(entry.rel, false); }}
                  />
                ))}
              </Group>
            ) : null}
            <PullHint text="Pull down to refresh." />
          </>
        )}
      </ScrollView>
    </View>
  );
}
