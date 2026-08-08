// Whether a link in a comment is one of THIS pull request's commits.
//
// It lives in its own file for two reasons. It decides whether to swallow a
// click, so it is exactly the kind of rule that wants a test per case; and
// importing it from `PrPanel.tsx` pulls the whole panel — and through it the
// API module, which reads `location` and cannot be loaded outside a browser.
//
// The audit that produced this file found the earlier version matching
// `/commits/<hex>` anywhere in any URL, so a link to somebody's CI —
// `https://ci.example.com/builds/commits/8c362cc` — stopped navigating and
// silently switched to the Commits tab whenever that hex happened to prefix one
// of our own commits. Misdirection rather than execution, but the fix is the
// same: read the host and the repository, not a substring.

/** Escapes a repository name for use inside a RegExp. `owner/name` has a dot in
 *  it often enough (`acme/shop.io`) that this is not theoretical. */
const quote = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The sha out of a GitHub commit link for `repo`, or null.
 *
 * Both shapes GitHub writes: `/owner/name/commit/<sha>` on the repository, and
 * `/owner/name/pull/N/commits/<sha>` from a review body.
 *
 * With no repository there is nothing to compare against and the answer is
 * null — a caller that does not know which repository it is looking at has no
 * business claiming a link belongs to it.
 */
export function shaFromHref(href: string, repo: string | undefined): string | null {
  if (!repo) return null;
  let u: URL;
  // A relative href resolves against github.com, which is what a bare
  // `/owner/name/commit/…` in a comment body means.
  try { u = new URL(href, "https://github.com"); } catch { return null; }
  if (u.hostname !== "github.com" && u.hostname !== "www.github.com") return null;
  const m = new RegExp(`^/${quote(repo)}/(?:commit|pull/\\d+/commits)/([0-9a-f]{7,40})/?$`, "i")
    .exec(u.pathname);
  return m ? m[1]!.toLowerCase() : null;
}
