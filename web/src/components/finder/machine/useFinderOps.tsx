// The finder's file operations, wired: what is chosen, what the menu offers, what
// each item asks the server for, and what is drawn while a name or a yes is
// awaited. The decisions are lib/finderOps.ts (tested); the work is /fs/op.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../../lib/api.ts";
import { clipPaths, deleteWords, doneNote, dropPlan, menuFor, menuHead, pasteOp, type Clip, type Item, type Target } from "../../../lib/finderOps.ts";
import { isFolder, joinPath, type Row } from "../../../lib/finderMiller.ts";
import type { FsBody, FsJob } from "../../../../../shared/types.ts";
import { ConfirmDialog, ContextMenu, InlineName, Sheet, type InlineEdit } from "./FinderOpsUI.tsx";
import { printable, printUrl } from "../../../lib/finderPrint.ts";
import { JobsPanel } from "./FinderJobs.tsx";
import { CompressDialog, OpenWithDialog, FolderPicker, PropsDialog, TrashPanel } from "./FinderDialogs.tsx";

/** What the next step builds; until then the item says so instead of doing nothing. */
const NOT_YET = new Set<string>();

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
  /** Only the columns draw a name in place; the icons and the list ask for it in a small box. */
  columnsView: boolean;
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
  /** A folder in a new tab. */
  openTab: (path: string) => void;
}

type Ask =
  | { k: "delete"; names: string[]; run: () => void }
  | { k: "compress"; c: Chosen }
  | { k: "props"; path: string; dir: string; name: string }
  | { k: "trash" }
  | { k: "openwith"; paths: string[] }
  | { k: "pick"; op: "move" | "copy"; c: Chosen };

