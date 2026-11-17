/*
 * An image tag template with `{slug}` and/or `{sha}`, read the one way everywhere: the cleanup of a merged PR, the orphan
 * sweep (server) and the Images badge (web) all call this, so the three can never disagree about what "built at a commit" is.
 *
 * A template with `{sha}` becomes an anchored regex: `{slug}` is a lazy run of non-colon characters, `{sha}` is 7 to 40 hex
 * characters, every other character is literal. A template with only `{slug}` is NOT handled here: it keeps the older "tag
 * contains the slug" match in cleanup.ts. Measured on a real project: its build tags with `git rev-parse --short HEAD`, which
 * prints 7 to 11 characters depending on the repository, so a fixed length would miss or over-match.
 */

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export type TagTemplateCheck = { ok: true } | { ok: false; error: string };

/** A template holds `{slug}`, `{sha}` or both, each at most once. */
export function checkTagTemplate(t: string): TagTemplateCheck {
  const slugs = t.split("{slug}").length - 1, shas = t.split("{sha}").length - 1;
  if (!slugs && !shas) return { ok: false, error: "must contain {slug} or {sha}" };
  if (slugs > 1 || shas > 1) return { ok: false, error: "{slug} and {sha} may each appear once" };
  return { ok: true };
}

export const templateHasSha = (t: string): boolean => t.includes("{sha}");

export interface TagParts { slug?: string; sha?: string }

/** The template as an anchored, case-insensitive regex; null when it is invalid. The cleanup of a PR uses it only for a template with `{sha}`; the sweep also for `{slug}` alone. */
export function tagTemplateRegex(t: string): RegExp | null {
  if (!checkTagTemplate(t).ok) return null;
  const src = t.split(/(\{slug\}|\{sha\})/).map((p) => (p === "{slug}" ? "(?<slug>[^:]+?)" : p === "{sha}" ? "(?<sha>[0-9a-f]{7,40})" : escapeRe(p))).join("");
  return new RegExp(`^${src}$`, "i");
}

/** What a `repo:tag` ref captures under the template, or null when it does not match. */
export function matchTagTemplate(t: string, ref: string): TagParts | null {
  const m = tagTemplateRegex(t)?.exec(ref);
  if (!m) return null;
  const g = m.groups ?? {};
  return { ...(g.slug ? { slug: g.slug } : {}), ...(g.sha ? { sha: g.sha.toLowerCase() } : {}) };
}

/** One rule for candidates and for the keep check: `t` is 7 to 40 hex and the full commit sha starts with it. */
export function shaMatches(t: string, full: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(t) && /^[0-9a-f]{40}$/i.test(full) && full.toLowerCase().startsWith(t.toLowerCase());
}

/** Whether `t` names any of the commits. */
export const shaInAny = (t: string, commits: readonly string[]): boolean => commits.some((c) => shaMatches(t, c));

/** The slug as a tag spells it: lowercase, every run of non-alphanumerics one dash (what build scripts derive). */
export const slugForTag = (v: string): string => v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/**
 * The Images view's decision, pure: the refs this template matches whose sha is no live HEAD. The badge is about the
 * commit, so a `{slug}` part does not change it.
 */
export function oldCommitRefs(t: string, refs: readonly string[], liveHeads: readonly string[]): string[] {
  return refs.filter((r) => {
    const p = matchTagTemplate(t, r);
    return !!p?.sha && !shaInAny(p.sha, liveHeads);
  });
}
