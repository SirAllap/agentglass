/*
 * What git knows about one file the finder is looking at.
 *
 * The finder's info rail says a file's status, how much it changed, the branch
 * and the last commit that touched it. That is four questions to git, asked
 * once per selected file, so it is one call here and one answer, not four
 * round trips from a rail that redraws on every arrow key.
 *
 * Judged like every other read on this surface (`browseReal`): the finder may
 * only ask about a place it may already look at, and git is only ever run
 * read-only, with the path after `--` so a name that starts with a dash cannot
 * become an option. No shell is involved anywhere: argv goes straight to git.
 */
import { statSync } from "node:fs";
import { basename, dirname, relative } from "node:path";
import { browseReal } from "./browse.ts";
import { git, repoRootOf } from "./git.ts";
import type { FileGitFacts, FileGitStatus } from "../../shared/types.ts";

export type { FileGitFacts, FileGitStatus };

/** The two-letter code of `status --porcelain=v1`, as a word. Exported so the
 *  mapping is testable without a repository. */
export function statusOf(xy: string): FileGitStatus {
  if (xy === "??") return "untracked";
  if (xy === "!!") return "ignored";
  if (xy.includes("U") || xy === "AA" || xy === "DD") return "conflict";
  if (xy.includes("R")) return "renamed";
  if (xy.includes("D")) return "deleted";
  if (xy.includes("A")) return "added";
  if (xy.trim()) return "modified";
  return "clean";
}

export function fileGitFacts(pathIn: unknown, local = false): FileGitFacts {
  const abs = browseReal(pathIn, local);
  if (!abs) return { ok: false, repo: false, error: "outside the places the finder may read" };
  let isDir = false;
  try { isDir = statSync(abs).isDirectory(); } catch { return { ok: false, repo: false, error: "no such file" }; }
  if (isDir) return { ok: true, repo: false };

  const root = repoRootOf(dirname(abs));
  if (!root) return { ok: true, repo: false };
  const rel = relative(root, abs);
  if (!rel || rel.startsWith("..")) return { ok: true, repo: false };

  const out: FileGitFacts = { ok: true, repo: true, path: `${basename(root)}/${rel}` };
  const st = git(root, ["status", "--porcelain=v1", "--ignored=matching", "--", rel]);
  out.status = st.code === 0 ? statusOf(st.stdout.slice(0, 2)) : "clean";

  const br = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (br.code === 0) out.branch = br.stdout.trim();

  if (out.status !== "untracked" && out.status !== "ignored") {
    const d = git(root, ["diff", "HEAD", "--numstat", "--", rel]);
    const m = d.code === 0 ? /^(\d+)\t(\d+)\t/.exec(d.stdout) : null;
    if (m) { out.added = Number(m[1]); out.removed = Number(m[2]); }
    const lg = git(root, ["log", "-1", "--format=%h%x1f%at%x1f%s", "--", rel]);
    const [hash, at, ...subject] = lg.code === 0 ? lg.stdout.trim().split("\x1f") : [];
    if (hash) out.commit = { hash, at: Number(at) * 1000 || 0, subject: subject.join("\x1f") };
  }
  return out;
}
