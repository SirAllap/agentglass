/*
 * What changed in one file, read on a phone.
 *
 * Two ways in. From Source control a working-tree file (`/git/file-diff`,
 * against HEAD); from a commit, one of the files that commit changed
 * (`/git/commit-diff`), with ‹ file n of N › to walk the rest without going
 * back to the list. Both are GETs, so both work under a `read` grant.
 *
 * Lines wrap by default — a phone held upright is the width it is — and the
 * Wrap control in the header turns that off for code whose indentation is the
 * point, at the price of scrolling sideways. Between hunks, an expander reads
 * the lines the hunk cut off from the file itself (`/files/read`, at the commit
 * when there is one), because the question about a changed line is usually
 * answered by the twenty lines around it.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, ScrollView, Text, View, useWindowDimensions } from "react-native";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import type { FileDiff, GitFileChange } from "../../shared/types.ts";
import { ask } from "../src/lib/api.ts";
import { useAgentglass } from "../src/state/host-context.tsx";
import { usePaletteTick } from "../src/state/use-palette.ts";
import { dirOf, nameOf } from "../src/model/files.ts";
import { useViewed, viewedKey } from "../src/state/git-viewed.ts";
import { rowsOf, type DiffRow } from "../src/model/diffRows.ts";
import { gapLabel, gapsIn, nextSlice, type Gap } from "../src/model/expand.ts";
import type { DiffLine } from "../src/model/diffLines.ts";
import {
  commitFiles, diffFileOf, fileNav, gapOffset, relPath, toDiffFile, unwrappedWidth, viewedLabel,
  type CommitFile,
} from "../src/model/gitReview.ts";
import { Stats, StatusBadge, ViewedBox } from "../src/git-ui.tsx";
import { Btn, Card, Note, Sheet, TAP, groupEdge } from "../src/ui.tsx";
import { ChevronIcon } from "../src/nav/icons.tsx";
import { Glyph } from "../src/nav/glyphs.tsx";
import { C, MONO, RADIUS, SPACE, T, tint } from "../src/theme.ts";

const NUMBER_W = 34;

/** The two number columns, the sign and the text. `wide` is the width the
 *  row needs when it does not wrap; null means it wraps to the screen. */
const Line = memo(function Line({ line, old, at, wide }: {
  line: Pick<DiffLine, "kind" | "text">;
  old: number | null;
  at: number | null;
  wide: number | null;
}): React.ReactNode {
  const add = line.kind === "add", del = line.kind === "del";
  return (
    <View style={{
      flexDirection: "row", width: wide ?? undefined,
      backgroundColor: add ? tint(C.success, 0.14) : del ? tint(C.error, 0.14) : "transparent",
    }}>
      <Text style={{ width: NUMBER_W, textAlign: "right", color: C.text4, fontSize: 11, fontFamily: MONO, paddingTop: 1 }}>{old ?? ""}</Text>
      <Text style={{ width: NUMBER_W, textAlign: "right", color: C.text4, fontSize: 11, fontFamily: MONO, paddingTop: 1 }}>{at ?? ""}</Text>
      <Text style={{ width: 16, textAlign: "center", color: add ? C.success : del ? C.error : C.text4, fontSize: 12, fontFamily: MONO }}>
        {add ? "+" : del ? "−" : " "}
      </Text>
      <Text
        numberOfLines={wide ? 1 : undefined}
        ellipsizeMode="clip"
        style={{ flex: 1, color: C.text, fontSize: 12, lineHeight: 17, fontFamily: MONO, paddingRight: SPACE.sm }}
      >{line.text || " "}</Text>
    </View>
  );
});

function Expander({ label, busy, onPress, wide }: { label: string; busy: boolean; onPress: () => void; wide: number | null }): React.ReactNode {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={busy}
      onPress={onPress}
      style={({ pressed }) => ({
        width: wide ?? undefined, minHeight: TAP, flexDirection: "row", alignItems: "center", gap: SPACE.sm,
        paddingHorizontal: SPACE.lg, backgroundColor: pressed ? C.bg3 : C.bg2,
      })}
    >
      {busy ? <ActivityIndicator size="small" color={C.text3} /> : <Glyph name="expand" color={C.text3} size={16} />}
      <Text style={{ color: C.text2, fontSize: T.small, fontWeight: "500" }}>{label}</Text>
    </Pressable>
  );
}

