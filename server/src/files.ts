// Browsing and searching a checkout — the file tree the app never had.
//
// Everything else in this app is about what CHANGED: the diff, the working
// tree, the pull request. That is the right default and it leaves one hole —
// the file nobody touched. "What does this helper actually do?", asked about
// code that is not in any diff, meant leaving for an editor, and coming back to
// find your place again.
//
// Three questions, three answers, and each one delegates to the tool that is
// already best at it. `fd` and `rg` when they are installed, git's own `ls-files`
// and `grep` when they are not — which are always there, because this only ever
// runs inside a git checkout.
//
// The root is not a suggestion. Every path handed back is inside the checkout
// that was asked for, and every path coming in is resolved and checked against
// it before it reaches the filesystem — a listing endpoint that accepts
// `../../../etc` is a file server for the whole machine.

import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative, sep } from "node:path";
import { git, safeAbs } from "./git.ts";
import { inScope } from "./config.ts";
import { diskAllows } from "./disk.ts";
import { makeViewTempDir } from "./viewtemp.ts";

export interface FileEntry {
  name: string;
  /** Path relative to the checkout root — what every other call here takes. */
  rel: string;
  dir: boolean;
  /** Bytes, for a file. Directories do not report one: it would mean a
   *  recursive walk per row, and the Space report is where that question is
   *  answered properly. */
  size?: number;
  /** This file's git status in this checkout: M, A, D, R, ? for untracked. */
  status?: string;
}

export interface TreeReport {
  ok: boolean;
  root: string;
  rel: string;
  entries: FileEntry[];
  error?: string;
}

export interface FindReport {
  ok: boolean;
  files: string[];
  /** Directories whose path matches too.
   *
   *  A folder is a search result: typing `guest-checkout-v2` is how anybody
   *  refers to a place in a repository, and the answer to it is the place.
   *  Kept apart from `files` rather than mixed in, because opening one is a
   *  different action — a file opens in the viewer, a directory moves the
   *  tree. */
  dirs: string[];
  truncated: boolean;
  /** Which tool answered, so a surprising result set can be explained rather
   *  than doubted. */
  via: string;
  error?: string;
}

export interface GrepHit {
  rel: string;
  line: number;
  text: string;
  /** Where the match starts in `text`, and how long — so the UI can pick the
   *  hit out without re-running the search client-side against different
   *  case rules than the one that produced it. */
  at: number;
  len: number;
}

export interface GrepReport {
  ok: boolean;
  hits: GrepHit[];
  files: number;
  truncated: boolean;
  via: string;
  error?: string;
}

/** Enough to browse, few enough that pointing this at a node_modules cannot
 *  turn one click into a megabyte of JSON. */
const MAX_ENTRIES = 500;
const MAX_FILES = 300;
const MAX_HITS = 200;
/** Longest line we will carry back from a search. A minified bundle is one
 *  400 KB line, and it matches almost everything. */
const MAX_LINE = 400;

/**
 * Resolve `rel` inside `root`, or refuse.
 *
 * Both halves matter. `root` has to be a directory this server is allowed to
 * read at all (the workspace scope), and `rel` has to stay inside it after
 * resolution — `..`, an absolute path and a symlink-shaped name are all just
 * strings until `resolve` has had them.
 *
 * There is a second way to be allowed, and only one: a document under your own
 * home directory, which is what the finder's machine tab searches. It is
 * spelled out in disk.ts rather than here, and it is asked TWICE — of the root,
 * and of the path that came out of resolving `rel` against it. Once would be
 * enough for `..` and is not enough for a symlink, which is the whole reason
 * that check resolves them.
 */
