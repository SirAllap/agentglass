// An index of the names under the home directory, kept up to date by
// filesystem events, and searched by fuzzy match.
//
// What it answers: "where is the file called roughly this", in milliseconds, for
// a home with a million entries, without `fd` walking the disk on every
// keystroke and without anything polling. Measured on a real home (120,988
// folders, 1,027,596 entries): see the numbers in the commit that added it.
//
// Shape. Every entry is a row in a few typed arrays (parent, first child, next
// sibling, watch number, flags, name offset and length) and its name is bytes in
// one buffer, so a million entries is tens of megabytes and not a million JS
// strings. A path is never stored: it is the names up the parent chain.
// Deleting an entry marks the row dead; the arrays are rebuilt when a quarter of
// them are.
//
// Scope. The same boundary as `diskFind` (see disk.ts): home and
// `AGENTGLASS_DISK_ROOTS`, nothing hidden, nothing in the private config, no
// symlink followed, and no other mount found inside a root (a mount is another
// disk, with its own cost, and not "home").
//
// Work is cooperative: the build and a search both give the loop back every few
// milliseconds, so the server never stalls behind them.
import { readFileSync } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { agentglassPrivate } from "./config.ts";
import { diskRoots } from "./disk.ts";
import { fuzzyScore, needleBytes } from "./fuzzy.ts";
import { IN_CREATE, IN_DELETE, IN_DELETE_SELF, IN_IGNORED, IN_ISDIR, IN_MOVED_FROM, IN_MOVED_TO, IN_MOVE_SELF, IN_Q_OVERFLOW, openWatcher, type WatchEvent, type Watcher } from "./inotify.ts";

const SKIP = new Set(["node_modules", "__pycache__", "Trash"]);
/** Work this long, then let the loop breathe for as long again: at most about half of one core while it builds. */
const SLICE_MS = 6;
const BREATH_MS = 4;
/** Without events (no inotify, or the kernel's limit on watches) an index this old is rebuilt the next time somebody asks. */
const STALE_MS = 30 * 60_000;

const DIR = 1, DEAD = 2;

/** The mount points that sit inside `root`, from the kernel's own table. */
export function mountsUnder(root: string, table: string): Set<string> {
  const out = new Set<string>();
  for (const line of table.split("\n")) {
    const f = line.split(" ");
    if (f.length < 5) continue;
    const at = f[4]!.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));
    if (at !== root && at.startsWith(root.endsWith("/") ? root : root + "/")) out.add(at);
  }
  return out;
}

export interface IndexStatus {
  state: "idle" | "building" | "ready";
  entries: number;
  dirs: number;
  watched: number;
  /** The kernel would not take more watches, or there is no inotify here: the index rebuilds when old instead of following events. */
  degraded: boolean;
  builtAt: number;
  buildMs: number;
  bytes: number;
}
export interface Hit { path: string; dir: boolean; score: number }
export interface SearchResult { ok: true; hits: Hit[]; scanned: number; ms: number; building: boolean; truncated: boolean }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The rows. */
class Rows {
  n = 0;
  live = 0;
  dirs = 0;
  nameEnd = 0;
  cap = 1 << 16;
  parent = new Int32Array(this.cap);
  first = new Int32Array(this.cap);
  next = new Int32Array(this.cap);
  wd = new Int32Array(this.cap);
  flags = new Uint8Array(this.cap);
  off = new Uint32Array(this.cap);
  len = new Uint16Array(this.cap);
  names = Buffer.allocUnsafe(1 << 20);
  /** watch number -> row, for the events. */
  byWatch = new Map<number, number>();
  dead = 0;

  private grow() {
    const cap = this.cap * 2;
    const g = <T extends Int32Array | Uint8Array | Uint32Array | Uint16Array>(a: T): T => { const b = new (a.constructor as new (n: number) => T)(cap); b.set(a); return b; };
    this.parent = g(this.parent); this.first = g(this.first); this.next = g(this.next); this.wd = g(this.wd);
    this.flags = g(this.flags); this.off = g(this.off); this.len = g(this.len);
    this.cap = cap;
  }