interface Fetched { from: number; to: number; lines: string[] }

export default function GitDiffScreen(): React.ReactNode {
  usePaletteTick();
  const { host } = useAgentglass();
  const router = useRouter();
  const navigation = useNavigation();
  const { width: screenW } = useWindowDimensions();
  const { root, path, hash } = useLocalSearchParams<{ root: string; path: string; hash?: string }>();
  const inCommit = !!hash;
  const [changes, setChanges] = useState<GitFileChange[] | null>(null);
  const [working, setWorking] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pulling, setPulling] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [jump, setJump] = useState(false);
  const [viewed, toggle] = useViewed(viewedKey(String(root ?? ""), String(hash ?? "")));
  const list = useRef<FlatList<DiffRow>>(null);

  const load = useCallback(async (): Promise<void> => {
    if (!host || !root || !path) return;
    const q = `root=${encodeURIComponent(root)}`;
    if (hash) {
      const answer = await ask<{ changes?: GitFileChange[] }>(host, `/git/commit-diff?${q}&hash=${encodeURIComponent(hash)}`);
      if (!answer.ok) { setError(answer.error); return; }
      setError(null);
      setChanges(answer.value.changes ?? []);
      return;
    }
    const answer = await ask<FileDiff>(host, `/git/file-diff?${q}&path=${encodeURIComponent(path)}`);
    if (!answer.ok) { setError(answer.error); return; }
    if (answer.value.error) { setError(answer.value.error); return; }
    setError(null);
    setWorking(answer.value);
  }, [host, root, path, hash]);

  // Walking to the next file changes `path` and nothing else, so a commit's
  // files are read once; a working-tree file is re-read when its path changes.
  useEffect(() => { if (!hash || changes === null) void load(); }, [load, hash, changes]);

  const files: CommitFile[] = useMemo(() => commitFiles(String(root ?? ""), changes ?? []), [root, changes]);
  const paths = useMemo(() => files.map((f) => f.path), [files]);
  const nav = fileNav(paths, String(path ?? ""));

  const change = useMemo(
    () => (inCommit ? changes?.find((c) => relPath(String(root), c.file_path) === path) ?? null : null),
    [inCommit, changes, root, path],
  );
  const file = useMemo(() => {
    if (inCommit) return change ? toDiffFile(String(root), change) : null;
    return working ? diffFileOf(String(path), working.hunks, working.binary) : null;
  }, [inCommit, change, working, root, path]);

  const rows = useMemo(() => rowsOf(file ?? undefined), [file]);
  const gaps = useMemo(() => (file ? gapsIn(file) : []), [file]);
  const wide = useMemo(() => (wrap ? null : unwrappedWidth(file, screenW)), [wrap, file, screenW]);

  /* What each gap has been given, keyed by its position, and the file's text
     once it has been asked for. Both belong to ONE file: a fetched line under
     another file's number is wrong code with a right-looking label. */
  const [shown, setShown] = useState<Record<number, Fetched>>({});
  const [fetching, setFetching] = useState<number | null>(null);
  const [slipped, setSlipped] = useState<{ at: number; text: string } | null>(null);
  const text = useRef<{ path: string; lines: string[] } | null>(null);
  /** The file and commit on screen NOW. An expander's answer that lands after
   *  Next file belongs to the one before it and is dropped. */
  const onScreen = useRef("");
  useEffect(() => {
    onScreen.current = `${hash ?? ""}|${path}`;
    setShown({}); setSlipped(null); setFetching(null); text.current = null;
    list.current?.scrollToOffset({ offset: 0, animated: false });
  }, [path, hash]);

  const gapDir = (gap: Gap): "up" | "down" => (gap.before === 0 ? "up" : "down");

  const expand = useCallback(async (gap: Gap): Promise<void> => {
    if (!host || !root || !path) return;
    const have = shown[gap.before];
    const dir = gapDir(gap);
    const want = nextSlice(gap, dir, have ? (dir === "up" ? have.from : have.to) : null);
    if (!want) return;
    const mine = `${hash ?? ""}|${path}`;
    setFetching(gap.before); setSlipped(null);
    if (text.current?.path !== path) {
      const ref = hash ? `&ref=${encodeURIComponent(hash)}` : "";
      const answer = await ask<{ ok: boolean; text?: string; error?: string }>(
        host, `/files/read?root=${encodeURIComponent(root)}&rel=${encodeURIComponent(path)}${ref}`,
      );
      if (onScreen.current !== mine) return;
      if (!answer.ok || !answer.value.ok) {
        setFetching(null);
        setSlipped({ at: gap.before, text: answer.ok ? answer.value.error ?? "Those lines could not be read." : answer.error });
        return;
      }
      text.current = { path, lines: (answer.value.text ?? "").split("\n") };
      // A trailing newline is the end of the last line, not one more line.
      if (text.current.lines.length && text.current.lines[text.current.lines.length - 1] === "") text.current.lines.pop();
    }
    setFetching(null);
    const lines = text.current.lines.slice(want.from - 1, want.to);
    if (!lines.length) { setSlipped({ at: gap.before, text: "That is the end of the file." }); return; }
    const to = want.from + lines.length - 1;
    setShown((was) => {
      const b = was[gap.before];
      if (!b) return { ...was, [gap.before]: { from: want.from, to, lines } };
      return dir === "up"
        ? { ...was, [gap.before]: { from: want.from, to: b.to, lines: [...lines, ...b.lines] } }
        : { ...was, [gap.before]: { from: b.from, to, lines: [...b.lines, ...lines] } };
    });
  }, [host, root, path, hash, shown]);

  const name = nameOf(String(path ?? "")) || "Changes";
  const dir = dirOf(String(path ?? ""));

  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: () => (
        <View style={{ maxWidth: screenW - TAP * 2 - SPACE.xl }}>
          <Text numberOfLines={1} style={{ color: C.text, fontSize: T.title, fontWeight: "600" }}>{name}</Text>
          {dir ? <Text numberOfLines={1} ellipsizeMode="head" style={{ color: C.text3, fontSize: T.small, fontFamily: MONO }}>{dir}</Text> : null}
        </View>
      ),
      headerRight: () => (
        <Pressable
          accessibilityRole="switch"
          accessibilityState={{ checked: wrap }}
          accessibilityLabel={wrap ? "Wrap long lines: on" : "Wrap long lines: off"}
          onPress={() => setWrap((w) => !w)}
          style={({ pressed }) => ({
            width: TAP, height: TAP, marginRight: SPACE.xs, borderRadius: TAP / 2, alignItems: "center", justifyContent: "center",
            backgroundColor: pressed ? C.bg3 : wrap ? "transparent" : tint(C.primary, 0.16),
          })}
        >
          <Glyph name="wrap" color={wrap ? C.text2 : C.primary} size={22} />
        </Pressable>
      ),
    });
  }, [navigation, name, dir, wrap, screenW]);

  const go = (to: string | null): void => { if (to) router.setParams({ path: to }); };

  /** One gap: what it has been given, and the offer to give more. */
  const gapRow = (gap: Gap): React.ReactElement => {
    const have = shown[gap.before];
    const d = gapDir(gap);
    const more = nextSlice(gap, d, have ? (d === "up" ? have.from : have.to) : null);
    const label = gapLabel(gap, more);
    const off = gapOffset(change?.hunks ?? working?.hunks ?? [], gap.before);
    const bar = label ? <Expander label={label} busy={fetching === gap.before} wide={wide} onPress={() => { void expand(gap); }} /> : null;
    return (
      <View>
        {d === "up" ? bar : null}
        {have ? have.lines.map((t, i) => (
          <Line key={have.from + i} line={{ kind: "ctx", text: t }} old={have.from + i + off} at={have.from + i} wide={wide} />
        )) : null}
        {d === "down" ? bar : null}
        {slipped?.at === gap.before ? (
          <Text style={{ color: C.text3, fontSize: T.eyebrow, paddingHorizontal: SPACE.lg, paddingVertical: SPACE.xs }}>{slipped.text}</Text>
        ) : null}
      </View>
    );
  };

  const empty = error ? <View style={{ padding: SPACE.lg }}><Card><Note tone="bad">{error}</Note></Card></View>
    : (inCommit ? changes === null : working === null) ? <View style={{ padding: SPACE.xl }}><ActivityIndicator color={C.text3} /></View>
    : inCommit && !file ? <View style={{ padding: SPACE.lg }}><Card><Note>This file is not in that commit.</Note></Card></View>
    : <View style={{ padding: SPACE.lg }}><Card><Note>{
      file?.binary ? "A binary file: there are no lines to show."
        : inCommit ? "This file has no line changes in this commit." : "No changes against the last commit."
    }</Note></Card></View>;

  const body = (
    <FlatList
      ref={list}
      style={{ flex: 1 }}
      data={rows}
      keyExtractor={(r) => r.key}
      renderItem={({ item }) => {
        if (item.t === "gap") { const g = gaps.find((x) => x.before === item.before); return g ? gapRow(g) : null; }
        if (item.t === "hunk") {
          return (
            <Text style={{
              width: wide ?? undefined, color: C.info, fontSize: T.small, fontFamily: MONO, backgroundColor: tint(C.info, 0.12),
              paddingHorizontal: SPACE.md, paddingVertical: SPACE.xs,
            }}>{item.header}</Text>
          );
        }
        return <Line line={item.line} old={item.line.oldNo} at={item.line.newNo} wide={wide} />;
      }}
      contentContainerStyle={{ paddingBottom: SPACE.xl }}
      refreshControl={
        <RefreshControl
          refreshing={pulling}
          onRefresh={() => { setPulling(true); void load().finally(() => setPulling(false)); }}
          tintColor={C.text3}
        />
      }
      ListEmptyComponent={empty}
      ListFooterComponent={
        (working?.truncated && !inCommit) ? (
          <View style={{ padding: SPACE.lg }}><Note>The diff is longer than this screen draws; the rest is on the computer.</Note></View>
        ) : null
      }
    />
  );

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={{ paddingHorizontal: SPACE.lg, paddingVertical: SPACE.sm, gap: 2 }}>
        <Text numberOfLines={1} ellipsizeMode="head" style={{ color: C.text, fontSize: 13.5, fontFamily: MONO, fontWeight: "600" }}>{path}</Text>
        {file && !file.binary ? (
          <View style={{ flexDirection: "row", gap: SPACE.sm }}>
            <Stats added={file.additions} removed={file.deletions} />
            <Text style={{ color: C.text3, fontSize: T.small }}>{inCommit ? "· this commit" : "· against the last commit"}</Text>
          </View>
        ) : null}
      </View>

      {inCommit && nav.index >= 0 ? (
        <View style={{ flexDirection: "row", gap: SPACE.sm, paddingHorizontal: SPACE.lg, paddingBottom: SPACE.sm }}>
          <Pressable
            accessibilityRole="button" accessibilityLabel="Previous file" disabled={!nav.prev} onPress={() => go(nav.prev)}
            style={({ pressed }) => ({ ...navBtn(), opacity: nav.prev ? 1 : 0.4, backgroundColor: pressed ? C.bg3 : C.bg2 })}
          >
            <View style={{ transform: [{ rotate: "180deg" }] }}><ChevronIcon color={C.text2} size={18} /></View>
          </Pressable>
          <Pressable
            accessibilityRole="button" accessibilityLabel={`${name}, file ${nav.label}. Choose a file`} onPress={() => setJump(true)}
            style={({ pressed }) => ({ ...navBtn(), flex: 1, flexDirection: "row", gap: SPACE.sm, backgroundColor: pressed ? C.bg3 : C.bg2 })}
          >
            <Text numberOfLines={1} style={{ color: C.text, fontSize: T.body, fontWeight: "600", flexShrink: 1 }}>{name}</Text>
            <Text style={{ color: C.text3, fontSize: T.small }}>{nav.label}</Text>
            <Glyph name="down" color={C.text3} size={16} />
          </Pressable>
          <Pressable
            accessibilityRole="button" accessibilityLabel="Next file" disabled={!nav.next} onPress={() => go(nav.next)}
            style={({ pressed }) => ({ ...navBtn(), opacity: nav.next ? 1 : 0.4, backgroundColor: pressed ? C.bg3 : C.bg2 })}
          >
            <ChevronIcon color={C.text2} size={18} />
          </Pressable>
        </View>
      ) : null}

      {wrap ? body : (
        <ScrollView horizontal style={{ flex: 1 }} contentContainerStyle={{ width: wide ?? undefined }} nestedScrollEnabled>
          {body}
        </ScrollView>
      )}

      {!inCommit || nav.index >= 0 ? (
        <View style={{
          flexDirection: "row", gap: SPACE.sm, padding: SPACE.lg,
          borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.bg2,
        }}>
          {inCommit ? (
            <Btn
              label={viewed.has(String(path)) ? "Viewed" : "Mark viewed"}
              style={{ flex: 1 }}
              onPress={() => toggle(String(path))}
            />
          ) : null}
          {/* The file as it is on the computer now, in the Files screen: the
              diff is the question about the change, and the whole file is
              usually the next one. A deleted file has no whole to read. */}
          <Btn
            label="Whole file"
            style={{ flex: 1 }}
            disabled={file?.status === "deleted"}
            onPress={() => router.push({ pathname: "/files", params: { root: String(root), file: String(path) } })}
          />
          {inCommit ? (
            <Btn
              label={nav.next ? "Next file" : "Last file"}
              tone="primary"
              style={{ flex: 1 }}
              disabled={!nav.next}
              onPress={() => go(nav.next)}
            />
          ) : null}
        </View>
      ) : null}

      <Sheet open={jump} onClose={() => setJump(false)} title="Files in this diff">
        <Text style={{ color: C.text3, fontSize: T.small, paddingBottom: SPACE.md }}>
          {`${files.length} ${files.length === 1 ? "file" : "files"} · ${viewedLabel(paths, viewed)} · marks stay on this phone`}
        </Text>
        <View>
          {files.map((f, i) => {
            const here = f.path === path;
            return (
              <View
                key={f.path}
                style={[groupEdge(i === 0, i === files.length - 1), { flexDirection: "row", alignItems: "center", backgroundColor: here ? tint(C.primary, 0.12) : undefined }]}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Go to ${f.path}`}
                  onPress={() => { setJump(false); go(f.path); }}
                  style={({ pressed }) => ({
                    flex: 1, minWidth: 0, minHeight: 60, flexDirection: "row", alignItems: "center", gap: SPACE.md,
                    paddingLeft: SPACE.lg, backgroundColor: pressed ? C.bg3 : "transparent",
                  })}
                >
                  <StatusBadge status={f.status} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text numberOfLines={1} ellipsizeMode="head" style={{ color: C.text, fontSize: 13.5, fontFamily: MONO, fontWeight: "500" }}>{f.path}</Text>
                    {here ? <Text style={{ color: C.text3, fontSize: T.small }}>you are here</Text> : null}
                  </View>
                  <Stats added={f.added} removed={f.removed} />
                </Pressable>
                <ViewedBox on={viewed.has(f.path)} path={f.path} onPress={() => toggle(f.path)} />
              </View>
            );
          })}
        </View>
        <Text style={{ color: C.text3, fontSize: T.small, paddingTop: SPACE.md }}>
          Tick a file when you have read it. Nothing is sent anywhere.
        </Text>
      </Sheet>
    </View>
  );
}

/** A function, not a constant: `C` is replaced on a theme change and a style
 *  object built at import would keep the palette the app started in. */
const navBtn = () => ({
  minWidth: TAP, height: TAP, borderRadius: RADIUS.md, borderWidth: 1, borderColor: C.border,
  alignItems: "center", justifyContent: "center",
}) as const;