function inside(rootIn: unknown, relIn: unknown): { root: string; abs: string; rel: string } | { error: string } {
  const root = safeAbs(rootIn);
  if (!root) return { error: "no directory given" };
  try { if (!statSync(root).isDirectory()) return { error: "not a directory" }; }
  catch { return { error: "no such directory" }; }
  const scoped = inScope(root);
  if (!scoped && !diskAllows(root)) return { error: "outside the open project — open the parent folder to work across repos" };
  const rel = typeof relIn === "string" ? relIn : "";
  if (rel.includes("\0")) return { error: "invalid path" };
  const abs = resolve(root, rel);
  // `relative` rather than a prefix test: "/a/b" is not inside "/a/bc", and a
  // startsWith would say it is.
  const back = relative(root, abs);
  if (back.startsWith("..") || back.startsWith(sep) || resolve(root, back) !== abs) return { error: "outside the checkout" };
  if (!scoped && !diskAllows(abs)) return { error: "outside what this search may read" };
  return { root, abs, rel: back };
}

/**
 * One level of the tree.
 *
 * One level, not a recursive walk: a checkout with a node_modules in it is
 * hundreds of thousands of entries, and the answer to "show me this folder" is
 * this folder. The client asks again when a directory is opened, which is also
 * what makes a big tree cheap to navigate.
 */
export function fileTree(rootIn: unknown, relIn: unknown): TreeReport {
  const at = inside(rootIn, relIn);
  if ("error" in at) return { ok: false, root: "", rel: "", entries: [], error: at.error };

  let names: string[];
  try { names = readdirSync(at.abs); } catch (e) { return { ok: false, root: at.root, rel: at.rel, entries: [], error: String(e) }; }

  const marks = statusMarks(at.root);
  const entries: FileEntry[] = [];
  for (const name of names) {
    // `.git` is machinery, not content: opening it is never what was meant, and
    // it is thousands of objects deep.
    if (name === ".git") continue;
    const rel = at.rel ? `${at.rel}/${name}` : name;
    let st;
    try { st = statSync(join(at.abs, name)); } catch { continue; } // a broken symlink
    const dir = st.isDirectory();
    entries.push({ name, rel, dir, ...(dir ? {} : { size: st.size }), ...(marks.get(rel) ? { status: marks.get(rel) } : {}) });
    if (entries.length >= MAX_ENTRIES) break;
  }
  // Directories first, then names — the order a file tree has had since the
  // first one, and the only one you can scan without reading every row.
  entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  return { ok: true, root: at.root, rel: at.rel, entries };
}

/**
 * Files whose PATH matches.
 *
 * `fd` when it is installed: it respects .gitignore, it is threaded, and it
 * answers a 200k-file tree faster than the walk it replaces. `git ls-files`
 * otherwise — always present, and it lists exactly the tracked files, which is
 * a slightly narrower but never wrong answer.
 */
/**
 * A ref this repository actually has, or null.
 *
 * Asked of git rather than pattern-matched, and that is both halves of the job:
 * it is the containment check for a value that becomes a command argument, and
 * it is the only way to know `origin/master` is not simply a typo — a name that
 * does not resolve would otherwise come back as "no results", which reads as
 * "your migration is safe" when the truth is nobody looked.
 *
 * `^{commit}` so a tag or a branch both land on something with a tree, and
 * `--verify --quiet` so an unknown name is an empty answer instead of noise on
 * stderr.
 */
export function resolveRef(root: string, refIn: unknown): string | null {
  const ref = typeof refIn === "string" ? refIn.trim() : "";
  if (!ref) return null;
  // Nothing that could be read as an option, and nothing with whitespace: git
  // takes `--upload-pack=...` as a flag wherever it appears.
  if (ref.startsWith("-") || /\s/.test(ref)) return null;
  const r = git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return r.code === 0 && r.stdout.trim() ? ref : null;
}

/**
 * Every path a ref holds, from the object store.
 *
 * `ls-tree -r` reads the commit's tree directly: nothing is checked out, no
 * worktree is touched, and the answer is what that branch has right now rather
 * than what this disk has. That is the whole point of asking — "which
 * migrations are on origin/master" is a question about a branch you are not on
 * and must not switch to.
 */