  add(parent: number, name: string, isDir: boolean): number {
    if (this.n === this.cap) this.grow();
    const bytes = Buffer.byteLength(name);
    if (this.nameEnd + bytes > this.names.length) {
      const bigger = Buffer.allocUnsafe(Math.max(this.names.length * 2, this.nameEnd + bytes));
      this.names.copy(bigger, 0, 0, this.nameEnd); this.names = bigger;
    }
    const i = this.n++;
    this.names.write(name, this.nameEnd);
    this.off[i] = this.nameEnd; this.len[i] = bytes; this.nameEnd += bytes;
    this.parent[i] = parent; this.first[i] = -1; this.wd[i] = -1;
    this.flags[i] = isDir ? DIR : 0;
    if (parent >= 0) { this.next[i] = this.first[parent]!; this.first[parent] = i; } else this.next[i] = -1;
    this.live++; if (isDir) this.dirs++;
    return i;
  }

  name(i: number): string { return this.names.toString("utf8", this.off[i]!, this.off[i]! + this.len[i]!); }
  isDir(i: number): boolean { return (this.flags[i]! & DIR) !== 0; }
  isDead(i: number): boolean { return (this.flags[i]! & DEAD) !== 0; }

  path(i: number): string {
    const parts: string[] = [];
    for (let at = i; at >= 0; at = this.parent[at]!) parts.push(this.name(at));
    const root = parts.pop()!;
    return parts.length ? join(root, ...parts.reverse()) : root;
  }

  child(parent: number, name: string): number {
    const want = Buffer.from(name);
    for (let c = this.first[parent]!; c >= 0; c = this.next[c]!) {
      if (this.isDead(c)) continue;
      if (this.len[c] === want.length && this.names.compare(want, 0, want.length, this.off[c]!, this.off[c]! + want.length) === 0) return c;
    }
    return -1;
  }

  /** Mark a row and everything under it dead, and let go of their watches. */
  kill(i: number) {
    const stack = [i];
    while (stack.length) {
      const at = stack.pop()!;
      if (this.isDead(at)) continue;
      this.flags[at] = this.flags[at]! | DEAD;
      this.live--; this.dead++; if (this.isDir(at)) this.dirs--;
      if (this.wd[at]! >= 0) { this.byWatch.delete(this.wd[at]!); this.wd[at] = -1; }
      for (let c = this.first[at]!; c >= 0; c = this.next[c]!) stack.push(c);
    }
    // Unlink from the parent's list, so a name that comes back is not shadowed.
    const p = this.parent[i]!;
    if (p >= 0) {
      if (this.first[p] === i) this.first[p] = this.next[i]!;
      else for (let c = this.first[p]!; c >= 0; c = this.next[c]!) if (this.next[c] === i) { this.next[c] = this.next[i]!; break; }
    }
  }

  get bytes(): number { return this.cap * (4 * 4 + 1 + 4 + 2) + this.names.length; }
}

export class HomeIndex {
  private current: Rows | null = null;
  private building: Rows | null = null;
  private buildP: Promise<void> | null = null;
  private watcher: Watcher | null = null;
  private watcherTried = false;
  private degraded = false;
  private builtAt = 0;
  private buildMs = 0;
  private stale = false;
  private events: Promise<void> = Promise.resolve();
  /** Tests give it a root of their own; production takes the disk roots. */
  constructor(private roots: () => string[] = diskRoots, private mounts: () => string = () => { try { return readFileSync("/proc/self/mountinfo", "utf8"); } catch { return ""; } }) {}

  status(): IndexStatus {
    const r = this.current ?? this.building;
    return {
      state: this.building && !this.current ? "building" : this.current ? "ready" : "idle",
      entries: r?.live ?? 0, dirs: r?.dirs ?? 0, watched: r?.byWatch.size ?? 0,
      degraded: this.degraded || (this.watcherTried && !this.watcher),
      builtAt: this.builtAt, buildMs: this.buildMs, bytes: r?.bytes ?? 0,
    };
  }

