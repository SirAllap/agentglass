/*
 * Changing a place: the Machine finder's file operations.
 *
 * Every operation lands here and nowhere else, behind the SAME boundary as
 * /browse/list (browseReal): an operand is judged on the folder that holds it
 * (symlinks resolved) plus its own name, so a link inside home that leads out
 * of it can be renamed, trashed or deleted AS A LINK but is never followed:
 * copy re-creates links as links, delete unlinks them, nothing opens one.
 *
 * Rules every operation shares:
 *   - nothing is overwritten. A name that is taken fails, or (paste, duplicate)
 *     becomes "name (copy).ext";
 *   - a copy is built under a hidden temporary name in the destination folder
 *     and only then given its real name, so a half-copied tree never shows up
 *     under the name of the real one and a cancelled copy leaves nothing;
 *   - the trash is the freedesktop one (<data>/Trash/{files,info} with a
 *     .trashinfo per entry), so restore works here and in any other file
 *     manager;
 *   - the last few moves are remembered, in memory, so they can be undone.
 *
 * Simplifications that name their ceiling: the trash is the home trash only (a
 * file on another device is copied into it, not trashed in a per-mount
 * .Trash-<uid>); undo is one level each time, with no redo; a password given
 * to the archiver travels in its argument list, visible to the same user's ps.
 */
import {
  chmodSync, closeSync, constants as FS, copyFileSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync,
  readlinkSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync, type Stats,
} from "node:fs";
import { copyFile, lstat, mkdir, open, readdir, readlink, rename, rm, symlink, utimes, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, isAbsolute } from "node:path";
import { browseReal } from "./browse.ts";
import { diskRoots } from "./disk.ts";
import { safeAbs } from "./git.ts";
import { workspaceRoots } from "./config.ts";

export interface Fail { ok: false; error: string }
type Ok<T> = { ok: true } & T;
const fail = (error: string): Fail => ({ ok: false, error });
const OUTSIDE = "outside the places this may look";

/* ---- names and operands ------------------------------------------------ */

export function validName(n: unknown): n is string {
  return typeof n === "string" && n.length > 0 && Buffer.byteLength(n) <= 255
    && !n.includes("/") && !n.includes("\0") && n !== "." && n !== "..";
}

const home = (): string => process.env.HOME || homedir();
const realOf = (p: string): string => { try { return realpathSync(p); } catch { return p; } };

/** An entry that is, or holds, a place the boundary starts from: never moved, never deleted. */
function isRootOrAbove(path: string): boolean {
  const roots = [...diskRoots(), ...workspaceRoots(), home()].map(realOf);
  return roots.some((r) => { const rel = relative(path, r); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); });
}

interface Operand { path: string; dir: string; name: string; st: Stats }

/** The entry itself, as a link if it is one. Null reason when it may not be touched. */
function operand(p: unknown, local: boolean): Ok<Operand> | Fail {
  const abs = safeAbs(p);
  if (!abs) return fail("not a path");
  const name = basename(abs);
  if (!validName(name)) return fail("not a path");
  const dir = browseReal(dirname(abs), local);
  if (dir === null) return fail(OUTSIDE);
  const path = join(dir, name);
  let st: Stats;
  try { st = lstatSync(path); } catch { return fail(`${name} does not exist`); }
  // A link is acted on as a link, so only its folder has to be allowed; anything
  // else is judged whole, which is what keeps a dotted secret store out.
  if (!st.isSymbolicLink() && browseReal(path, local) === null) return fail(OUTSIDE);
  if (isRootOrAbove(path)) return fail(`${name} holds a root folder of this finder and is left alone`);
  return { ok: true, path, dir, name, st };
}

function folder(p: unknown, local: boolean): Ok<{ path: string }> | Fail {
  const real = browseReal(p, local);
  if (real === null) return fail(OUTSIDE);
  try { if (!statSync(real).isDirectory()) return fail("not a folder"); } catch { return fail("folder does not exist"); }
  return { ok: true, path: real };
}

const exists = (p: string): boolean => { try { lstatSync(p); return true; } catch { return false; } };

