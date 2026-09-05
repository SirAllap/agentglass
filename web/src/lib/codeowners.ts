// Who owns the files this pull request touches.
//
// The panel could tell you who had been ASKED to review and never who the repository
// says should be. That question is answered by a file in the checkout — CODEOWNERS —
// and answering it by hand is opening the file, reading forty glob patterns and
// matching them against the paths in the review. Which is exactly the sort of thing
// that gets skipped, and then the pull request sits for a day waiting on somebody who
// was never asked.
//
// GitHub's matching rules, and each one is a way to be wrong:
//
//   LAST match wins.        Not the first, and not all of them. A file matched by
//                           `*` and by `/src/billing/` belongs to whoever the second
//                           line named — that is how a repository narrows ownership,
//                           and taking the first match reads the file upside down.
//   gitignore-shaped globs. `*` stops at a slash, `**` does not, a leading `/`
//                           anchors to the repository root, and a trailing `/` (or a
//                           bare directory name) matches everything underneath.
//   an empty owner list.    A pattern with nobody after it is legal and takes the
//                           path back OFF whoever owned it. Dropping those lines
//                           makes the file say the opposite of what it says.
//
// What this deliberately does not do is guess at teams: `@acme/backend` is carried
// through as written, because expanding it means asking GitHub who is in it, and a
// list of eleven names is not what "the backend team owns this" should look like.

export interface OwnerRule {
  pattern: string;
  owners: string[];
}

/** Turn one CODEOWNERS pattern into a matcher against a repo-relative path. */
function toRegExp(pattern: string): RegExp {
  let p = pattern.trim();
  // `foo/` and a bare `foo` both mean the directory and everything under it.
  const dirOnly = p.endsWith("/");
  if (dirOnly) p = p.slice(0, -1);
  const anchored = p.startsWith("/");
  if (anchored) p = p.slice(1);

  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === "*") {
      if (p[i + 1] === "*") {
        // `**/` swallows the slash too, so `**/x` matches a bare `x` at the root.
        if (p[i + 2] === "/") { re += "(?:.*/)?"; i += 2; } else { re += ".*"; i += 1; }
      } else {
        re += "[^/]*";
      }
      continue;
    }
    if (c === "?") { re += "[^/]"; continue; }
    re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // A pattern with no slash in it (other than a trailing one) matches at any depth —
  // `CHANGELOG.md` owns the one in every directory, which is gitignore's rule and
  // GitHub's.
  const floating = !anchored && !p.includes("/");
  const head = floating ? "(?:.*/)?" : "";
  // Everything under a directory match; a file pattern matches the file itself, and
  // also acts as a directory when something is under it.
  return new RegExp(`^${head}${re}(?:/.*)?$`);
}

/**
 * The owners of one path, or an empty list when nobody owns it.
 *
 * Compiled per call rather than cached: a CODEOWNERS file is tens of lines and a
 * review is tens of paths, so this is thousands of cheap regexes once, when a picker
 * opens — and a cache keyed by nothing is how a stale rule set outlives the branch
 * that changed it.
 */
export function ownersFor(rules: readonly OwnerRule[], path: string): string[] {
  let owners: string[] = [];
  for (const r of rules) {
    if (!r.pattern) continue;
    if (toRegExp(r.pattern).test(path)) owners = r.owners;
  }
  return owners;
}

export interface OwnerHit {
  /** `@login` or `@org/team`, exactly as the file writes it. */
  owner: string;
  /** Which of the paths asked about they own. */
  paths: string[];
}

/**
 * Who owns anything in this set of paths, most files first.
 *
 * Sorted by how much of the review each one owns, because that is the order somebody
 * picks a reviewer in — the person who owns eleven of the twelve changed files is the
 * answer, and the one who owns the shared lint config is not.
 */
export function ownersOf(rules: readonly OwnerRule[], paths: readonly string[]): OwnerHit[] {
  const by = new Map<string, string[]>();
  for (const p of paths) {
    for (const o of ownersFor(rules, p)) {
      const list = by.get(o) ?? [];
      list.push(p);
      by.set(o, list);
    }
  }
  return [...by.entries()]
    .map(([owner, list]) => ({ owner, paths: list }))
    .sort((a, b) => b.paths.length - a.paths.length || a.owner.localeCompare(b.owner));
}

/** `@octocat` → `octocat`, for matching against the login lists this app already
 *  has. A team (`@acme/backend`) has no login and answers null. */
export function loginOf(owner: string): string | null {
  const bare = owner.replace(/^@/, "");
  return bare.includes("/") || bare.includes("@") ? null : bare;
}
