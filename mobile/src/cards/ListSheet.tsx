/*
 * The list selector: a sheet that says where you are and lets you go anywhere.
 *
 * One choice and no footer: a tap on a list opens it and closes the sheet. The
 * boards the computer already keeps come first and cost nothing (they arrived
 * with the screen); below them the workspace unfolds on demand — the spaces in
 * one read, a space's folders and lists in another when somebody drills in,
 * each remembered for ten minutes so going back and forth is free. Search
 * narrows what has been read and never reads more.
 *
 * What each row means is decided in model/cardSelector.ts.
 */
import { useCallback, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { SavedView } from "../../../shared/providers.ts";
import { askCached } from "../lib/api.ts";
import type { Host } from "../lib/host.ts";
import { Glyph, type GlyphName } from "../nav/glyphs.tsx";
import { PrSearchRow } from "../review/PrSearchRow.tsx";
import { boardEntries, matchSpaces, spaceTree, type BoardEntry, type FolderShape, type SpaceShape, type TreeRow } from "../model/cardSelector.ts";
import { Group, GroupTitle, Note, Row, Sheet } from "../ui.tsx";
import { C, SPACE, T, tint } from "../theme.ts";

/** Long enough that a back-and-forth is free, short enough that a list added
 *  on the desk shows up in the same sitting. */
const FRESH_MS = 10 * 60_000;

type Read<T> = { ok: boolean; error?: string } & T;

function Tick(): React.ReactNode { return <Glyph name="check" color={C.primary} size={20} weight={2.6} />; }

/** The row of the board that is open: the same row, on a tint. */
function Current({ on, children }: { on: boolean; children: React.ReactNode }): React.ReactNode {
  return <View style={{ backgroundColor: on ? tint(C.primary, 0.12) : "transparent" }}>{children}</View>;
}

function BoardRow({ e, glyph, onPress }: { e: BoardEntry; glyph: GlyphName; onPress: () => void }): React.ReactNode {
  return (
    <Current on={e.on}>
      <Row
        title={e.name} sub={e.path || undefined} onPress={onPress}
        lead={<Glyph name={glyph} color={e.on ? C.primary : C.text2} size={22} />}
        trail={e.on ? <Tick /> : undefined}
      />
    </Current>
  );
}

function Retry({ onPress }: { onPress: () => void }): React.ReactNode {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={{ minHeight: 48, justifyContent: "center" }}>
      <Text style={{ color: C.primary, fontSize: T.body, fontWeight: "600" }}>Try again</Text>
    </Pressable>
  );
}

function TreeRows({ rows, onFolder, onList }: {
  rows: TreeRow[]; onFolder: (id: string) => void; onList: (id: string) => void;
}): React.ReactNode {
  return (
    <Group>
      {rows.map((r) => r.kind === "folder" ? (
        <Row
          key={`f:${r.id}`} title={r.name} onPress={() => onFolder(r.id)}
          lead={<Glyph name="folder" color={C.text2} size={22} />}
          /* Its own chevron, turned: the shared one only points right. */
          trail={(
            <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
              <Text style={{ color: C.text3, fontSize: T.small, fontVariant: ["tabular-nums"] }}>{r.lists}</Text>
              <View style={{ transform: [{ rotate: r.open ? "0deg" : "-90deg" }] }}><Glyph name="down" color={C.text3} size={18} /></View>
            </View>
          )}
        />
      ) : (
        <Current key={`l:${r.id}`} on={r.on}>
          <Row
            title={r.name} onPress={() => onList(r.id)}
            lead={<View style={{ marginLeft: r.depth ? 24 : 0 }}><Glyph name="list" color={r.on ? C.primary : C.text2} size={22} /></View>}
            trail={r.on ? <Tick /> : r.tasks !== undefined ? <Text style={{ color: C.text3, fontSize: T.small, fontVariant: ["tabular-nums"] }}>{r.tasks}</Text> : undefined}
          />
        </Current>
      ))}
    </Group>
  );
}

