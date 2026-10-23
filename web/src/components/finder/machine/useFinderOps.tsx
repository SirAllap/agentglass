// The finder's file operations, wired: what is chosen, what the menu offers, what
// each item asks the server for, and what is drawn while a name or a yes is
// awaited. The decisions are lib/finderOps.ts (tested); the work is /fs/op.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../../../lib/api.ts";
import { failedNote, clipPaths, deleteWords, doneNote, dropAsks, dropPlan, freeName, menuFor, menuHead, pasteOp, withActions, type Clip, type Item, type Target } from "../../../lib/finderOps.ts";
import { actionGroup, confirmWords } from "../../../lib/finderActions.ts";
import { isFolder, isRecent, joinPath, type Row } from "../../../lib/finderMiller.ts";
import { inTrash } from "../../../lib/finderPointer.ts";
import type { FinderAction, FsBody, FsJob } from "../../../../../shared/types.ts";
import { ConfirmDialog, ContextMenu, InlineName, Sheet, TransferDialog, type InlineEdit } from "./FinderOpsUI.tsx";
import { printable, printUrl } from "../../../lib/finderPrint.ts";
import { JobsPanel } from "./FinderJobs.tsx";
import { clearStage, peekStage, subscribeStage } from "../../../lib/stageIntent.ts";
import { stageRun, type FinderStageArgs } from "../../../lib/finderStage.ts";
import { StageDialog } from "./FinderStage.tsx";
import { CustomizeDialog } from "./FinderCustomize.tsx";
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
  /** The folder of the column under the pointer, when the pointer was the last thing used; where Ctrl+V pastes then. */
  pasteDir: () => string | null;
  /** Empty a folder's name filter, so a folder made there is on screen. */
  clearFilter: (dir: string) => void;
}

type Ask =
  | { k: "transfer"; n: number; go: (op: "copy" | "move") => void }
  | { k: "delete"; names: string[]; run: () => void }
  | { k: "compress"; c: Chosen }
  | { k: "props"; path: string; dir: string; name: string }
  | { k: "trash" }
  | { k: "openwith"; paths: string[] }
  | { k: "customize"; paths: string[]; names: string[]; isDir: boolean }
  | { k: "action"; action: FinderAction; paths: string[]; source: "selection" | "background" }
  | { k: "pick"; op: "move" | "copy"; c: Chosen }
  | { k: "stage"; a: FinderStageArgs; by: string; n: number };