  /** Start the first build, or a rebuild of an index that has no events and is old, or one whose queue overflowed. */
  ensure(): Promise<void> {
    const old = this.current && (this.stale || ((this.degraded || (this.watcherTried && !this.watcher)) && Date.now() - this.builtAt > STALE_MS));
    if (!this.current || old) this.buildP ??= this.build().finally(() => { this.buildP = null; });
    return this.buildP ?? Promise.resolve();
  }

  /** Resolves when the build in progress is done. For tests and measurements. */
  whenBuilt(): Promise<void> { return this.buildP ?? Promise.resolve(); }

  close() { this.watcher?.close(); this.watcher = null; }

  private async build() {
    const t0 = performance.now();
    const rows = new Rows();
    this.building = rows;
    this.stale = false;
    if (!this.watcherTried) { this.watcherTried = true; this.watcher = openWatcher((evs) => this.onEvents(evs)); }
    const mountTable = this.mounts();
    const roots: number[] = [];
    for (const r of this.roots()) {
      let real: string;
      try { real = await realpath(r); } catch { continue; }
      if (roots.some((i) => real === rows.name(i) || real.startsWith(rows.name(i) + "/"))) continue;
      const i = rows.add(-1, real, true);
      roots.push(i);
    }
    const stack = [...roots];
    const skipMounts = new Set<string>(); for (const i of roots) for (const m of mountsUnder(rows.name(i), mountTable)) skipMounts.add(m);
    let sliceStart = performance.now();
    const breathe = async () => { if (performance.now() - sliceStart > SLICE_MS) { await sleep(BREATH_MS); sliceStart = performance.now(); } };
    const worker = async () => {
      for (;;) {
        const d = stack.pop();
        if (d === undefined) { if (inflight === 0) return; await sleep(1); continue; }
        inflight++;
        try { await this.scanDir(rows, d, skipMounts, stack, breathe); } finally { inflight--; }
      }
    };
    let inflight = 0;
    await Promise.all([worker(), worker(), worker(), worker()]);
    this.current = rows;
    this.building = null;
    this.builtAt = Date.now();
    this.buildMs = performance.now() - t0;
  }

  /** One folder: watch it first (so nothing made while it is read is missed), read it, and queue its subfolders. */
  private async scanDir(rows: Rows, d: number, skipMounts: Set<string>, stack: number[], breathe: () => Promise<void>) {
    const abs = rows.path(d);
    if (agentglassPrivate(abs)) return;
    if (this.watcher && rows.wd[d]! < 0) {
      const w = this.watcher.add(abs);
      if (w >= 0) { rows.wd[d] = w; rows.byWatch.set(w, d); } else this.degraded = true;
    }
    let ents: import("node:fs").Dirent[];
    try { ents = await readdir(abs, { withFileTypes: true }); } catch { return; }
    let i = 0;
    // The row this scan added last. The list's head being anything else means an
    // event added to this folder while the scan was waiting, and only then can a
    // name be there twice. Looking for it on every entry was quadratic: a folder
    // of 50,000 files cost 50,000 walks down its own list.
    let mine = rows.first[d]!;
    for (const e of ents) {
      if (++i % 2000 === 0) await breathe();
      if (e.name.startsWith(".") || SKIP.has(e.name) || e.name.length > 250) continue;
      if (rows.first[d] !== mine && rows.child(d, e.name) >= 0) continue; // an event got there first
      const dir = e.isDirectory();
      if (dir && skipMounts.has(join(abs, e.name))) continue;
      const c = rows.add(d, e.name, dir);
      mine = c;
      if (dir) stack.push(c);
    }
    await breathe();
  }

  /* ---- events -------------------------------------------------------- */

  private onEvents(evs: WatchEvent[]) {
    this.events = this.events.then(() => this.apply(evs)).catch(() => { this.stale = true; });
  }