function pathsAt(root: string, ref: string): string[] {
  const r = git(root, ["ls-tree", "-r", "--name-only", ref]);
  return r.code === 0 ? r.stdout.split("\n").filter(Boolean) : [];
}

/** Files and folders matching `needle` among `paths`, folders derived from the
 *  prefixes — the same rule the git fallback uses, since git tracks files and
 *  has no notion of a directory either way. */
function matchPaths(paths: string[], needle: string, limit: number): { files: string[]; dirs: string[]; truncated: boolean } {
  const files = paths.filter((p) => p.toLowerCase().includes(needle));
  const dirSet = new Set<string>();
  for (const p of paths) {
    const parts = p.split("/");
    for (let n = 1; n < parts.length; n++) {
      const dir = parts.slice(0, n).join("/");
      if (dir.toLowerCase().includes(needle)) dirSet.add(dir);
    }
  }
  return {
    files: files.slice(0, limit),
    dirs: [...dirSet].sort().slice(0, limit),
    truncated: files.length > limit,
  };
}

export function findFiles(rootIn: unknown, queryIn: unknown, limit = MAX_FILES, refIn?: unknown): FindReport {
  const at = inside(rootIn, "");
  if ("error" in at) return { ok: false, files: [], dirs: [], truncated: false, via: "", error: at.error };
  const q = typeof queryIn === "string" ? queryIn.trim() : "";
  if (!q) return { ok: true, files: [], dirs: [], truncated: false, via: "" };

  /*
   * A branch you are not on — origin/master, most usefully.
   *
   * "Which migration numbers already exist upstream" cannot be answered by the
   * working tree, and the alternatives are all worse than this: fetch and
   * check out (loses your place), a second worktree (a checkout on disk for a
   * listing), or reading it in the browser. `ls-tree` is neither — it is a read
   * of the object store this repository already has.
   */
  if (refIn !== undefined && refIn !== null && refIn !== "") {
    const ref = resolveRef(at.root, refIn);
    if (!ref) {
      return { ok: false, files: [], dirs: [], truncated: false, via: "",
        error: `No such branch or ref here: ${String(refIn)}. Fetch it first if it is new.` };
    }
    const m = matchPaths(pathsAt(at.root, ref), q.toLowerCase(), limit);
    return { ok: true, ...m, via: `git ls-tree ${ref}` };
  }

  const fd = Bun.which("fd") ?? Bun.which("fdfind");
  if (fd) {
    // --fixed-strings: a path is typed, not written as a regex, and a stray `.`
    // or `+` in a filename should find that filename.
    //
    // Directories in the same breath, and `fd` marks them with a trailing
    // slash so one run answers both. Asking twice would double the walk of a
    // checkout for an answer one walk already contains.
    // --full-path, because the query is a PATH. Without it `fd` compares only
    // the basename: typing `guest-checkout-v2` — a folder near the root —
    // answered with nothing at all, since no file is called that. The git
    // fallback below has always matched the whole path, so the two backends
    // were also giving different answers to the same question depending on
    // what was installed.
    const r = Bun.spawnSync([fd, "--hidden", "--exclude", ".git", "--full-path", "--fixed-strings", q],
      { cwd: at.root, stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    const all = lines(r.stdout);
    const dirs = all.filter((p) => p.endsWith("/")).map((p) => p.replace(/\/$/, "")).slice(0, limit);
    const files = all.filter((p) => !p.endsWith("/")).slice(0, limit);
    return { ok: true, files, dirs, truncated: all.length > limit * 2, via: "fd" };
  }

  const r = git(at.root, ["ls-files", "--cached", "--others", "--exclude-standard"]);
  const needle = q.toLowerCase();
  const tracked = r.stdout.split("\n").filter(Boolean);
  const all = tracked.filter((p) => p.toLowerCase().includes(needle));
  /*
   * git has no notion of a directory — it tracks files — so the folders are
   * derived from the paths it does know: every prefix of every tracked file,
   * kept when the prefix itself matches. That finds an empty directory not at
   * all, which is the one git cannot see either.
   */
  const dirSet = new Set<string>();
  for (const p of tracked) {
    const parts = p.split("/");
    for (let n = 1; n < parts.length; n++) {
      const dir = parts.slice(0, n).join("/");
      if (dir.toLowerCase().includes(needle)) dirSet.add(dir);
    }
  }
  const dirs = [...dirSet].sort().slice(0, limit);
  return { ok: true, files: all.slice(0, limit), dirs, truncated: all.length > limit, via: "git ls-files" };
}

/**
 * Files whose CONTENT matches.
 *
 * `rg` when installed, `git grep` otherwise. Both are given a fixed string for
 * the same reason as above: nobody typing `useState(` into a search box means
 * "an unclosed group".
 */
export function grepFiles(rootIn: unknown, queryIn: unknown, limit = MAX_HITS, refIn?: unknown): GrepReport {
  const at = inside(rootIn, "");
  if ("error" in at) return { ok: false, hits: [], files: 0, truncated: false, via: "", error: at.error };
  const q = typeof queryIn === "string" ? queryIn.trim() : "";
  // Two characters, same floor the in-review search uses: one letter matches
  // every file in the repository, which is not a search result.
  if (q.length < 2) return { ok: true, hits: [], files: 0, truncated: false, via: "" };

  /*
   * The same question of a branch you are not on. `git grep` takes a ref
   * directly and reads it out of the object store — ripgrep cannot, because
   * ripgrep searches files on disk and these are not on disk.
   *
   * Its output gains a `ref:` prefix on every line, which is stripped below so
   * a hit on a branch and a hit here look the same to the caller.
   */
  const atRef = refIn !== undefined && refIn !== null && refIn !== "" ? resolveRef(at.root, refIn) : null;
  if (refIn !== undefined && refIn !== null && refIn !== "" && !atRef) {
    return { ok: false, hits: [], files: 0, truncated: false, via: "",
      error: `No such branch or ref here: ${String(refIn)}. Fetch it first if it is new.` };
  }
  if (atRef) {
    /*
     * `-e <pattern> <ref>`, in that order, and no `--`.
     *
     * `git grep ... <ref> -- <q>` reads q as a PATHSPEC, not as the pattern —
     * so it searched the whole branch for a file called "0095" and answered
     * nothing. Silently: an empty result from a search is indistinguishable
     * from "that text is not on this branch", which is the answer somebody is
     * about to trust. `-e` names the pattern explicitly, which also keeps a
     * query starting with a dash from being read as a flag.
     */
    const r = Bun.spawnSync(["git", "-C", at.root, "grep", "--fixed-strings", "--ignore-case",
      "--line-number", "-I", "-e", q, atRef],
      { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
    const hits: GrepHit[] = [];
    const files = new Set<string>();
    const needle = q.toLowerCase();
    const all = lines(r.stdout);
    for (const line of all.slice(0, limit)) {
      // `ref:path:line:text` — the ref is stripped, the rest is the ordinary
      // shape. Split from the left only as far as needed: a path may contain a
      // colon and the text almost certainly does.
      const noRef = line.startsWith(`${atRef}:`) ? line.slice(atRef.length + 1) : line;
      const a1 = noRef.indexOf(":");
      const a2 = noRef.indexOf(":", a1 + 1);
      if (a1 < 0 || a2 < 0) continue;
      const rel = noRef.slice(0, a1);
      const ln = Number(noRef.slice(a1 + 1, a2));
      const text = noRef.slice(a2 + 1).slice(0, MAX_LINE);
      if (!Number.isFinite(ln)) continue;
      const at0 = text.toLowerCase().indexOf(needle);
      hits.push({ rel, line: ln, text, at: at0 < 0 ? 0 : at0, len: at0 < 0 ? 0 : q.length });
      files.add(rel);
    }
    return { ok: true, hits, files: files.size, truncated: all.length > limit, via: `git grep ${atRef}` };
  }

  const rg = Bun.which("rg");
  const out = rg
    ? Bun.spawnSync([rg, "--fixed-strings", "--ignore-case", "--line-number", "--no-heading", "--color", "never",
        // --max-columns alone REPLACES a long line with "[Omitted long matching
        // line]", which is not an excerpt of anything. The preview flag makes it
        // truncate instead, which is what a search result wants.
        "--max-columns", String(MAX_LINE), "--max-columns-preview", "--max-count", "20", "--", q],
        { cwd: at.root, stdout: "pipe", stderr: "pipe", timeout: 15_000 })
    : Bun.spawnSync(["git", "grep", "--fixed-strings", "--ignore-case", "--line-number", "--untracked", "-I", "--", q],
        { cwd: at.root, stdout: "pipe", stderr: "pipe", timeout: 15_000 });

  const hits: GrepHit[] = [];
  const files = new Set<string>();
  const needle = q.toLowerCase();
  const all = lines(out.stdout);
  for (const line of all) {
    // `path:line:text` — and a path can contain a colon, so the split is on the
    // FIRST two only and the rest is the text verbatim.
    const a = line.indexOf(":");
    if (a < 0) continue;
    const b = line.indexOf(":", a + 1);
    if (b < 0) continue;
    const rel = line.slice(0, a);
    const n = Number(line.slice(a + 1, b));
    if (!Number.isInteger(n)) continue;
    const text = line.slice(b + 1).slice(0, MAX_LINE);
    const at2 = text.toLowerCase().indexOf(needle);
    hits.push({ rel, line: n, text, at: at2 < 0 ? 0 : at2, len: at2 < 0 ? 0 : q.length });
    files.add(rel);
    if (hits.length >= limit) break;
  }
  return { ok: true, hits, files: files.size, truncated: all.length > hits.length, via: rg ? "rg" : "git grep" };
}

/** Every changed path in this checkout, as a single porcelain read. One spawn
 *  per listing rather than one per row, which is the difference between a
 *  folder opening instantly and a folder of 200 files taking a second. */
function statusMarks(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const r = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]);
  if (r.code !== 0) return out;
  // NUL-separated so a filename with a space or a newline in it survives. A
  // rename entry carries two paths; the second one is the name it has now.
  const parts = r.stdout.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e || e.length < 4) continue;
    const code = e.slice(0, 2);
    let path = e.slice(3);
    if (code[0] === "R" || code[0] === "C") { path = parts[++i] ?? path; }
    const mark = code.trim()[0] ?? "";
    if (!mark) continue;
    out.set(path, mark === "?" ? "?" : mark);
    // A change deep in a folder should be visible on the folder, or a tree you
    // have not opened yet looks clean.
    let dir = path;
    while (dir.includes("/")) {
      dir = dir.slice(0, dir.lastIndexOf("/"));
      if (!out.has(dir)) out.set(dir, "·");
    }
  }
  return out;
}