export function useFinderOps(env: OpsEnv) {
  const [clip, setClip] = useState<Clip | null>(null);
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; target: Target; dir: string; rows: Row[] } | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  /** The name being typed in place, in the column it belongs to (Strata edits in the row, not in a box). */
  const [edit, setEdit] = useState<InlineEdit | null>(null);
  /** Long copies and moves, asked for only while one runs: no timer sits idle when nothing is going on. */
  const [jobs, setJobs] = useState<FsJob[]>([]);
  const [polling, setPolling] = useState(false);
  useEffect(() => {
    if (!polling) return;
    let off = false;
    const tick = async () => {
      const r = await api.fsJobs().catch(() => null);
      if (off) return;
      const list = r?.jobs ?? [];
      setJobs(list);
      if (list.some((j) => j.state === "running")) t = setTimeout(tick, 700);
      else t = setTimeout(() => { if (!off) setPolling(false); }, 4200); // the panel keeps a finished job a few seconds, then the asking stops
    };
    let t = setTimeout(tick, 0);
    return () => { off = true; clearTimeout(t); };
  }, [polling]);
  const envRef = useRef(env); envRef.current = env;
  const clipRef = useRef(clip); clipRef.current = clip;

  const run = useCallback(async (body: FsBody, dirs: string[], name: string, count: number) => {
    const e = envRef.current;
    const r = await api.fsOp(body);
    for (const d of new Set(dirs)) e.reload(d);
    if (!r.ok) { e.say(r.error ?? "That did not work"); return false; }
    if (r.job && r.job.state === "running") { e.say(`${r.job.label}…`); setPolling(true); }
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

  const startName = (a: Omit<InlineEdit, "end">) => setEdit({ ...a, end: () => setEdit(null) });

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
        startName({ dir: t.dir, was, isDir: isFolder(t.rows[0]!), initial: was, taken: e.rowsIn(t.dir).map((r) => r.name), run: (n) => { void run({ op: "rename", path: joinPath(t.dir, was), name: n }, [t.dir], n, 1); } });
        return;
      }
      case "new-folder": case "new-file": {
        const isDir = id === "new-folder";
        startName({ dir: into, was: null, isDir, initial: isDir ? "New Folder" : "New File", taken: e.rowsIn(into).map((r) => r.name), run: (n) => { void run({ op: isDir ? "mkdir" : "newfile", parent: into, name: n }, [into], n, 1); } });
        return;
      }
      case "folder-with": {
        const t = need(); if (!t) return;
        startName({ dir: t.dir, was: null, isDir: true, initial: "New Folder", taken: e.rowsIn(t.dir).map((r) => r.name), run: (n) => { void run({ op: "folder-with", paths: paths(t), name: n }, [t.dir], n, 1); } });
        return;
      }
      case "trash": { const t = need(); if (t) void run({ op: "trash", paths: paths(t) }, [t.dir], t.rows[0]!.name, t.rows.length); return; }
      case "delete": { const t = need(); if (t) setAsk({ k: "delete", names: names(t), run: () => { void run({ op: "delete", paths: paths(t), confirm: t.rows.length }, [t.dir], t.rows[0]!.name, t.rows.length); } }); return; }
      case "compress": { const t = need(); if (t) setAsk({ k: "compress", c: t }); return; }
      case "props": {
        // In the empty space of a column it is the folder itself that has properties.
        if (!c || !c.rows.length) { const at = into.lastIndexOf("/"); setAsk({ k: "props", path: into, dir: at > 0 ? into.slice(0, at) : "/", name: into.slice(at + 1) }); return; }
        const t = c;
        if (t.rows.length > 1) { e.say("Properties takes one item"); return; }
        setAsk({ k: "props", path: joinPath(t.dir, t.rows[0]!.name), dir: t.dir, name: t.rows[0]!.name });
        return;
      }
      case "open-with": {
        // On the empty space it is the folder itself.
        const ps = c && c.rows.length ? paths(c) : [into];
        setAsk({ k: "openwith", paths: ps });
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
      case "open-in": { const t = need(); if (!t) return; const r = t.rows[0]!; if (t.rows.length !== 1 || !isFolder(r)) { e.say("Only one folder opens in a tab"); return; } e.openTab(joinPath(t.dir, r.name)); return; }
      case "print": {
        const t = need(); if (!t) return;
        const r = t.rows[0]!;
        if (t.rows.length !== 1 || isFolder(r)) { e.say("Print takes one file"); return; }
        if (!printable(r.name)) { e.say(`${r.name} is not something the browser can print`); return; }
        e.say(`Printing ${r.name}`); void printUrl(api.previewUrl(joinPath(t.dir, r.name))).catch(() => e.say(`${r.name} could not be printed`)); return;
      }
      case "terminal": e.terminal(c && c.rows.length === 1 && isFolder(c.rows[0]!) ? joinPath(c.dir, c.rows[0]!.name) : into); return;
      case "copy-path": { const t = need(); if (t) e.copyText(paths(t).join("\n"), t.rows.length === 1 ? `Copied ${paths(t)[0]}` : `Copied ${t.rows.length} paths`); return; }
      case "copy-name": { const t = need(); if (t) e.copyText(names(t).join("\n"), t.rows.length === 1 ? `Copied ${names(t)[0]}` : `Copied ${t.rows.length} names`); return; }
      case "select-all": e.selectAll(); return;
      case "refresh": e.reload(into); return;
      case "hidden": e.toggleHidden(); return;
      default: e.say("That one is not available here");
    }
  }, [paste, run]);

  /** What is being dragged: the chosen rows when the one picked up is among them, else just it. */
  const drag = useRef<{ dir: string; names: string[] } | null>(null);
  const dragStart = useCallback((dir: string, name: string) => {
    const c = envRef.current.chosen();
    const names = c && c.dir === dir && c.rows.some((r) => r.name === name) ? c.rows.map((r) => r.name) : [name];
    drag.current = { dir, names };
    return names;
  }, []);
  const dragEnd = useCallback(() => { drag.current = null; }, []);
  /** Whether a drop on `dest` would do anything, and what (null = refuse, so the pointer says no). */
  const dropAllows = useCallback((dest: string, ctrl: boolean): "move" | "copy" | null => {
    const d = drag.current;
    if (!d) return null;
    const p = dropPlan(d.dir, d.names, dest, ctrl);
    return typeof p === "string" ? null : p.op;
  }, []);
  const dropOn = useCallback((dest: string, ctrl: boolean, trash = false) => {
    const d = drag.current; drag.current = null;
    if (!d) return;
    const ps = d.names.map((n) => joinPath(d.dir, n));
    const one = d.names.length === 1 ? d.names[0]! : "";
    if (trash) { void run({ op: "trash", paths: ps }, [d.dir], one, d.names.length); return; }
    const p = dropPlan(d.dir, d.names, dest, ctrl);
    if (p === "inside") { envRef.current.say("A folder cannot go into itself"); return; }
    if (p === "nothing") return;
    void run({ op: p.op, paths: ps, dest, conflict: p.conflict }, [d.dir, dest], one, d.names.length);
  }, [run]);

  /** A Strata key, on whatever is chosen. */
  const key = useCallback((t: string): boolean => {
    const e = envRef.current;
    const c = e.chosen();
    const into = c ? c.dir : e.here();
    const map: Record<string, Item["id"] | undefined> = { cut: "cut", copyfiles: "copy", paste: "paste", duplicate: "duplicate", rename: "rename", trash: "trash", delete: "delete", newfolder: "new-folder", folderwith: "folder-with", props: "props", pin: "pin", opentab: "open-in" };
    if (t === "redo") { void run({ op: "redo" }, [e.here()], "", 1).then(() => { for (const d of [into, e.here()]) e.reload(d); }); return true; }
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
      {edit && !env.columnsView && <Sheet label={edit.was ? "Rename" : "New name"} onClose={edit.end} width={320}><InlineName edit={edit} rowH={32} icon={null} /></Sheet>}
      <JobsPanel jobs={jobs} onCancel={(id) => { void api.fsJobCancel(id); }} onDone={(j) => { if (j.state === "done") envRef.current.reload(envRef.current.here()); }} />
      {ask?.k === "compress" && (() => { const c = ask.c; return <CompressDialog names={names(c)} dirs={c.rows.map(isFolder)} onClose={() => setAsk(null)}
        onSubmit={(o) => { setAsk(null); void run({ op: "compress", paths: paths(c), name: o.name, format: o.format, password: o.password }, [c.dir], o.name, c.rows.length); }} />; })()}
      {ask?.k === "props" && (() => { const a = ask; return <PropsDialog path={a.path} home={env.home} pinned={env.pins.includes(a.path)} onClose={() => setAsk(null)}
        onChmod={(mode) => run({ op: "chmod", path: a.path, mode }, [a.dir], a.name, 1)}
        onRename={() => { setAsk(null); doItem("rename", { dir: a.dir, rows: envRef.current.rowsIn(a.dir).filter((r) => r.name === a.name) }, a.dir); }}
        onCopyPath={() => envRef.current.copyText(a.path, `Copied ${a.path}`)} />; })()}
      {ask?.k === "pick" && (() => { const c = ask.c; return <FolderPicker op={ask.op} paths={paths(c)} start={c.dir} home={env.home} onClose={() => setAsk(null)}
        onPick={(dest) => { const op = ask.op; setAsk(null); void run({ op, paths: paths(c), dest, conflict: "keep-both" }, [c.dir, dest], c.rows[0]!.name, c.rows.length); }} />; })()}
      {ask?.k === "openwith" && (() => { const ps = ask.paths; return <OpenWithDialog paths={ps} onClose={() => setAsk(null)}
        onLaunch={(id, always) => { setAsk(null); void api.openWithLaunch(id, ps, always ?? undefined).then((r) => envRef.current.say(r.ok ? (r.note ?? "Opened") : (r.error ?? "That did not open"))); }} />; })()}
      {ask?.k === "trash" && <TrashPanel home={env.home} onClose={() => setAsk(null)} onRestored={(dirs, said) => { for (const d of dirs) envRef.current.reload(d); envRef.current.say(said); }} />}
      {ask?.k === "delete" && (() => { const w = deleteWords(ask.names); return <ConfirmDialog title={w.title} body={w.body} confirm="Permanently delete" onClose={() => setAsk(null)} onConfirm={() => { const f = ask.run; setAsk(null); f(); }} />; })()}
    </>
  );

  return { clip, openTrash: () => setAsk({ k: "trash" }), contextAt, key, nodes, edit, dragStart, dragEnd, dropAllows, dropOn, hasMenu: !!menu || !!ask || !!edit };
}