/** "a.txt" -> "a (copy).txt" -> "a (copy 2).txt": a free name in `dir`. */
export function keepBoth(dir: string, name: string, also: ReadonlySet<string> = new Set()): string {
  const free = (n: string) => !exists(join(dir, n)) && !also.has(n);
  if (free(name)) return name;
  // ".tar.gz" is one extension; a leading dot (".bashrc") is a name, not one.
  const ext = /^.+?((\.tar)?\.[^./]+)$/.exec(name)?.[1] ?? "";
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let i = 1; i < 10_000; i++) {
    const cand = `${stem} (copy${i > 1 ? ` ${i}` : ""})${ext}`;
    if (free(cand)) return cand;
  }
  return `${stem} (copy ${Date.now()})${ext}`;
}

/* ---- the undo journal -------------------------------------------------- */

type Kind = "move" | "rename" | "trash" | "create" | "copy";
interface Step { from?: string; to: string; trashId?: string }
interface Journal { kind: Kind; label: string; steps: Step[]; at: number }
const journal: Journal[] = [];
const MAX_JOURNAL = 50;
/** Ctrl+Z is for what was just done: after this, an entry is forgotten rather than undone by surprise. */
export const JOURNAL_TTL_MS = 10 * 60_000;
function remember(kind: Kind, label: string, steps: Step[]): void {
  if (!steps.length) return;
  journal.push({ kind, label, steps, at: Date.now() });
  while (journal.length > MAX_JOURNAL) journal.shift();
}
/** The newest entry that is still fresh; older ones are dropped on the way. */
function newest(now: number): Journal | undefined {
  while (journal.length && now - journal[journal.length - 1]!.at > JOURNAL_TTL_MS) journal.pop();
  return journal[journal.length - 1];
}
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
export function undoState(now = Date.now()): { available: boolean; label: string | null } {
  const j = newest(now);
  return { available: !!j, label: j ? j.label : null };
}
export function __resetJournalForTest(): void { journal.length = 0; jobs.clear(); }

/**
 * Move without ever replacing: rename(2) silently replaces a file that appeared
 * after the check, so a file is hard-linked to its new name (which fails with
 * EEXIST) and then unlinked. A folder cannot be linked; its rename can only
 * replace an EMPTY folder, which is the ceiling here.
 */
export function moveNoReplace(from: string, to: string): void {
  const st = lstatSync(from);
  if (st.isDirectory()) {
    if (exists(to)) throw Object.assign(new Error(`${basename(to)} already exists`), { code: "EEXIST" });
    renameSync(from, to);
    return;
  }
  try { linkSync(from, to); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw Object.assign(new Error(`${basename(to)} already exists`), { code });
    if (code === "EXDEV") throw e;
    // A place with no hard links (FAT, some network mounts): the check-then-rename it replaces.
    if (exists(to)) throw Object.assign(new Error(`${basename(to)} already exists`), { code: "EEXIST" });
    renameSync(from, to);
    return;
  }
  unlinkSync(from);
}

/* ---- create, rename ---------------------------------------------------- */

export function fsMkdir(parent: unknown, name: unknown, local: boolean): Ok<{ path: string }> | Fail {
  if (!validName(name)) return fail("that is not a name");
  const d = folder(parent, local);
  if (!d.ok) return d;
  const path = join(d.path, name);
  if (exists(path)) return fail(`${name} already exists`);
  try { mkdirSync(path, { mode: 0o777 }); } catch (e) { return fail(String((e as Error).message)); }
  remember("create", `Undo new folder ${name}`, [{ to: path }]);
  return { ok: true, path };
}

export function fsNewFile(parent: unknown, name: unknown, local: boolean): Ok<{ path: string }> | Fail {
  if (!validName(name)) return fail("that is not a name");
  const d = folder(parent, local);
  if (!d.ok) return d;
  const path = join(d.path, name);
  try { closeSync(openSync(path, "wx", 0o666)); } catch (e) {
    return fail((e as NodeJS.ErrnoException).code === "EEXIST" ? `${name} already exists` : String((e as Error).message));
  }
  remember("create", `Undo new file ${name}`, [{ to: path }]);
  return { ok: true, path };
}