function lines(buf: Uint8Array): string[] {
  return new TextDecoder().decode(buf).split("\n").filter(Boolean);
}

/* ------------------------------------------------------ one file, as text */

/**
 * How much of a file is worth sending to a viewer.
 *
 * A markdown document is prose; the ones people keep are tens of kilobytes and
 * the biggest in this repository is under a hundred. A megabyte is far past
 * anything anybody wrote by hand and well short of what would hurt to move, so
 * it is the line between "read it" and "open it in the editor".
 */
const MAX_TEXT_BYTES = 1_000_000;

export interface FileText {
  ok: boolean;
  rel: string;
  text: string;
  bytes: number;
  /** The file is longer than the cap; `text` is the first MAX_TEXT_BYTES of
   *  it. Said rather than silently shown, because a document that stops in the
   *  middle of a sentence reads as a broken document. */
  truncated?: boolean;
  error?: string;
}

/**
 * A file's text, for something that renders rather than edits.
 *
 * Same containment as every other reader here — `inside()` decides what may be
 * read at all, and the same rules that stop the tree walking out of the
 * checkout stop this one.
 *
 * Binary is refused rather than mangled. A NUL byte in the first few kilobytes
 * is the test every tool from `grep` to `git` uses, and it is right for the
 * same reason: a viewer that decodes a PNG as UTF-8 produces a screen of
 * replacement characters and no explanation.
 */
