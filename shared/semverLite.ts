/*
 * Dotted-number versions, the only kind the CLIs and plugin manifests here
 * speak: "0.21.4", "2.1.296". No pre-release tags, no ranges.
 *
 * A comparison, not a parser of a CLI's banner: "Hermes Agent v0.21.5
 * (2026.9.21)" goes through the engine's own `version.pattern` first
 * (`extractVersion`), which is what keeps the date in the parentheses from
 * being compared as a fourth component. The ceiling is three components; a
 * fourth is ignored.
 */

/** `have` is at least `want`, by major, minor, patch. A part that is not a
 *  number counts as 0, so a malformed `have` never passes a real minimum. */
export function versionAtLeast(have: string, want: string): boolean {
  const parts = (v: string) => v.trim().split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [h, w] = [parts(have), parts(want)];
  for (let i = 0; i < 3; i++) {
    if ((h[i] ?? 0) !== (w[i] ?? 0)) return (h[i] ?? 0) > (w[i] ?? 0);
  }
  return true;
}

/** The version a CLI printed: the first capture group of its facet's pattern,
 *  or null when the line is not that CLI's banner (or the pattern is not a
 *  regex, which a table test catches before a person does). */
export function extractVersion(output: string, pattern: string): string | null {
  try {
    return new RegExp(pattern, "m").exec(output)?.[1] ?? null;
  } catch {
    return null;
  }
}