/** A new folder that holds the selection (Ctrl+Alt+N). All operands share a folder. */
export function fsFolderWith(paths: unknown, name: unknown, local: boolean): Ok<{ path: string }> | Fail {
  if (!validName(name)) return fail("that is not a name");
  const ops = operands(paths, local);
  if (!ops.ok) return ops;
  const dir = ops.items[0]!.dir;
  if (ops.items.some((o) => o.dir !== dir)) return fail("the selection is in more than one folder");
  const target = join(dir, name);
  if (exists(target)) return fail(`${name} already exists`);
  const moved: Step[] = [];
  try {
    mkdirSync(target);
    for (const o of ops.items) {
      const to = join(target, o.name);
      moveNoReplace(o.path, to);
      moved.push({ from: o.path, to });
    }
  } catch (e) {
    for (const m of moved.reverse()) { try { renameSync(m.to, m.from!); } catch { /* best effort */ } }
    try { rmdirSync(target); } catch { /* left */ }
    return fail(String((e as Error).message));
  }
  remember("move", `Undo new folder ${name} with ${plural(moved.length, "item")}`, moved);
  return { ok: true, path: target };
}

export function fsRename(path: unknown, name: unknown, local: boolean): Ok<{ path: string }> | Fail {
  if (!validName(name)) return fail("that is not a name");
  const o = operand(path, local);
  if (!o.ok) return o;
  if (name === o.name) return { ok: true, path: o.path };
  const to = join(o.dir, name);
  if (exists(to)) return fail(`${name} already exists`);
  if (browseReal(to, local) === null && !o.st.isSymbolicLink()) return fail(OUTSIDE);
  try { moveNoReplace(o.path, to); } catch (e) { return fail(String((e as Error).message)); }
  remember("rename", `Undo rename of ${o.name}`, [{ from: o.path, to }]);
  return { ok: true, path: to };
}

function operands(paths: unknown, local: boolean): Ok<{ items: Operand[] }> | Fail {
  if (!Array.isArray(paths) || paths.length === 0) return fail("nothing selected");
  if (paths.length > 10_000) return fail("too many items at once");
  const items: Operand[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    const o = operand(p, local);
    if (!o.ok) return o;
    if (seen.has(o.path)) continue;
    seen.add(o.path);
    items.push(o);
  }
  return { ok: true, items };
}

/* ---- the trash --------------------------------------------------------- */

export const trashRoot = (): string => join(process.env.XDG_DATA_HOME || join(home(), ".local", "share"), "Trash");

/** The .trashinfo Path value: percent-encoded bytes, "/" kept. */
const enc = (p: string): string => p.split("/").map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())).join("/");
const stamp = (d: Date): string => {
  const z = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
};

function trashDirs(): { files: string; info: string } {
  const root = trashRoot();
  const files = join(root, "files"), info = join(root, "info");
  mkdirSync(files, { recursive: true, mode: 0o700 });
  mkdirSync(info, { recursive: true, mode: 0o700 });
  return { files, info };
}

export interface TrashRow { id: string; name: string; from: string; deleted: string; kind: "dir" | "file" | "link"; bytes: number | null }

export function trashOne(o: Operand): Ok<{ id: string }> | Fail {
  const { files, info } = trashDirs();
  let id = o.name, n = 1;
  for (;;) {
    try { writeFileSync(join(info, `${id}.trashinfo`), `[Trash Info]\nPath=${enc(o.path)}\nDeletionDate=${stamp(new Date())}\n`, { flag: "wx", mode: 0o600 }); break; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") return fail(String((e as Error).message)); id = `${o.name}.${n++}`; }
  }
  try {
    if (exists(join(files, id))) { unlinkSync(join(info, `${id}.trashinfo`)); return fail("the trash has a stray file with that name"); }
    renameSync(o.path, join(files, id));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EXDEV") {
      // Another device: copy it in, then take the original away. Not atomic, and said so at the top.
      try { copyTreeSync(o.path, join(files, id)); rmSync(o.path, { recursive: true, force: true }); }
      catch (e2) { try { unlinkSync(join(info, `${id}.trashinfo`)); } catch { /* */ } return fail(String((e2 as Error).message)); }
    } else { try { unlinkSync(join(info, `${id}.trashinfo`)); } catch { /* */ } return fail(String((e as Error).message)); }
  }
  return { ok: true, id };
}

function copyTreeSync(src: string, dst: string): void {
  const st = lstatSync(src);
  if (st.isSymbolicLink()) { symlinkSync(readlinkSync(src), dst); return; }
  if (st.isDirectory()) {
    mkdirSync(dst, { mode: st.mode & 0o777 });
    for (const e of readdirSync(src)) copyTreeSync(join(src, e), join(dst, e));
    return;
  }
  if (st.isFile()) { copyFileSync(src, dst, FS.COPYFILE_EXCL); chmodSync(dst, st.mode & 0o777); }
}