export function fileText(rootIn: unknown, relIn: unknown, refIn?: unknown): FileText {
  const at = inside(rootIn, relIn);
  if ("error" in at) return { ok: false, rel: "", text: "", bytes: 0, error: at.error };

  /*
   * The file as that branch has it, not as this disk has it.
   *
   * Without this, a result found on origin/master opens the working tree's copy
   * of the same path — a different file wearing the right name, or nothing at
   * all for one that only exists upstream. That is the worst kind of wrong
   * answer: it looks like it worked.
   */
  if (refIn !== undefined && refIn !== null && refIn !== "") {
    const ref = resolveRef(at.root, refIn);
    if (!ref) return { ok: false, rel: at.rel, text: "", bytes: 0, error: `No such branch or ref here: ${String(refIn)}` };
    const r = git(at.root, ["show", `${ref}:${at.rel}`]);
    if (r.code !== 0) return { ok: false, rel: at.rel, text: "", bytes: 0, error: `${at.rel} is not on ${ref}` };
    const full = r.stdout;
    // Same ceiling and the same binary refusal as a file on disk: a ref is not
    // a reason to hand a megabyte of object store to the renderer.
    if (full.includes("\u0000")) return { ok: false, rel: at.rel, text: "", bytes: full.length, error: "that looks like a binary file" };
    const text = full.length > MAX_TEXT_BYTES ? full.slice(0, MAX_TEXT_BYTES) : full;
    return { ok: true, rel: at.rel, text, bytes: full.length, truncated: full.length > MAX_TEXT_BYTES };
  }

  let st;
  try { st = statSync(at.abs); } catch { return { ok: false, rel: at.rel, text: "", bytes: 0, error: "no such file" }; }
  if (st.isDirectory()) return { ok: false, rel: at.rel, text: "", bytes: 0, error: "that is a directory" };

  let buf: Buffer;
  try { buf = readFileSync(at.abs); } catch (e) { return { ok: false, rel: at.rel, text: "", bytes: 0, error: String(e) }; }

  const head = buf.subarray(0, 8192);
  if (head.includes(0)) return { ok: false, rel: at.rel, text: "", bytes: st.size, error: "that file is binary" };

  const truncated = buf.length > MAX_TEXT_BYTES;
  const text = new TextDecoder().decode(truncated ? buf.subarray(0, MAX_TEXT_BYTES) : buf);
  return { ok: true, rel: at.rel, text, bytes: st.size, ...(truncated ? { truncated: true } : {}) };
}

