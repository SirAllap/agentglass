/*
 * A commit's tracked files, written into a folder, by reading the objects and
 * nothing else.
 *
 * Not `git archive`: measured, it runs the repository's own smudge filters
 * (`filter.<name>.smudge`, `.process`, and LFS's) for every file the commit's
 * `.gitattributes` points at one, on the person's machine and outside any box,
 * and `GIT_ATTR_SOURCE` does not stop it. It also drops whatever the commit marks
 * `export-ignore`, which for a test run is often the tests. `ls-tree` and
 * `cat-file --batch` read raw blobs: no attribute is consulted, no filter or
 * textconv exists on that path, and nothing is written to the repository.
 *
 * What the folder holds: regular files and symlinks as the commit has them
 * (symlinks last, so no later write can travel through one), a submodule as an
 * empty directory, an LFS file as its pointer text. Ceilings: a path that is not
 * valid UTF-8 is not exported faithfully, and a commit over a cap (EXPORT_CAP
 * bytes in all, BLOB_CAP for one file, MAX_ENTRIES files, LS_CAP bytes of listing)
 * is a refusal, not a partial export.
 *
 * Nothing is written until the whole listing has been checked, and then nothing
 * is written through a symlink: a hand-built tree (or, on a case-insensitive
 * filesystem, an ordinary one) can hold a symlink `a` and then an entry `a/b`,
 * and following the first to create the second would land outside the folder,
 * before any box exists. So a commit where an entry sits under another entry,
 * or two entries share a path, is refused whole; and every write walks its
 * parents one by one, refusing a symlink, and opens its file without following one.
 */
import { spawn } from "bun";
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync, symlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

export const EXPORT_CAP = 1024 * 1024 * 1024;
export const BLOB_CAP = 64 * 1024 * 1024;
export const MAX_ENTRIES = 50_000;
export const LS_CAP = 16 * 1024 * 1024;

/** Read-only plumbing and nothing it could fetch: a missing object in a partial clone is an error here, never a download. */
const GIT_FLAGS = ["-c", "core.fsmonitor=false", "-c", "safe.bareRepository=explicit"];
const GIT_ENV = { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_NO_LAZY_FETCH: "1" };

export function spawnGit(gitRoot: string, args: string[], stdin: "pipe" | "ignore" = "ignore") {
  return spawn(["git", ...GIT_FLAGS, "-C", gitRoot, ...args], { env: { PATH: process.env.PATH ?? "", ...GIT_ENV }, stdin, stdout: "pipe", stderr: "ignore" });
}

interface Entry { mode: string; oid: string; path: string }

/** A path a commit may hold that must never become a file here: empty, `.`/`..`, or inside `.git`. */
export function unsafePath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\0")) return true;
  return path.split("/").some((c) => c === "" || c === "." || c === ".." || c.toLowerCase() === ".git");
}

const fold = (p: string) => p.normalize("NFC").toLowerCase();

/**
 * Why this listing cannot be exported safely, or "". An entry under another entry
 * (a file, a symlink or a submodule above it) and a repeated path are never a
 * real commit; a symlink whose path matches another entry's parent once case and
 * Unicode form are folded is the same thing on a filesystem that folds them.
 */
export function conflictIn(paths: { path: string; mode: string }[]): string {
  const exact = new Set<string>();
  const folded = new Set<string>();
  const links = new Set<string>();
  for (const e of paths) {
    if (exact.has(e.path)) return "the commit lists one path twice";
    exact.add(e.path);
    folded.add(fold(e.path));
    if (e.mode === "120000") links.add(fold(e.path));
  }
  for (const e of paths) {
    const parts = e.path.split("/");
    for (let n = 1; n < parts.length; n++) {
      const above = parts.slice(0, n).join("/");
      if (exact.has(above) || links.has(fold(above))) return "the commit holds an entry under another entry";
    }
  }
  return "";
}

