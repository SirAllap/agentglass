/*
 * A commit of a local checkout, as a tar stream: the body of GET /prs/tree-at,
 * for a reviewer that needs a pull request's code and must not call `gh` (a
 * private pull request answered 404 to the tarball download).
 *
 * The files come from `exportTree`, which reads raw objects and never touches
 * the checkout (no checkout, no reset, no smudge filter), into a private temp
 * folder that is removed when the stream ends, is cancelled, or the work fails.
 * Three limits are this route's own, tighter than the box ones because the bytes
 * leave the machine: TREE_AT_CAPS, and TREE_AT_MS for the whole call.
 *
 * Symlinks are the commit's own except that one pointing outside the tree is
 * dropped, whatever its target: an absolute path, or one that resolves out of the
 * folder (judged on the path as written and on the real path, so a link through another link counts). A
 * submodule is an empty directory, never its content. Binary files are kept.
 *
 * Ceiling: the written-path test also drops a link that climbs out and back in
 * through a symlinked directory; losing that one is the safe side. A call past TREE_AT_MS stops waiting for git; the git process that
 * was reading ends by itself when its pipe closes, it is not killed here.
 */
import { spawn } from "bun";
import { lstatSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { exportTree, type ExportCaps } from "./treeExport.ts";

export const TREE_AT_CAPS: ExportCaps = { total: 256 * 1024 * 1024, blob: 32 * 1024 * 1024, entries: 20_000 };
export const TREE_AT_MS = 60_000;

/** Every symlink under `dir` (never descending through one), as absolute paths. */
function symlinksUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) out.push(p);
    else if (st.isDirectory()) out.push(...symlinksUnder(p));
  }
  return out;
}

/** Drop each symlink that points out of `tree`. Returns how many. */
export function dropEscapingLinks(tree: string): number {
  const base = realpathSync(tree);
  let dropped = 0;
  for (const link of symlinksUnder(tree)) {
    const target = readlinkSync(link);
    const outside = (p: string) => p !== base && !p.startsWith(base + sep);
    // Lexically first, which catches a link to a path that does not exist (nothing to resolve); then the real path, which catches one through another link.
    let out = isAbsolute(target) || outside(resolve(dirname(link), target));
    if (!out) {
      try { out = outside(realpathSync(link)); } catch { /* dangling and lexically inside: points at nothing */ }
    }
    if (out) { unlinkSync(link); dropped++; }
  }
  return dropped;
}

export type TreeAt =
  | { ok: true; files: number; body: ReadableStream<Uint8Array> }
  | { ok: false; error: string };

export async function treeAtTar(gitRoot: string, sha: string, opts: { ms?: number } = {}): Promise<TreeAt> {
  const work = mkdtempSync(join(realpathSync(tmpdir()), "agx-treeat-"));
  const tree = join(work, "tree");
  const clean = () => { try { rmSync(work, { recursive: true, force: true }); } catch { /* already gone */ } };
  const stats = { files: 0 };
  const ms = opts.ms ?? TREE_AT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let proc: ReturnType<typeof spawn> | undefined;
  const expired = new Promise<string>((res) => { timer = setTimeout(() => res("timed out"), ms); });
  try {
    const err = await Promise.race([exportTree(gitRoot, sha, tree, { caps: TREE_AT_CAPS, stats }), expired.then(() => `the export took longer than ${Math.round(ms / 1000)} s`)]);
    if (err) { clearTimeout(timer); clean(); return { ok: false, error: err }; }
    dropEscapingLinks(tree);
    proc = spawn(["tar", "-cf", "-", "--owner=0", "--group=0", "--numeric-owner", "--sort=name", "-C", tree, "."], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  } catch (e) {
    clearTimeout(timer); clean();
    return { ok: false, error: `could not export the commit: ${e instanceof Error ? e.message.slice(0, 100) : "unknown"}` };
  }
  const p = proc!;
  const reader = (p.stdout as ReadableStream<Uint8Array>).getReader();
  let finished = false;
  const done = () => { clearTimeout(timer); clean(); };
  void expired.then(() => { if (!finished) p.kill(); });
  const body = new ReadableStream<Uint8Array>({
    async pull(ctl) {
      try {
        const r = await reader.read();
        if (r.done) {
          finished = true;
          done();
          // A tar that died part-way is an error on the stream, not a short archive that looks whole.
          if ((await p.exited) !== 0) ctl.error(new Error("tar failed")); else ctl.close();
          return;
        }
        ctl.enqueue(r.value);
      } catch (e) { finished = true; done(); ctl.error(e); }
    },
    cancel() { finished = true; p.kill(); done(); },
  });
  return { ok: true, files: stats.files, body };
}
