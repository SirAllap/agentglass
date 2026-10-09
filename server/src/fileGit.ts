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
 *
 * The finder reaches repositories nobody vouched for: an extracted archive in
 * Downloads carries its own .git/config, and a status over a file whose stat
 * data is stale re-hashes it through whatever clean filter that config names,
 * which is a command run as the user on a selection, not a click. So the
 * repository must be inside the open project, as for every other git read that
 * names one, and even there every command its own config can name is switched
 * off for these four reads (`neutralised`). With no project open the scope
 * answers yes to everything, which is why the second layer is not optional.
 */
import { statSync } from "node:fs";
import { basename, dirname, relative } from "node:path";
import { browseReal } from "./browse.ts";
import { inScopeReal } from "./config.ts";
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

/**
 * `-c` overrides that switch off every command these reads could otherwise
 * take from the repository's own config: a filter driver it defines (named
 * per driver, so only drivers from local or worktree config are listed; the
 * user's global ones, git-lfs among them, stay theirs), and a signature check
 * on `log`. Hooks and fsmonitor are already off in `git()`; diff's external
 * driver and textconv are refused by flag at the call. Exported for the test.
 */
export function neutralised(root: string): string[] {
  const out = ["-c", "log.showSignature=false"];
  // -z: a subsection may hold a newline, and one missed line is one filter left on.
  const f = git(root, ["config", "--show-scope", "--includes", "--list", "--name-only", "-z"]).stdout.split("\0");
  const seen = new Set<string>();
  for (let i = 0; i + 1 < f.length; i += 2) {
    const [scope, key] = [f[i], f[i + 1]];
    if ((scope !== "local" && scope !== "worktree") || !key) continue;
    const m = /^filter\.(.+)\.[^.]+$/.exec(key);
    if (!m || seen.has(m[1]!)) continue;
    seen.add(m[1]!);
    for (const k of ["clean", "smudge", "process"]) out.push("-c", `filter.${m[1]}.${k}=`);
    out.push("-c", `filter.${m[1]}.required=false`);
  }
  return out;
}

export function fileGitFacts(pathIn: unknown, local = false): FileGitFacts {
  const abs = browseReal(pathIn, local);
  if (!abs) return { ok: false, repo: false, error: "outside the places the finder may read" };
  let isDir = false;
  try { isDir = statSync(abs).isDirectory(); } catch { return { ok: false, repo: false, error: "no such file" }; }
  if (isDir) return { ok: true, repo: false };

  const root = repoRootOf(dirname(abs));
  if (!root || !inScopeReal(root)) return { ok: true, repo: false };
  const rel = relative(root, abs);
  if (!rel || rel.startsWith("..")) return { ok: true, repo: false };

  const out: FileGitFacts = { ok: true, repo: true, path: `${basename(root)}/${rel}` };
  // --no-optional-locks: a read never rewrites the index of somebody else's tree.
  const safe = ["--no-optional-locks", ...neutralised(root)];
  const st = git(root, [...safe, "status", "--porcelain=v1", "--ignored=matching", "--ignore-submodules=all", "--", rel]);
  out.status = st.code === 0 ? statusOf(st.stdout.slice(0, 2)) : "clean";

  const br = git(root, [...safe, "rev-parse", "--abbrev-ref", "HEAD"]);
  if (br.code === 0) out.branch = br.stdout.trim();

  if (out.status !== "untracked" && out.status !== "ignored") {
    const d = git(root, [...safe, "diff", "--no-ext-diff", "--no-textconv", "HEAD", "--numstat", "--", rel]);
    const m = d.code === 0 ? /^(\d+)\t(\d+)\t/.exec(d.stdout) : null;
    if (m) { out.added = Number(m[1]); out.removed = Number(m[2]); }
    const lg = git(root, [...safe, "log", "-1", "--format=%h%x1f%at%x1f%s", "--", rel]);
    const [hash, at, ...subject] = lg.code === 0 ? lg.stdout.trim().split("\x1f") : [];
    if (hash) out.commit = { hash, at: Number(at) * 1000 || 0, subject: subject.join("\x1f") };
  }
  return out;
}
