/**
 * Showing the release notes once, after the app has updated itself.
 *
 * The update button restarts the app into a new build and says nothing about
 * what changed — you are left to go and read the release page, which nobody
 * does. The notes exist (the tag annotation is what the GitHub release is made
 * from), so the app can simply show them the first time it runs a version it
 * has not run before.
 *
 * Kept out of the component so the one rule with any judgement in it — when NOT
 * to interrupt — is testable without rendering anything.
 */

const SEEN_KEY = "agentglass_seen_release";

function read(): string {
  try { return localStorage.getItem(SEEN_KEY) || ""; } catch { return ""; }
}

/** Remember a version as seen, whether or not its notes were shown. */
export function markSeen(tag: string): void {
  try { localStorage.setItem(SEEN_KEY, tag); } catch { /* private mode */ }
}

/**
 * Announce this version, or quietly record it?
 *
 * `null` means record and stay silent. That covers the two cases where a modal
 * would be an intrusion rather than news:
 *
 *  - **Nothing seen before.** A fresh install, or the first run after this
 *    feature shipped. Neither of those is "what changed since last time", and
 *    greeting someone with release notes for a version they just chose to
 *    install is noise. The feature starts working from the next release.
 *  - **A downgrade, or the same version again.** Rolling back is deliberate,
 *    and being told what is new in the build you just left is nonsense.
 */
export function releaseToAnnounce(tag: string, seen = read()): string | null {
  if (!tag) return null;
  if (!seen) { markSeen(tag); return null; }
  if (rank(tag) <= rank(seen)) { markSeen(tag); return null; }
  return tag;
}

/** Compare v-prefixed release tags numerically. String order gets v0.10.0 wrong
 *  against v0.9.0, which is the one comparison that has to survive a year. */
function rank(tag: string): number {
  return (tag.match(/\d+/g) ?? []).map(Number).reduce((n, part) => n * 1000 + part, 0);
}
