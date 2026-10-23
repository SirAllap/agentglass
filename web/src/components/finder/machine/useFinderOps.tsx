// The finder's file operations, wired: what is chosen, what the menu offers, what
// each item asks the server for, and what is drawn while a name or a yes is
// awaited. The decisions are lib/finderOps.ts (tested); the work is /fs/op.
import { useCallback, useRef, useState } from "react";
import { api } from "../../../lib/api.ts";
import { clipPaths, deleteWords, doneNote, menuFor, menuHead, pasteOp, type Clip, type Item, type Target } from "../../../lib/finderOps.ts";
import { isFolder, joinPath, type Row } from "../../../lib/finderMiller.ts";
import type { FsBody } from "../../../../../shared/types.ts";
import { ConfirmDialog, ContextMenu, NameDialog } from "./FinderOpsUI.tsx";
import { CompressDialog, FolderPicker, PropsDialog } from "./FinderDialogs.tsx";

/** What the next step builds; until then the item says so instead of doing nothing. */
const NOT_YET = new Set(["open-in"]);

export interface Chosen { dir: string; rows: Row[] }

export interface OpsEnv {
  /** What is chosen now: the keyboard's target. Null when nothing is. */
  chosen: () => Chosen | null;
  /** The rows of a folder the finder shows, for the names that are taken. */
  rowsIn: (dir: string) => Row[];
  /** The folder a paste or a new folder lands in when nothing is chosen. */
  here: () => string;
  /** Choose a row (a right click on one that is not chosen yet). */
  choose: (dir: string, name: string) => void;
  reload: (dir: string) => void;
  say: (s: string) => void;
  hidden: boolean;
  /** The folders pinned to the sidebar, and the one switch that pins or unpins. */
  pins: readonly string[];
  togglePin: (path: string) => void;
  /** The home folder, which the menu header writes as ~. */
  home: string;
  toggleHidden: () => void;
  selectAll: () => void;
  open: (dir: string, row: Row) => void;
  preview: () => void;
  copyText: (s: string, said: string) => void;
  terminal: (dir: string) => void;
}

type Ask =
  | { k: "name"; title: string; sub?: string; initial: string; taken: string[]; confirm: string; run: (name: string) => void }
  | { k: "delete"; names: string[]; run: () => void }
  | { k: "compress"; c: Chosen }
  | { k: "props"; path: string; dir: string; name: string }
  | { k: "pick"; op: "move" | "copy"; c: Chosen };