export function fsTrash(paths: unknown, local: boolean): Ok<{ trashed: { path: string; id: string }[] }> | Fail {
  const ops = operands(paths, local);
  if (!ops.ok) return ops;
  const done: { path: string; id: string }[] = [];
  for (const o of ops.items) {
    const r = trashOne(o);
    if (!r.ok) {
      if (done.length) remember("trash", `Undo trash of ${plural(done.length, "item")}`, done.map((d) => ({ from: d.path, to: d.path, trashId: d.id })));
      return fail(`${o.name}: ${r.error}${done.length ? ` (${done.length} already in the trash)` : ""}`);
    }
    done.push({ path: o.path, id: r.id });
  }
  remember("trash", `Undo trash of ${done.length === 1 ? basename(done[0]!.path) : plural(done.length, "item")}`, done.map((d) => ({ from: d.path, to: d.path, trashId: d.id })));
  return { ok: true, trashed: done };
}

const decode = (s: string): string | null => { try { return decodeURIComponent(s); } catch { return null; } };

function readInfo(id: string): { from: string; deleted: string } | null {
  try {
    const t = readFileSync(join(trashRoot(), "info", `${id}.trashinfo`), "utf8");
    const p = /^Path=(.*)$/m.exec(t), d = /^DeletionDate=(.*)$/m.exec(t);
    const from = p ? decode(p[1]!) : null;
    return from ? { from, deleted: d ? d[1]! : "" } : null;
  } catch { return null; }
}

export function trashList(): TrashRow[] {
  const root = trashRoot();
  let names: string[] = [];
  try { names = readdirSync(join(root, "info")); } catch { return []; }
  const rows: TrashRow[] = [];
  for (const f of names) {
    if (!f.endsWith(".trashinfo")) continue;
    const id = f.slice(0, -".trashinfo".length);
    const i = readInfo(id);
    if (!i) continue;
    let st: Stats;
    try { st = lstatSync(join(root, "files", id)); } catch { continue; }
    rows.push({ id, name: basename(i.from), from: i.from, deleted: i.deleted, kind: st.isSymbolicLink() ? "link" : st.isDirectory() ? "dir" : "file", bytes: st.isFile() ? st.size : null });
  }
  return rows.sort((a, b) => b.deleted.localeCompare(a.deleted) || a.name.localeCompare(b.name));
}

/** Put trashed entries back. A taken place is refused, never overwritten. */
export function fsRestore(ids: unknown, local: boolean): Ok<{ restored: string[] }> | Fail {
  if (!Array.isArray(ids) || !ids.length) return fail("nothing selected");
  const restored: string[] = [];
  const steps: Step[] = [];
  // Every entry is judged before any is put back: one that cannot go leaves the trash exactly as it was.
  const plan: { id: string; src: string; to: string; dir: string }[] = [];
  for (const id of ids) {
    if (!validName(id)) return fail("not a trash entry");
    const i = readInfo(id);
    const src = join(trashRoot(), "files", id);
    if (!i || !exists(src)) return fail(`${id} is not in the trash`);
    if (!i.from.startsWith("/")) return fail(`${basename(i.from)}: the trash does not say where it came from`);
    const abs = safeAbs(i.from);
    // The folder it came from may be gone: the nearest one that is still there must be inside the boundary.
    let up = abs ? dirname(abs) : "";
    while (abs && up !== "/" && !exists(up)) up = dirname(up);
    const inside = abs && browseReal(up, local);
    if (!abs || !inside) return fail(`${basename(i.from)}: the place it came from is outside what this may touch`);
    const to = join(inside, relative(up, abs));
    if (exists(to)) return fail(`${basename(abs)}: something with that name is already there`);
    if (plan.some((p) => p.to === to)) return fail(`${basename(abs)}: two entries want the same place`);
    plan.push({ id, src, to, dir: dirname(to) });
  }
  for (const { id, src, to, dir } of plan) {
    if (!exists(dir)) { try { mkdirSync(dir, { recursive: true }); } catch { return fail(`${basename(to)}: the folder it came from could not be made again`); } }
    try { moveNoReplace(src, to); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EXDEV") { try { copyTreeSync(src, to); rmSync(src, { recursive: true, force: true }); } catch { return fail(`${basename(to)}: it could not be put back`); } }
      else return fail(`${basename(to)}: ${(e as NodeJS.ErrnoException).code === "EEXIST" ? "something with that name is already there" : "it could not be put back"}`);
    }
    try { unlinkSync(join(trashRoot(), "info", `${id}.trashinfo`)); } catch { /* the entry is back; a stale info is harmless */ }
    restored.push(to);
    steps.push({ to, trashId: id });
  }
  return { ok: true, restored };
}