/** Make every directory above `rel` under `dir`, refusing to pass through a symlink or a file: one component at a time. */
export function ensureParent(dir: string, rel: string): void {
  const parts = rel.split("/").slice(0, -1);
  let cur = dir;
  for (const c of parts) {
    cur = join(cur, c);
    let st;
    try { st = lstatSync(cur); } catch { mkdirSync(cur); continue; }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${c} is not a plain directory`);
  }
}

/** Chunks queued from a stream, read as lines and as counted runs of bytes, without ever joining them. */
class Pipe {
  private chunks: Uint8Array[] = [];
  private off = 0;
  constructor(private reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> }) {}
  private async more(): Promise<boolean> {
    while (!this.chunks.length) {
      const r = await this.reader.read();
      if (r.done) return false;
      if (r.value?.length) this.chunks.push(r.value);
    }
    return true;
  }
  /** One line without its newline, at most 512 bytes; null at the end. */
  async line(): Promise<string | null> {
    const parts: Buffer[] = [];
    let len = 0;
    for (;;) {
      if (!(await this.more())) return null;
      const c = this.chunks[0]!;
      const nl = c.indexOf(10, this.off);
      const end = nl < 0 ? c.length : nl;
      parts.push(Buffer.from(c.subarray(this.off, end)));
      len += end - this.off;
      if (len > 512) return null;
      if (nl >= 0) { this.advance(nl + 1 - this.off); return Buffer.concat(parts).toString("latin1"); }
      this.advance(c.length - this.off);
    }
  }
  /** `n` bytes into `sink`, as they arrive. False if the stream ended first. */
  async take(n: number, sink: (b: Uint8Array) => void): Promise<boolean> {
    while (n > 0) {
      if (!(await this.more())) return false;
      const c = this.chunks[0]!;
      const k = Math.min(n, c.length - this.off);
      sink(c.subarray(this.off, this.off + k));
      this.advance(k);
      n -= k;
    }
    return true;
  }
  private advance(k: number): void {
    this.off += k;
    if (this.off >= this.chunks[0]!.length) { this.chunks.shift(); this.off = 0; }
  }
}

/** `ls-tree -r -z`, read as it comes and cut at LS_CAP: a hostile tree must not fill memory before any cap can see it. */
async function listTree(gitRoot: string, sha: string): Promise<string | { error: string }> {
  const p = spawnGit(gitRoot, ["ls-tree", "-r", "-z", "--full-tree", sha]);
  const parts: Buffer[] = [];
  let size = 0;
  const reader = p.stdout.getReader();
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    size += r.value.length;
    if (size > LS_CAP) { p.kill(); return { error: "the commit lists too many files to export" }; }
    parts.push(Buffer.from(r.value));
  }
  if ((await p.exited) !== 0) return { error: "could not read the commit" };
  return Buffer.concat(parts).toString("utf8");
}

export async function exportTree(gitRoot: string, sha: string, dir: string): Promise<string | null> {
  const listing = await listTree(gitRoot, sha);
  if (typeof listing !== "string") return listing.error;
  const entries: Entry[] = [];
  for (const rec of listing.split("\0")) {
    const m = /^(\d{6}) (\w+) ([0-9a-f]{40})\t([\s\S]+)$/.exec(rec);
    if (m && !unsafePath(m[4]!)) entries.push({ mode: m[1]!, oid: m[3]!, path: m[4]! });
  }
  if (entries.length > MAX_ENTRIES) return `the commit has more than ${MAX_ENTRIES} files`;
  const conflict = conflictIn(entries);
  if (conflict) return conflict;
  mkdirSync(dir, { recursive: true });
  const blobs = entries.filter((e) => e.mode === "100644" || e.mode === "100755" || e.mode === "120000");
  try {
    for (const e of entries) if (e.mode === "160000") { ensureParent(dir, e.path); mkdirSync(join(dir, e.path), { recursive: false }); }
  } catch { return "a submodule path could not be made"; }

  const cat = spawnGit(gitRoot, ["cat-file", "--batch"], "pipe");
  cat.stdin!.write(blobs.map((b) => `${b.oid}\n`).join(""));
  void cat.stdin!.end();
  const reader = cat.stdout.getReader();
  const pipe = new Pipe(reader);
  const links: { path: string; target: string }[] = [];
  let total = 0;
  try {
    for (const b of blobs) {
      const head = (await pipe.line())?.split(" ");
      if (!head) return "the object database ended early";
      if (head[1] !== "blob") return `an object of the commit is missing (${(head[0] ?? "").slice(0, 7)})`;
      const size = Number(head[2]);
      total += size;
      if (!Number.isInteger(size) || size > BLOB_CAP) return `a file in the commit is over ${BLOB_CAP / 1024 / 1024} MB`;
      if (total > EXPORT_CAP) return "the commit is too large to export";
      if (b.mode === "120000") {
        const t: Uint8Array[] = [];
        if (size > 4096 || !(await pipe.take(size, (x) => t.push(Buffer.from(x))))) return "a symlink of the commit is unreadable";
        links.push({ path: b.path, target: Buffer.concat(t).toString("utf8") });
      } else {
        try { ensureParent(dir, b.path); } catch { return "the commit holds a path that passes through a link"; }
        // O_EXCL | O_NOFOLLOW: never an existing file, never a symlink in the last place either.
        const fd = openSync(join(dir, b.path), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, b.mode === "100755" ? 0o755 : 0o644);
        try {
          if (!(await pipe.take(size, (x) => { writeSync(fd, x); }))) return "the object database ended early";
        } finally { closeSync(fd); }
        chmodSync(join(dir, b.path), b.mode === "100755" ? 0o755 : 0o644);
      }
      if (!(await pipe.take(1, () => {}))) return "the object database ended early";
    }
  } catch (e) {
    return `could not write the commit: ${e instanceof Error ? e.message.slice(0, 100) : "unknown"}`;
  } finally {
    void reader.cancel().catch(() => { /* already done */ });
  }
  for (const l of links) {
    try { ensureParent(dir, l.path); symlinkSync(l.target, join(dir, l.path)); } catch { /* a path something already holds: skipped */ }
  }
  return null;
}