export function useFinderOps(env: OpsEnv) {
  const [clip, setClip] = useState<Clip | null>(null);
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; target: Target; dir: string; rows: Row[] } | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const envRef = useRef(env); envRef.current = env;
  const clipRef = useRef(clip); clipRef.current = clip;

  const run = useCallback(async (body: FsBody, dirs: string[], name: string, count: number) => {
    const e = envRef.current;
    const r = await api.fsOp(body);
    for (const d of new Set(dirs)) e.reload(d);
    if (!r.ok) { e.say(r.error ?? "That did not work"); return false; }
    if (r.job && r.job.state === "running") e.say(`${r.job.label}…`);
    else e.say(`${doneNote(body.op, count, name)}${r.undo?.available ? " — Ctrl+Z undoes it" : ""}`);
    return true;
  }, []);

  const paths = (c: Chosen) => c.rows.map((r) => joinPath(c.dir, r.name));
  const names = (c: Chosen) => c.rows.map((r) => r.name);

  const paste = useCallback((into: string) => {
    const c = clipRef.current;
    const p = pasteOp(c, into);
    if (p === "empty") { envRef.current.say("Nothing to paste"); return; }
    if (p === "nothing") { envRef.current.say("It is already in that folder"); return; }
    const n = c!.names.length;
    void run({ op: p.op, paths: clipPaths(c!), dest: into, conflict: p.conflict }, [c!.dir, into], n === 1 ? c!.names[0]! : "", n).then((ok) => { if (ok && c!.mode === "cut") setClip(null); });
  }, [run]);

  const startName = (a: Omit<Extract<Ask, { k: "name" }>, "k">) => setAsk({ k: "name", ...a });

  /** Run one menu item or one key on a target. `into` is the folder a new thing lands in. */
  const doItem = useCallback((id: Item["id"], c: Chosen | null, into: string) => {
    const e = envRef.current;
    if (NOT_YET.has(id)) { e.say("That one is coming in the next step"); return; }
    const need = (): Chosen | null => { if (!c || !c.rows.length) { e.say("Nothing is chosen"); return null; } return c; };
    switch (id) {
      case "cut": case "copy": { const t = need(); if (!t) return; setClip({ mode: id === "cut" ? "cut" : "copy", dir: t.dir, names: names(t) }); e.say(`${id === "cut" ? "Cut" : "Copied"} ${t.rows.length === 1 ? t.rows[0]!.name : `${t.rows.length} items`}`); return; }
      case "paste": paste(into); return;
      case "duplicate": { const t = need(); if (t) void run({ op: "duplicate", paths: paths(t) }, [t.dir], t.rows[0]!.name, t.rows.length); return; }
      case "rename": {
        const t = need(); if (!t) return;
        if (t.rows.length > 1) { e.say("Rename takes one item"); return; }
        const was = t.rows[0]!.name;
        startName({ title: "Rename", sub: `in ${t.dir}`, initial: was, taken: e.rowsIn(t.dir).map((r) => r.name), confirm: "Rename", run: (n) => { void run({ op: "rename", path: joinPath(t.dir, was), name: n }, [t.dir], n, 1); } });
        return;
      }
      case "new-folder": case "new-file": {
        const isDir = id === "new-folder";
        startName({ title: isDir ? "New Folder" : "New File", sub: `in ${into}`, initial: isDir ? "New Folder" : "New File", taken: e.rowsIn(into).map((r) => r.name), confirm: "Create", run: (n) => { void run({ op: isDir ? "mkdir" : "newfile", parent: into, name: n }, [into], n, 1); } });
        return;
      }
      case "folder-with": {
        const t = need(); if (!t) return;
        startName({ title: "New Folder with Selection", sub: `${t.rows.length === 1 ? t.rows[0]!.name : `${t.rows.length} items`} go into it`, initial: "New Folder", taken: e.rowsIn(t.dir).map((r) => r.name), confirm: "Create", run: (n) => { void run({ op: "folder-with", paths: paths(t), name: n }, [t.dir], n, 1); } });
        return;
      }
      case "trash": { const t = need(); if (t) void run({ op: "trash", paths: paths(t) }, [t.dir], t.rows[0]!.name, t.rows.length); return; }
      case "delete": { const t = need(); if (t) setAsk({ k: "delete", names: names(t), run: () => { void run({ op: "delete", paths: paths(t), confirm: t.rows.length }, [t.dir], t.rows[0]!.name, t.rows.length); } }); return; }
      case "compress": { const t = need(); if (t) setAsk({ k: "compress", c: t }); return; }
      case "props": {
        const t = need(); if (!t) return;
        if (t.rows.length > 1) { e.say("Properties takes one item"); return; }
        setAsk({ k: "props", path: joinPath(t.dir, t.rows[0]!.name), dir: t.dir, name: t.rows[0]!.name });
        return;
      }
      case "move-to": case "copy-to": { const t = need(); if (t) setAsk({ k: "pick", op: id === "move-to" ? "move" : "copy", c: t }); return; }
      case "pin": {
        const t = need(); if (!t) return;
        const row = t.rows[0]!;
        if (t.rows.length !== 1 || !isFolder(row)) { e.say("Only one folder can be pinned"); return; }
        const path = joinPath(t.dir, row.name);
        e.togglePin(path);
        e.say(e.pins.includes(path) ? `Unpinned ${row.name}` : `Pinned ${row.name}`);
        return;
      }
      case "open": { const t = need(); if (t) e.open(t.dir, t.rows[0]!); return; }
      case "preview": e.preview(); return;
      case "terminal": e.terminal(c && c.rows.length === 1 && isFolder(c.rows[0]!) ? joinPath(c.dir, c.rows[0]!.name) : into); return;
      case "copy-path": { const t = need(); if (t) e.copyText(paths(t).join("\n"), t.rows.length === 1 ? `Copied ${paths(t)[0]}` : `Copied ${t.rows.length} paths`); return; }
      case "copy-name": { const t = need(); if (t) e.copyText(names(t).join("\n"), t.rows.length === 1 ? `Copied ${names(t)[0]}` : `Copied ${t.rows.length} names`); return; }
      case "select-all": e.selectAll(); return;
      case "refresh": e.reload(into); return;
      case "hidden": e.toggleHidden(); return;
      default: e.say("That one is not available here");
    }
  }, [paste, run]);

  /** A Strata key, on whatever is chosen. */
  const key = useCallback((t: string): boolean => {
    const e = envRef.current;
    const c = e.chosen();
    const into = c ? c.dir : e.here();
    const map: Record<string, Item["id"] | undefined> = { cut: "cut", copyfiles: "copy", paste: "paste", duplicate: "duplicate", rename: "rename", trash: "trash", delete: "delete", newfolder: "new-folder", folderwith: "folder-with", props: "props", pin: "pin" };
    if (t === "undo") { void run({ op: "undo" }, [e.here()], "", 1).then(() => { for (const d of [into, e.here()]) e.reload(d); }); return true; }
    const id = map[t];
    if (!id) return false;
    doItem(id, c, id === "paste" || id === "new-folder" ? (c && c.rows.length === 1 && isFolder(c.rows[0]!) && id === "paste" ? joinPath(c.dir, c.rows[0]!.name) : e.here()) : into);
    return true;
  }, [doItem, run]);

  /** A right click. `dir` is the folder of the column it landed in, `name` the row, null in the empty space. */
  const contextAt = useCallback((x: number, y: number, dir: string, name: string | null) => {
    const e = envRef.current;
    const cur = e.chosen();
    let rows: Row[] = [];
    if (name) {
      const row = e.rowsIn(dir).find((r) => r.name === name);
      if (!row) return;
      if (cur && cur.dir === dir && cur.rows.length > 1 && cur.rows.some((r) => r.name === name)) rows = cur.rows;
      else { rows = [row]; e.choose(dir, name); }
    }
    setMenu({ at: { x, y }, target: !name ? "empty" : rows.length === 1 && isFolder(rows[0]!) ? "folder" : "file", dir, rows });
  }, []);

  const nodes = (
    <>
      {menu && (() => {
        const e = env;
        const groups = menuFor(menu.target, { count: menu.rows.length, canPaste: !!clip, hidden: e.hidden, pinned: menu.rows.length === 1 && e.pins.includes(joinPath(menu.dir, menu.rows[0]!.name)), previewable: menu.rows.length === 1 && !isFolder(menu.rows[0]!) });
        const head = menu.rows.length ? menuHead(menu.rows.map((r) => r.name), menu.dir, e.home) : null;
        return (
          <ContextMenu at={menu.at} head={head} groups={groups} onClose={() => setMenu(null)}
            onPick={(i) => {
              setMenu(null);
              if (i.later) { e.say(`${i.later} is not built yet`); return; }
              const into = menu.target === "folder" ? joinPath(menu.dir, menu.rows[0]!.name) : menu.dir;
              doItem(i.id, menu.rows.length ? { dir: menu.dir, rows: menu.rows } : null, i.id === "paste" || i.id === "new-folder" || i.id === "new-file" || i.id === "refresh" ? into : menu.dir);
            }} />
        );
      })()}
      {ask?.k === "name" && <NameDialog title={ask.title} sub={ask.sub} initial={ask.initial} taken={ask.taken} confirm={ask.confirm} onClose={() => setAsk(null)} onSubmit={(n) => { const f = ask.run; setAsk(null); f(n); }} />}
      {ask?.k === "compress" && (() => { const c = ask.c; return <CompressDialog names={names(c)} dirs={c.rows.map(isFolder)} onClose={() => setAsk(null)}
        onSubmit={(o) => { setAsk(null); void run({ op: "compress", paths: paths(c), name: o.name, format: o.format, password: o.password }, [c.dir], o.name, c.rows.length); }} />; })()}
      {ask?.k === "props" && (() => { const a = ask; return <PropsDialog path={a.path} home={env.home} pinned={env.pins.includes(a.path)} onClose={() => setAsk(null)}
        onChmod={(mode) => run({ op: "chmod", path: a.path, mode }, [a.dir], a.name, 1)}
        onRename={() => { setAsk(null); doItem("rename", { dir: a.dir, rows: envRef.current.rowsIn(a.dir).filter((r) => r.name === a.name) }, a.dir); }}
        onCopyPath={() => envRef.current.copyText(a.path, `Copied ${a.path}`)} />; })()}
      {ask?.k === "pick" && (() => { const c = ask.c; return <FolderPicker op={ask.op} paths={paths(c)} start={c.dir} home={env.home} onClose={() => setAsk(null)}
        onPick={(dest) => { const op = ask.op; setAsk(null); void run({ op, paths: paths(c), dest, conflict: "keep-both" }, [c.dir, dest], c.rows[0]!.name, c.rows.length); }} />; })()}
      {ask?.k === "delete" && (() => { const w = deleteWords(ask.names); return <ConfirmDialog title={w.title} body={w.body} confirm="Permanently delete" onClose={() => setAsk(null)} onConfirm={() => { const f = ask.run; setAsk(null); f(); }} />; })()}
    </>
  );

  return { clip, contextAt, key, nodes, hasMenu: !!menu || !!ask };
}