/** Empty the trash (or delete chosen entries) for good. */
export function fsEmptyTrash(ids: unknown, confirm: unknown): Ok<{ removed: number }> | Fail {
  const rows = trashList();
  const chosen = Array.isArray(ids) ? rows.filter((r) => ids.includes(r.id)) : rows;
  if (confirm !== chosen.length) return fail(`confirm with the count: ${chosen.length}`);
  for (const r of chosen) {
    rmSync(join(trashRoot(), "files", r.id), { recursive: true, force: true });
    rmSync(join(trashRoot(), "info", `${r.id}.trashinfo`), { force: true });
  }
  return { ok: true, removed: chosen.length };
}

/* ---- permanent delete -------------------------------------------------- */

/** Gone for good. `confirm` must equal the number of paths: the count the person was shown. */
export function fsDelete(paths: unknown, confirm: unknown, local: boolean): Ok<{ deleted: number }> | Fail {
  const ops = operands(paths, local);
  if (!ops.ok) return ops;
  if (confirm !== ops.items.length) return fail(`confirm with the count: ${ops.items.length}`);
  let n = 0;
  for (const o of ops.items) {
    try {
      // rmSync unlinks a link and never walks through one; a directory is walked by what it holds, not by where links point.
      rmSync(o.path, { recursive: true, force: false });
      n++;
    } catch (e) { return fail(`${o.name}: ${(e as Error).message}${n ? ` (${n} already deleted)` : ""}`); }
  }
  // Nothing to undo: that is what "permanently" means. The journal forgets paths it no longer can restore.
  return { ok: true, deleted: n };
}

/* ---- jobs: copy, move, duplicate, compress ----------------------------- */

export interface JobView { id: string; kind: string; label: string; state: "running" | "done" | "error" | "cancelled"; total: number | null; done: number; items: number; error?: string; started: number; ended?: number }
interface Job extends JobView { stop: boolean; proc?: { kill: () => void } }
const jobs = new Map<string, Job>();
let jobSeq = 0;

export function listJobs(): JobView[] {
  return [...jobs.values()].map(({ stop: _s, proc: _p, ...v }) => v).sort((a, b) => b.started - a.started);
}
export function cancelJob(id: unknown): boolean {
  const j = typeof id === "string" ? jobs.get(id) : undefined;
  if (!j || j.state !== "running") return false;
  j.stop = true;
  try { j.proc?.kill(); } catch { /* gone */ }
  return true;
}
export function clearFinishedJobs(): void { for (const [id, j] of jobs) if (j.state !== "running") jobs.delete(id); }

function newJob(kind: string, label: string, total: number | null): Job {
  const j: Job = { id: `j${++jobSeq}`, kind, label, state: "running", total, done: 0, items: 0, started: Date.now(), stop: false };
  jobs.set(j.id, j);
  // Finished rows pile up in a long session: keep the last twenty.
  const finished = [...jobs.values()].filter((x) => x.state !== "running");
  while (finished.length > 20) jobs.delete(finished.shift()!.id);
  return j;
}

class Cancelled extends Error {}

async function sizeOf(path: string): Promise<{ bytes: number; items: number }> {
  let bytes = 0, items = 0;
  const walk = async (p: string) => {
    const st = await lstat(p);
    items++;
    if (st.isDirectory()) for (const e of await readdir(p)) await walk(join(p, e));
    else if (st.isFile()) bytes += st.size;
  };
  await walk(path);
  return { bytes, items };
}

const CHUNK = 1024 * 1024;
const BIG = 16 * CHUNK;