/**
 * That branch's version of a file, on disk, so an editor can open it.
 *
 * The reason this exists rather than the viewer rendering the text it already
 * has: only markdown is worth rendering, and everything else in a checkout is
 * code, which belongs in the editor that knows its language. But a file found on
 * a branch this worktree is not on has no path an editor could be pointed at —
 * the working tree's copy is a different file wearing the right name, and that
 * is the wrong answer that looks like it worked.
 *
 * So it is materialised, exactly as `prFileToTemp` does for a pull request's
 * copy. Everything about what may be read at all — containment, ref resolution,
 * the size ceiling, the binary refusal — is `fileText`'s, because a second
 * reader is a second set of rules to keep in step.
 *
 * Written outside the checkout: a temp file inside one turns up in somebody's
 * `git status` an hour later, wearing a name that looks like theirs.
 */
export function fileToTemp(rootIn: unknown, relIn: unknown, refIn: unknown): { ok: true; file: string; ref: string } | { ok: false; error: string } {
  const ref = typeof refIn === "string" ? refIn.trim() : "";
  if (!ref) return { ok: false, error: "no ref given" };
  const read = fileText(rootIn, relIn, ref);
  if (!read.ok) return { ok: false, error: read.error ?? "could not read that file" };
  const dir = makeViewTempDir("ref");
  // The ref in the name, because two of these open at once is the ordinary case
  // — the same path on two branches is exactly what somebody is comparing — and
  // an editor's tab strip showing the same basename twice says nothing.
  const safeRef = ref.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 40);
  const file = join(dir, `${safeRef}-${read.rel.split("/").pop() || "file"}`);
  writeFileSync(file, read.text);
  return { ok: true, file, ref };
}

