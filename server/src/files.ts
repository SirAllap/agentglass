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

import { readdirSync, statSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import { git, safeAbs } from "./git.ts";
import { inScope } from "./config.ts";

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
 */
function inside(rootIn: unknown, relIn: unknown): { root: string; abs: string; rel: string } | { error: string } {
  const root = safeAbs(rootIn);
  if (!root) return { error: "no directory given" };
  try { if (!statSync(root).isDirectory()) return { error: "not a directory" }; }
  catch { return { error: "no such directory" }; }
  if (!inScope(root)) return { error: "outside the open project — open the parent folder to work across repos" };
  const rel = typeof relIn === "string" ? relIn : "";
  if (rel.includes("\0")) return { error: "invalid path" };
  const abs = resolve(root, rel);
  // `relative` rather than a prefix test: "/a/b" is not inside "/a/bc", and a
  // startsWith would say it is.
  const back = relative(root, abs);
  if (back.startsWith("..") || back.startsWith(sep) || resolve(root, back) !== abs) return { error: "outside the checkout" };
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
export function findFiles(rootIn: unknown, queryIn: unknown, limit = MAX_FILES): FindReport {
  const at = inside(rootIn, "");
  if ("error" in at) return { ok: false, files: [], truncated: false, via: "", error: at.error };
  const q = typeof queryIn === "string" ? queryIn.trim() : "";
  if (!q) return { ok: true, files: [], truncated: false, via: "" };

  const fd = Bun.which("fd") ?? Bun.which("fdfind");
  if (fd) {
    // --fixed-strings: a path is typed, not written as a regex, and a stray `.`
    // or `+` in a filename should find that filename.
    const r = Bun.spawnSync([fd, "--type", "f", "--hidden", "--exclude", ".git", "--fixed-strings", q],
      { cwd: at.root, stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    const files = lines(r.stdout).slice(0, limit);
    return { ok: true, files, truncated: lines(r.stdout).length > limit, via: "fd" };
  }

  const r = git(at.root, ["ls-files", "--cached", "--others", "--exclude-standard"]);
  const needle = q.toLowerCase();
  const all = r.stdout.split("\n").filter((p) => p && p.toLowerCase().includes(needle));
  return { ok: true, files: all.slice(0, limit), truncated: all.length > limit, via: "git ls-files" };
}

/**
 * Files whose CONTENT matches.
 *
 * `rg` when installed, `git grep` otherwise. Both are given a fixed string for
 * the same reason as above: nobody typing `useState(` into a search box means
 * "an unclosed group".
 */
export function grepFiles(rootIn: unknown, queryIn: unknown, limit = MAX_HITS): GrepReport {
  const at = inside(rootIn, "");
  if ("error" in at) return { ok: false, hits: [], files: 0, truncated: false, via: "", error: at.error };
  const q = typeof queryIn === "string" ? queryIn.trim() : "";
  // Two characters, same floor the in-review search uses: one letter matches
  // every file in the repository, which is not a search result.
  if (q.length < 2) return { ok: true, hits: [], files: 0, truncated: false, via: "" };

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