async function copyTree(src: string, dst: string, job: Job): Promise<void> {
  if (job.stop) throw new Cancelled();
  const st = await lstat(src);
  if (st.isSymbolicLink()) { await symlink(await readlink(src), dst); job.items++; return; }
  if (st.isDirectory()) {
    await mkdir(dst, { mode: st.mode & 0o777 | 0o700 });
    for (const e of await readdir(src)) await copyTree(join(src, e), join(dst, e), job);
    await chmod(dst, st.mode & 0o777).catch(() => {});
    await utimes(dst, st.atime, st.mtime).catch(() => {});
    job.items++;
    return;
  }
  if (!st.isFile()) return; // sockets, fifos and devices are not copied
  if (st.size < BIG) {
    await copyFile(src, dst, FS.COPYFILE_EXCL | FS.COPYFILE_FICLONE);
    job.done += st.size;
  } else {
    // A big file in 1 MiB steps, so the bar moves and cancel lands between steps.
    const a = await open(src, "r"), b = await open(dst, "wx", st.mode & 0o777);
    try {
      const buf = Buffer.allocUnsafe(CHUNK);
      for (;;) {
        if (job.stop) throw new Cancelled();
        const { bytesRead } = await a.read(buf, 0, CHUNK, null);
        if (!bytesRead) break;
        await b.write(buf, 0, bytesRead);
        job.done += bytesRead;
      }
    } finally { await a.close(); await b.close(); }
  }
  await chmod(dst, st.mode & 0o777).catch(() => {});
  await utimes(dst, st.atime, st.mtime).catch(() => {});
  job.items++;
}

/** Give `tmp` its real name without ever replacing something already called that. */
async function publish(tmp: string, finalPath: string, isDir: boolean): Promise<void> {
  if (exists(finalPath)) throw new Error(`${basename(finalPath)} already exists`);
  if (isDir) await rename(tmp, finalPath);
  else {
    try { linkSync(tmp, finalPath); } catch (e) {
      // A place with no hard links (FAT, some network mounts): copy under the same refuse-to-replace rule.
      if ((e as NodeJS.ErrnoException).code === "EEXIST") throw e;
      copyFileSync(tmp, finalPath, FS.COPYFILE_EXCL);
    }
    unlinkSync(tmp);
  }
}

export type Conflict = "fail" | "keep-both";
export interface CopyOpts { move?: boolean; conflict?: Conflict; duplicate?: boolean }

/**
 * Copy, move or duplicate. Resolves with the job (finished, or still running if
 * it takes longer than `wait` ms) so a small copy answers inline and a big one
 * answers with something the jobs panel can follow.
 */
export async function fsCopy(paths: unknown, dest: unknown, opts: CopyOpts, local: boolean, wait = 200): Promise<Ok<{ job: JobView; created: string[] }> | Fail> {
  const ops = operands(paths, local);
  if (!ops.ok) return ops;
  const d = opts.duplicate ? { ok: true as const, path: ops.items[0]!.dir } : folder(dest, local);
  if (!d.ok) return d;
  const plan: { o: Operand; name: string; to: string }[] = [];
  // Names the plan itself is about to create: two operands from different folders can share a basename.
  const planned = new Set<string>();
  for (const o of ops.items) {
    // Into itself: a folder cannot hold a copy of itself, and a move there would lose it.
    const rel = relative(o.path, d.path);
    if (o.st.isDirectory() && !o.st.isSymbolicLink() && (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)))) {
      return fail(`${o.name} cannot go into itself`);
    }
    const sameFolder = o.dir === d.path;
    if (opts.move && sameFolder) return fail(`${o.name} is already in that folder`);
    let name = o.name;
    if (exists(join(d.path, name)) || planned.has(name)) {
      if (opts.conflict === "keep-both" || opts.duplicate) name = keepBoth(d.path, name, planned);
      else return fail(`${name} already exists in that folder`);
    }
    planned.add(name);
    plan.push({ o, name, to: join(d.path, name) });
  }
  const verb = opts.duplicate ? "Duplicating" : opts.move ? "Moving" : "Copying";
  const label = `${verb} ${plan.length === 1 ? plan[0]!.o.name : plural(plan.length, "item")}`;
  const job = newJob(opts.move ? "move" : opts.duplicate ? "duplicate" : "copy", label, null);
  const created: string[] = [];
  // Journalled as each step lands, and again in `finally`, so a job that stops halfway can still be undone for what it did.
  const steps: Step[] = [];
  const run = (async () => {
    try {
      // Same device and a move: one rename each, atomic and instant.
      const rest: typeof plan = [];
      for (const p of plan) {
        if (opts.move) {
          try { moveNoReplace(p.o.path, p.to); created.push(p.to); steps.push({ from: p.o.path, to: p.to }); job.items++; continue; }
          catch (e) { if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e; }
        }
        rest.push(p);
      }
      if (rest.length) {
        let total = 0;
        for (const p of rest) total += (await sizeOf(p.o.path)).bytes;
        job.total = total;
        for (const p of rest) {
          const tmp = join(d.path, `.agx-part-${job.id}-${basename(p.name)}`.slice(0, 250));
          try {
            await copyTree(p.o.path, tmp, job);
            await publish(tmp, p.to, p.o.st.isDirectory() && !p.o.st.isSymbolicLink());
          } catch (e) { rmSync(tmp, { recursive: true, force: true }); throw e; }
          created.push(p.to);
          if (opts.move) { rmSync(p.o.path, { recursive: true, force: true }); steps.push({ from: p.o.path, to: p.to }); }
          else steps.push({ to: p.to });
        }
      }
      job.state = "done";
    } catch (e) {
      job.state = e instanceof Cancelled ? "cancelled" : "error";
      if (!(e instanceof Cancelled)) job.error = String((e as Error).message) + (steps.length ? ` (${steps.length} of ${plan.length} were done)` : "");
    } finally {
      remember(opts.move ? "move" : "copy",
        `Undo ${opts.move ? "move" : opts.duplicate ? "duplicate" : "copy"} of ${steps.length === 1 ? basename(steps[0]!.to) : plural(steps.length, "item")}`, steps);
      job.ended = Date.now(); job.total ??= job.done;
    }
  })();
  await Promise.race([run, new Promise((r) => setTimeout(r, wait))]);
  const { stop: _s, proc: _p, ...view } = job;
  if (job.state === "error") return fail(job.error ?? "failed");
  return { ok: true, job: view, created };
}