export function ListSheet({ open, onClose, host, views, current, onBoard, onList }: {
  open: boolean;
  onClose: () => void;
  host: Host;
  /** The boards the computer keeps, read with the screen. */
  views: readonly SavedView[];
  current: string | null;
  onBoard: (viewId: string) => void;
  /** A list from the workspace: the screen opens the board it already has for
   *  it, or adds one. */
  onList: (listId: string) => void;
}): React.ReactNode {
  const [q, setQ] = useState("");
  const [space, setSpace] = useState<SpaceShape | null>(null);
  const [spaces, setSpaces] = useState<SpaceShape[] | null>(null);
  const [folders, setFolders] = useState<Record<string, FolderShape[]>>({});
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const readSpaces = useCallback((force = false) => {
    setError(null);
    void askCached<Read<{ spaces?: SpaceShape[] }>>(host, "/clickup/spaces", FRESH_MS, force).then((a) => {
      if (!a.ok || !a.value.ok) { setError(a.ok ? a.value.error ?? "The workspace could not be read." : a.error); return; }
      setSpaces(a.value.spaces ?? []);
    });
  }, [host]);

  const readFolders = useCallback((s: SpaceShape, force = false) => {
    setError(null);
    void askCached<Read<{ folders?: FolderShape[] }>>(host, `/clickup/folders?space=${encodeURIComponent(s.id)}`, FRESH_MS, force).then((a) => {
      if (!a.ok || !a.value.ok) { setError(a.ok ? a.value.error ?? "That space could not be read." : a.error); return; }
      setFolders((was) => ({ ...was, [s.id]: a.value.folders ?? [] }));
    });
  }, [host]);

  // Each opening starts at the top with an empty box; what was read stays.
  useEffect(() => {
    if (!open) return;
    setQ(""); setSpace(null); setError(null);
    if (!spaces) readSpaces();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const drill = (s: SpaceShape): void => {
    setSpace(s); setQ("");
    if (!folders[s.id]) readFolders(s);
  };
  const toggle = (id: string): void => setOpened((was) => {
    const next = new Set(was);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  const pick = (run: () => void): void => { onClose(); run(); };

  const boards = boardEntries(views, current, q);
  const inSpace = space ? folders[space.id] : undefined;
  const loaded = spaces ? matchSpaces(spaces, q) : [];
  // Lists found in spaces already read, so a search at the top reaches them.
  const found = q.trim()
    ? (spaces ?? []).map((s) => ({ s, rows: spaceTree(folders[s.id] ?? [], opened, views, current, q) })).filter((x) => x.rows.length)
    : [];

  return (
    <Sheet
      open={open} onClose={onClose} tall title={space ? space.name : "Choose a list"}
      subtitle={space ? "Workspace · tap a list to open it" : "Tap a list to open it · one choice"}
    >
      <View style={{ gap: SPACE.sm, paddingBottom: SPACE.md }}>
        {space ? (
          <Pressable
            accessibilityRole="button" accessibilityLabel="Back to all spaces" onPress={() => { setSpace(null); setQ(""); }}
            style={{ minHeight: 48, flexDirection: "row", alignItems: "center", gap: SPACE.sm }}
          >
            <View style={{ transform: [{ rotate: "90deg" }] }}><Glyph name="down" color={C.primary} size={18} /></View>
            <Text style={{ color: C.primary, fontSize: T.body, fontWeight: "600" }}>Lists</Text>
          </Pressable>
        ) : null}
        <PrSearchRow value={q} onChange={setQ} placeholder="Find a list or folder" label="Find a list or folder" />

        {space ? (
          <>
            {inSpace ? (
              <TreeRows
                rows={spaceTree(inSpace, opened, views, current, q)} onFolder={toggle}
                onList={(id) => pick(() => onList(id))}
              />
            ) : error ? null : <Note>Reading {space.name}…</Note>}
            {inSpace && !spaceTree(inSpace, opened, views, current, q).length ? <Note>Nothing here matches “{q.trim()}”.</Note> : null}
            {error ? <Note tone="bad">{error}</Note> : null}
            {error ? <Retry onPress={() => readFolders(space, true)} /> : null}
          </>
        ) : (
          <>
            {boards.assigned ? (
              <Group>{[<BoardRow key="me" e={boards.assigned} glyph="people" onPress={() => pick(() => onBoard(boards.assigned!.id))} />]}</Group>
            ) : null}
            {boards.groups.map((g) => (
              <View key={g.heading}>
                <GroupTitle text={g.heading.toUpperCase()} />
                <Group>
                  {g.entries.map((e) => <BoardRow key={e.id} e={e} glyph="list" onPress={() => pick(() => onBoard(e.id))} />)}
                </Group>
              </View>
            ))}
            {found.map(({ s, rows }) => (
              <View key={`found:${s.id}`}>
                <GroupTitle text={s.name.toUpperCase()} />
                <TreeRows rows={rows} onFolder={toggle} onList={(id) => pick(() => onList(id))} />
              </View>
            ))}
            <GroupTitle text="WORKSPACE" />
            {loaded.length ? (
              <Group>
                {loaded.map((s) => (
                  <Row key={s.id} title={s.name} chevron onPress={() => drill(s)} lead={<Glyph name="folder" color={C.text2} size={22} />} />
                ))}
              </Group>
            ) : spaces ? <Note>{q.trim() ? `No space matches “${q.trim()}”.` : "This workspace has no spaces."}</Note>
              : error ? null : <Note>Reading the workspace…</Note>}
            {error ? <Note tone="bad">{error}</Note> : null}
            {error ? <Retry onPress={() => readSpaces(true)} /> : null}
          </>
        )}
      </View>
    </Sheet>
  );
}