/**
 * Every branch this repository can be searched at, local and remote.
 *
 * Local ones matter as much as remote: "what does orbit-WEB-1042 have in it" is
 * asked of a branch sitting in this repository that this worktree is not on,
 * and the only ways to look were to check it out — moving you off your work —
 * or to cut yet another worktree for a listing.
 *
 * Nothing here checks anything out. These names are handed to `ls-tree` and
 * `git grep <ref>`, which read the object store; the working tree is not
 * touched and HEAD does not move. That is the whole reason this can offer a
 * branch list at all without being dangerous.
 */
export function listRefs(rootIn: unknown): { ok: boolean; local: string[]; remote: string[]; head?: string; error?: string } {
  const at = inside(rootIn, "");
  if ("error" in at) return { ok: false, local: [], remote: [], error: at.error };

  const read = (glob: string) => {
    const r = git(at.root, ["for-each-ref", "--format=%(refname:short)", glob]);
    return r.code === 0 ? r.stdout.split("\n").map((x) => x.trim()).filter(Boolean) : [];
  };

  // The branch this worktree is on, so the list can say which one you are
  // already looking at rather than offering it as somewhere else to go.
  const h = git(at.root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const head = h.code === 0 ? h.stdout.trim() : undefined;

  /* main and master first — "does my migration collide with what is already
     there" means one of those nine times in ten — then the rest by name. */
  const rank = (x: string) => (/(^|\/)(main|master)$/.test(x) ? 0 : /(^|\/)(develop|dev|staging)$/.test(x) ? 1 : 2);
  const order = (xs: string[]) => xs.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

  return {
    ok: true,
    local: order(read("refs/heads")),
    // origin/HEAD is an alias for a branch already in the list, and offering
    // both invites "why do these two give the same answer".
    remote: order(read("refs/remotes").filter((x) => !x.endsWith("/HEAD"))),
    ...(head ? { head } : {}),
  };
}

/**
 * Which of these paths are actually here, right now.
 *
 * For the "Recent" list, which is a memory of what you opened and not a promise
 * that it still exists: switch that checkout to another branch and half the
 * list points at files the working tree no longer has. Clicking one opened an
 * empty viewer with "no such file" in it — a dead end that reads as a failure
 * of the viewer rather than a fact about the branch.
 *
 * One call for the whole list rather than one per row: a stat is cheap and a
 * round trip is not, and this runs every time that tab is shown.
 */
export function filesExist(rootIn: unknown, relsIn: unknown): { ok: boolean; here: string[]; error?: string } {
  const at = inside(rootIn, "");
  if ("error" in at) return { ok: false, here: [], error: at.error };
  const rels = Array.isArray(relsIn) ? relsIn.filter((x): x is string => typeof x === "string") : [];
  const here: string[] = [];
  // Capped: this takes a list from the client, and an unbounded one would be an
  // unbounded number of stats.
  for (const rel of rels.slice(0, 200)) {
    const one = inside(rootIn, rel);
    if ("error" in one) continue;
    try { statSync(one.abs); here.push(rel); } catch { /* not here, which is the answer */ }
  }
  return { ok: true, here };
}