/** Wait for a job, for tests and for callers that must have the result. */
export async function settle(id: string, ms = 10_000): Promise<JobView | null> {
  const t0 = Date.now();
  for (;;) {
    const j = jobs.get(id);
    if (!j) return null;
    if (j.state !== "running" || Date.now() - t0 > ms) return listJobs().find((x) => x.id === id) ?? null;
    await new Promise((r) => setTimeout(r, 5));
  }
}

/* ---- compress ---------------------------------------------------------- */

export type Format = "zip" | "7z" | "tar.gz" | "tar";
const EXT: Record<Format, string> = { zip: ".zip", "7z": ".7z", "tar.gz": ".tar.gz", tar: ".tar" };

/** The command for one archive. Names come after `--` in every tool: a file called -sdel is a name, never a switch. */
export function compressArgv(fmt: Format, tmp: string, names: readonly string[], pw: string | null): string[] {
  return fmt === "zip" ? ["zip", "-r", "-y", "-q", ...(pw ? ["-P", pw] : []), tmp, "--", ...names]
    : fmt === "7z" ? ["7z", "a", "-snl", "-bso0", "-bsp0", ...(pw ? [`-p${pw}`] : []), tmp, "--", ...names]
    : ["tar", fmt === "tar.gz" ? "-czf" : "-cf", tmp, "--", ...names];
}

export async function fsCompress(paths: unknown, archive: unknown, format: unknown, secret: unknown, local: boolean, wait = 400): Promise<Ok<{ job: JobView; path: string }> | Fail> {
  const ops = operands(paths, local);
  if (!ops.ok) return ops;
  const dir = ops.items[0]!.dir;
  if (ops.items.some((o) => o.dir !== dir)) return fail("the selection is in more than one folder");
  const fmt = (typeof format === "string" ? format : "zip") as Format;
  if (!(fmt in EXT)) return fail("unknown format");
  if (!validName(archive)) return fail("that is not a name");
  const pw = typeof secret === "string" && secret ? secret : null;
  if (pw && (fmt === "tar" || fmt === "tar.gz")) return fail("this format has no password protection");
  if (pw && pw.startsWith("-")) return fail("a password cannot start with a dash");
  const tool = fmt === "7z" ? "7z" : fmt === "zip" ? "zip" : "tar";
  if (!Bun.which(tool)) return fail(`${tool} is not installed`);
  const base = archive.endsWith(EXT[fmt]) ? archive : archive + EXT[fmt];
  const name = keepBoth(dir, base);
  const tmp = join(dir, `.agx-part-${basename(name)}`);
  const names = ops.items.map((o) => o.name);
  const argv = compressArgv(fmt, tmp, names, pw);
  // zip and 7z name their output by extension; the part-name keeps it.
  const job = newJob("compress", `Compressing ${names.length === 1 ? names[0] : plural(names.length, "item")}`, null);
  const run = (async () => {
    try {
      const proc = Bun.spawn(argv, { cwd: dir, stdout: "ignore", stderr: "pipe" });
      job.proc = proc;
      const code = await proc.exited;
      if (job.stop) throw new Cancelled();
      if (code !== 0) throw new Error((await new Response(proc.stderr).text()).trim().split("\n").pop() || `${tool} failed`);
      await publish(tmp, join(dir, name), false);
      remember("create", `Undo compress to ${name}`, [{ to: join(dir, name) }]);
      job.state = "done";
    } catch (e) {
      rmSync(tmp, { force: true });
      job.state = e instanceof Cancelled ? "cancelled" : "error";
      if (!(e instanceof Cancelled)) job.error = String((e as Error).message);
    } finally { job.ended = Date.now(); }
  })();
  await Promise.race([run, new Promise((r) => setTimeout(r, wait))]);
  const { stop: _s, proc: _p, ...view } = job;
  if (job.state === "error") return fail(job.error ?? "failed");
  return { ok: true, job: view, path: join(dir, name) };
}