export function useFinderOps(env: OpsEnv) {
  const [clip, setClip] = useState<Clip | null>(null);
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; target: Target; dir: string; rows: Row[]; actions: FinderAction[] } | null>(null);
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
    if (!r.ok) { e.say(failedNote(body.op, r.error)); return false; }
    if (r.job && r.job.state === "running") { e.say(`${r.job.label}…`); setPolling(true); }
    else e.say(`${doneNote(body.op, count, name)}${r.undo?.available ? " — Ctrl+Z undoes it" : ""}`);
    return true;
  }, []);

  /* A file operation an agent prepared (finder.op.stage): taken off the mailbox and drawn as a confirmation. Nothing runs here; `run` is called from the dialog's button only. */
  const staged = useSyncExternalStore(subscribeStage, peekStage, () => null);
  useEffect(() => {
    if (!staged || staged.id !== "finder.op.stage") return;
    clearStage();
    setAsk({ k: "stage", a: staged.a, by: staged.by, n: staged.n });
  }, [staged]);

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

  /** Start one of the person's own actions; one that asks for a yes is confirmed first (the server asks again if it was skipped). */
  const startAction = useCallback((a: FinderAction, ps: string[], source: "selection" | "background", confirmed = false) => {
    const e = envRef.current;
    if (a.run.confirm && !confirmed) { setAsk({ k: "action", action: a, paths: ps, source }); return; }
    void api.actionRun(a.id, ps, source, confirmed || undefined).then((r) => {
      if (!r.ok) { e.say(r.error ?? `${a.name} did not start`); return; }
      e.say(`${a.name}…`); setPolling(true);
    });
  }, []);

  /** A folder just made by the key: its row is put in rename once the listing shows it. */
  const [justMade, setJustMade] = useState<{ dir: string; name: string; at: number } | null>(null);
  const startName = (a: Omit<InlineEdit, "end">) => setEdit({ ...a, end: () => setEdit(null) });

  /** Run one menu item or one key on a target. `into` is the folder a new thing lands in. */
  const doItem = useCallback((id: Item["id"], c: Chosen | null, into: string) => {
    const e = envRef.current;
    if (NOT_YET.has(id)) { e.say("That one is coming in the next step"); return; }
    /* Recent is a list of files from everywhere, not a folder: nothing is made or pasted into it, as in Strata. */
    if ((id === "new-folder" || id === "paste") && isRecent(into)) { e.say("Can\u2019t create items here"); return; }
    const need = (): Chosen | null => { if (!c || !c.rows.length) { e.say("Nothing is chosen"); return null; } return c; };
    switch (id) {
      case "cut": case "copy": { const t = need(); if (!t) return; setClip({ mode: id === "cut" ? "cut" : "copy", dir: t.dir, names: names(t) }); e.say(`${id === "cut" ? "Cut" : "Copied"} ${t.rows.length === 1 ? t.rows[0]!.name : `${t.rows.length} items`}`); return; }
      case "paste": paste(into); return;
      case "customize": {
        // Nothing chosen (the empty-space menu) customizes the folder itself.
        if (c && c.rows.length) setAsk({ k: "customize", paths: paths(c), names: names(c), isDir: c.rows.every(isFolder) });
        else setAsk({ k: "customize", paths: [into], names: [into.slice(into.lastIndexOf("/") + 1) || into], isDir: true });
        return;
      }
      case "duplicate": { const t = need(); if (t) void run({ op: "duplicate", paths: paths(t) }, [t.dir], t.rows[0]!.name, t.rows.length); return; }
      case "rename": {
        const t = need(); if (!t) return;
        if (t.rows.length > 1) { e.say("Rename takes one item"); return; }
        const was = t.rows[0]!.name;
        startName({ dir: t.dir, was, isDir: isFolder(t.rows[0]!), initial: was, taken: e.rowsIn(t.dir).map((r) => r.name), run: (n) => { void run({ op: "rename", path: joinPath(t.dir, was), name: n }, [t.dir], n, 1); } });
        return;
      }
      case "new-folder": {
        // Strata makes the folder at once, clears the filter, and puts the new row in rename. Its ceiling: a name taken by a row the filter hid is the server's to refuse.
        const name = freeName("new folder", e.rowsIn(into).map((r) => r.name));
        e.clearFilter(into);
        void run({ op: "mkdir", parent: into, name }, [into], name, 1).then((ok) => { if (ok) setJustMade({ dir: into, name, at: Date.now() }); });
        return;
      }
      case "new-file": {
        const isDir = false;
        startName({ dir: into, was: null, isDir, initial: isDir ? "New Folder" : "New File", taken: e.rowsIn(into).map((r) => r.name), run: (n) => { void run({ op: isDir ? "mkdir" : "newfile", parent: into, name: n }, [into], n, 1); } });
        return;
      }
      case "folder-with": {
        // With nothing chosen it is a plain new folder (Strata's Ctrl+Alt+N).
        if (!c || !c.rows.length) { doItem("new-folder", null, into); return; }
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

  /* The folder the key just made goes into rename as soon as its row is listed; a listing that never shows it is given up on after 5 s. */
  useEffect(() => {
    if (!justMade) return;
    const e = envRef.current;
    const row = e.rowsIn(justMade.dir).find((r) => r.name === justMade.name);
    if (row) { setJustMade(null); e.choose(justMade.dir, row.name); doItem("rename", { dir: justMade.dir, rows: [row] }, justMade.dir); return; }
    const t = setTimeout(() => setJustMade(null), Math.max(0, 5000 - (Date.now() - justMade.at)));
    return () => clearTimeout(t);
  });

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
  const dropAllows = useCallback((dest: string, ctrl: boolean, more?: { shift?: boolean; mounts?: readonly string[] }): "move" | "copy" | null => {
    const d = drag.current;
    if (!d) return null;
    const p = dropPlan(d.dir, d.names, dest, ctrl, more);
    return typeof p === "string" ? null : p.op;
  }, []);
  const dropOn = useCallback((dest: string, ctrl: boolean, trash = false, more?: { shift?: boolean; mounts?: readonly string[] }) => {
    const d = drag.current; drag.current = null;
    if (!d) return;
    const ps = d.names.map((n) => joinPath(d.dir, n));
    const one = d.names.length === 1 ? d.names[0]! : "";
    if (trash) { void run({ op: "trash", paths: ps }, [d.dir], one, d.names.length); return; }
    const p = dropPlan(d.dir, d.names, dest, ctrl, more);
    if (p === "inside") { envRef.current.say("A folder cannot go into itself"); return; }
    if (p === "nothing") return;
    const go = (op: "copy" | "move") => void run({ op, paths: ps, dest, conflict: p.conflict }, [d.dir, dest], one, d.names.length);
    if (dropAsks(d.dir, dest, ctrl, more)) { setAsk({ k: "transfer", n: d.names.length, go }); return; }
    go(p.op);
  }, [run]);

  /** A Strata key, on whatever is chosen. */
  const key = useCallback((t: string): boolean => {
    const e = envRef.current;
    const c = e.chosen();
    const into = c ? c.dir : e.here();
    const map: Record<string, Item["id"] | undefined> = { cut: "cut", copyfiles: "copy", paste: "paste", duplicate: "duplicate", rename: "rename", trash: "trash", delete: "delete", newfolder: "new-folder", folderwith: "folder-with", props: "props", pin: "pin", opentab: "open-in" };
    if (t === "paste") { const dir = e.pasteDir() ?? e.here(); doItem("paste", c, dir); return true; }
    if (t === "redo") { void run({ op: "redo" }, [e.here()], "", 1).then(() => { for (const d of [into, e.here()]) e.reload(d); }); return true; }
    if (t === "undo") { void run({ op: "undo" }, [e.here()], "", 1).then(() => { for (const d of [into, e.here()]) e.reload(d); }); return true; }
    const id = map[t];
    if (!id) return false;
    // Delete in the Trash is permanent, so it asks; anywhere else it goes to the Trash at once.
    if (id === "trash" && c && inTrash(c.dir)) { doItem("delete", c, into); return true; }
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
    const target: Target = !name ? "empty" : rows.length === 1 && isFolder(rows[0]!) ? "folder" : "file";
    const ps = rows.length ? rows.map((r) => joinPath(dir, r.name)) : [dir];
    // The person's own actions are a read, asked before the menu opens so it never grows under the pointer; a slow answer is given up on after 400 ms.
    void Promise.race([api.actionsMatch(ps, rows.length ? "selection" : "background"), new Promise<null>((res) => setTimeout(() => res(null), 400))])
      .then((r) => setMenu({ at: { x, y }, target, dir, rows, actions: r?.actions ?? [] }));
  }, []);

  const nodes = (
    <>
      {menu && (() => {
        const e = env;
        const groups = withActions(menuFor(menu.target, { count: menu.rows.length, canPaste: !!clip, hidden: e.hidden, pinned: menu.rows.length === 1 && e.pins.includes(joinPath(menu.dir, menu.rows[0]!.name)), previewable: menu.rows.length === 1 && !isFolder(menu.rows[0]!) }), actionGroup(menu.actions));
        const head = menu.rows.length ? menuHead(menu.rows.map((r) => r.name), menu.dir, e.home) : null;
        return (
          <ContextMenu at={menu.at} head={head} groups={groups} onClose={() => setMenu(null)}
            onPick={(i) => {
              setMenu(null);
              if (i.later) { e.say(`${i.later} is not built yet`); return; }
              if (i.id === "action") {
                const a = menu.actions.find((x) => x.id === i.action);
                if (a) startAction(a, menu.rows.length ? menu.rows.map((r) => joinPath(menu.dir, r.name)) : [menu.dir], menu.rows.length ? "selection" : "background");
                return;
              }
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
        onOpen={() => { setAsk(null); doItem("open", { dir: a.dir, rows: envRef.current.rowsIn(a.dir).filter((r) => r.name === a.name) }, a.dir); }}
        onRename={() => { setAsk(null); doItem("rename", { dir: a.dir, rows: envRef.current.rowsIn(a.dir).filter((r) => r.name === a.name) }, a.dir); }}
        onCopyPath={() => envRef.current.copyText(a.path, `Copied ${a.path}`)} />; })()}
      {ask?.k === "pick" && (() => { const c = ask.c; return <FolderPicker op={ask.op} paths={paths(c)} start={c.dir} home={env.home} onClose={() => setAsk(null)}
        onPick={(dest) => { const op = ask.op; setAsk(null); void run({ op, paths: paths(c), dest, conflict: "keep-both" }, [c.dir, dest], c.rows[0]!.name, c.rows.length); }} />; })()}
      {ask?.k === "openwith" && (() => { const ps = ask.paths; return <OpenWithDialog paths={ps} onClose={() => setAsk(null)}
        onLaunch={(id, always) => { setAsk(null); void api.openWithLaunch(id, ps, always ?? undefined).then((r) => envRef.current.say(r.ok ? (r.note ?? "Opened") : (r.error ?? "That did not open"))); }} />; })()}
      {ask?.k === "action" && (() => { const a = ask; const w = confirmWords(a.action, a.paths.length); return <ConfirmDialog title={w.title} body={w.body} confirm="Run" onClose={() => setAsk(null)} onConfirm={() => { setAsk(null); startAction(a.action, a.paths, a.source, true); }} />; })()}
      {ask?.k === "stage" && (() => { const a = ask; return <StageDialog a={a.a} by={a.by} n={a.n} onClose={() => setAsk(null)}
        onConfirm={() => { const r = stageRun(a.a); setAsk(null); void run(r.body, r.dirs, r.name, 1); }} />; })()}
      {ask?.k === "customize" && <CustomizeDialog paths={ask.paths} names={ask.names} isDir={ask.isDir} onClose={() => setAsk(null)} />}
      {ask?.k === "trash" && <TrashPanel home={env.home} onClose={() => setAsk(null)} onRestored={(dirs, said) => { for (const d of dirs) envRef.current.reload(d); envRef.current.say(said); }} />}
      {ask?.k === "transfer" && (() => { const a = ask; return <TransferDialog n={a.n} onClose={() => setAsk(null)} onPick={(op) => { setAsk(null); a.go(op); }} />; })()}
      {ask?.k === "delete" && (() => { const w = deleteWords(ask.names); return <ConfirmDialog title={w.title} body={w.body} confirm="Permanently delete" onClose={() => setAsk(null)} onConfirm={() => { const f = ask.run; setAsk(null); f(); }} />; })()}
    </>
  );

  /** A sidebar row's Properties and Customize…: the folder, named by its path. */
  const openProps = (path: string) => { const at = path.lastIndexOf("/"); setAsk({ k: "props", path, dir: at > 0 ? path.slice(0, at) : "/", name: path.slice(at + 1) }); };
  const openCustomize = (path: string) => setAsk({ k: "customize", paths: [path], names: [path.slice(path.lastIndexOf("/") + 1) || path], isDir: true });

  return { clip, openProps, openCustomize, openTrash: () => setAsk({ k: "trash" }), contextAt, key, nodes, edit, dragStart, dragEnd, dropAllows, dropOn, hasMenu: !!menu || !!ask || !!edit };
}