  private async apply(evs: WatchEvent[]) {
    const targets = [this.current, this.building].filter((r): r is Rows => !!r);
    for (const ev of evs) {
      if (ev.mask & IN_Q_OVERFLOW) { this.stale = true; continue; }
      if (ev.mask & IN_IGNORED) continue;
      for (const rows of targets) {
        const at = rows.byWatch.get(ev.wd);
        if (at === undefined) continue;
        if (ev.mask & (IN_DELETE_SELF | IN_MOVE_SELF)) { if (rows.parent[at]! >= 0) rows.kill(at); continue; }
        if (!ev.name || ev.name.startsWith(".") || SKIP.has(ev.name)) continue;
        if (ev.mask & (IN_DELETE | IN_MOVED_FROM)) {
          const c = rows.child(at, ev.name);
          if (c >= 0) rows.kill(c);
        } else if (ev.mask & (IN_CREATE | IN_MOVED_TO)) {
          if (rows.child(at, ev.name) >= 0) continue;
          const abs = join(rows.path(at), ev.name);
          let dir = (ev.mask & IN_ISDIR) !== 0;
          if (!dir) { try { dir = (await lstat(abs)).isDirectory(); } catch { continue; } }
          const c = rows.add(at, ev.name, dir);
          if (dir) {
            const stack = [c];
            let sliceStart = performance.now();
            const breathe = async () => { if (performance.now() - sliceStart > SLICE_MS) { await sleep(BREATH_MS); sliceStart = performance.now(); } };
            while (stack.length) await this.scanDir(rows, stack.pop()!, new Set(), stack, breathe);
          }
        }
      }
    }
    // A quarter of the rows dead: not worth carrying. A rebuild is the compaction.
    const r = this.current;
    if (r && r.dead > 10_000 && r.dead > r.n / 4) this.stale = true;
  }

  /* ---- search -------------------------------------------------------- */

  /**
   * Fuzzy search by name. The words of the query are split on spaces and `/`;
   * the last one is matched against the name, and every earlier one against a
   * folder above it, nearest first, so `src comp btn` finds `src/components/Btn.tsx`.
   */
  async search(q: string, limit = 60, signal?: AbortSignal): Promise<SearchResult> {
    const t0 = performance.now();
    void this.ensure();
    const rows = this.current ?? this.building;
    const words = q.toLowerCase().split(/[\s/]+/).filter(Boolean);
    if (!rows || words.length === 0) return { ok: true, hits: [], scanned: 0, ms: 0, building: !this.current, truncated: false };
    const needles = words.map((w) => needleBytes(w));
    const last = needles[needles.length - 1]!;
    const up = needles.slice(0, -1);
    const top: { i: number; score: number }[] = [];
    const n = rows.n;
    const names = rows.names;
    let sliceStart = performance.now();
    for (let i = 0; i < n; i++) {
      if ((i & 4095) === 0 && performance.now() - sliceStart > SLICE_MS) {
        if (signal?.aborted) return { ok: true, hits: [], scanned: i, ms: performance.now() - t0, building: !this.current, truncated: true };
        await new Promise<void>((r) => setImmediate(r));
        sliceStart = performance.now();
      }
      if (rows.flags[i]! & DEAD) continue;
      const o = rows.off[i]!;
      let score = fuzzyScore(names, o, o + rows.len[i]!, last);
      if (score < 0) continue;
      if (up.length) {
        let at = rows.parent[i]!, k = up.length - 1;
        while (k >= 0 && at >= 0) {
          const s = fuzzyScore(names, rows.off[at]!, rows.off[at]! + rows.len[at]!, up[k]!);
          if (s >= 0) { score += s * 0.5; k--; }
          at = rows.parent[at]!;
        }
        if (k >= 0) continue;
      }
      if (rows.parent[i]! < 0) continue; // a root is where you are, not a result
      if (top.length < limit || score > top[top.length - 1]!.score) {
        let j = top.length;
        while (j > 0 && top[j - 1]!.score < score) j--;
        top.splice(j, 0, { i, score });
        if (top.length > limit) top.pop();
      }
    }
    return { ok: true, hits: top.map((h) => ({ path: rows.path(h.i), dir: rows.isDir(h.i), score: h.score })), scanned: n, ms: performance.now() - t0, building: !this.current, truncated: false };
  }
}

/** The one index of this server. Built on the first question, not at start. */
let shared: HomeIndex | null = null;
export const homeIndex = (): HomeIndex => (shared ??= new HomeIndex());