/* ---- properties, permissions -------------------------------------------- */

const nameOf = (file: string, id: number): string | null => {
  try {
    for (const l of readFileSync(file, "utf8").split("\n")) { const f = l.split(":"); if (Number(f[2]) === id) return f[0] ?? null; }
  } catch { /* no such database */ }
  return null;
};

export function fsProps(path: unknown, local: boolean): Ok<{ props: { path: string; name: string; kind: "dir" | "file" | "link"; bytes: number | null; mtime: number; mode: number; owner: string; group: string; link: string | null; hidden: boolean; mine: boolean } }> | Fail {
  const o = operand(path, local);
  if (!o.ok) return o;
  let link: string | null = null;
  if (o.st.isSymbolicLink()) { try { link = readlinkSync(o.path); } catch { /* */ } }
  return {
    ok: true,
    props: {
      path: o.path, name: o.name, kind: o.st.isSymbolicLink() ? "link" : o.st.isDirectory() ? "dir" : "file",
      bytes: o.st.isFile() ? o.st.size : null, mtime: o.st.mtimeMs, mode: o.st.mode & 0o777,
      owner: nameOf("/etc/passwd", o.st.uid) ?? String(o.st.uid), group: nameOf("/etc/group", o.st.gid) ?? String(o.st.gid),
      link, hidden: o.name.startsWith("."), mine: o.st.uid === process.getuid?.(),
    },
  };
}

/** Change the nine permission bits. chmod follows links, so a link is refused. */
export function fsChmod(path: unknown, mode: unknown, local: boolean): Ok<{ mode: number }> | Fail {
  const o = operand(path, local);
  if (!o.ok) return o;
  if (o.st.isSymbolicLink()) return fail("a link has no permissions of its own");
  if (typeof mode !== "number" || !Number.isInteger(mode) || mode < 0 || mode > 0o777) return fail("mode must be 0..0777");
  try { chmodSync(o.path, mode); } catch (e) { return fail(String((e as Error).message)); }
  return { ok: true, mode };
}

/* ---- undo -------------------------------------------------------------- */

export function fsUndo(local: boolean, now = Date.now()): Ok<{ label: string; count: number }> | Fail {
  const j = newest(now);
  if (!j) return fail("nothing to undo");
  const label = j.label;
  if (j.kind === "move" || j.kind === "rename") {
    // Check every step before changing any: a half-undone move is worse than none.
    for (const s of j.steps) {
      if (!exists(s.to)) return fail(`${basename(s.to)} is no longer where it was put`);
      if (exists(s.from!)) return fail(`${basename(s.from!)}: its old place is taken`);
      if (browseReal(dirname(s.from!), local) === null) return fail(OUTSIDE);
    }
    for (const s of j.steps.slice().reverse()) {
      try { moveNoReplace(s.to, s.from!); } catch (e) { return fail(String((e as Error).message)); }
    }
  } else if (j.kind === "trash") {
    const r = fsRestore(j.steps.map((s) => s.trashId), local);
    if (!r.ok) return r;
  } else {
    // Created things (folder, file, copy, archive) go to the trash, which is reversible.
    const r = fsTrash(j.steps.map((s) => s.to), local);
    if (!r.ok) return r;
    journal.pop(); // fsTrash pushed its own entry; undoing an undo is not offered
  }
  journal.splice(journal.indexOf(j), 1);
  return { ok: true, label, count: j.steps.length };
}
