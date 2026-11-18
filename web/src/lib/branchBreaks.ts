/**
 * Where a long branch name may break. A name like
 * `orbit-1042-reports-section-on-the-security-groups-page` has no spaces, so
 * left alone it either overflows or is cut mid-word. Breaking only after a
 * separator keeps every piece readable; `overflow-wrap: anywhere` stays on the
 * element as the last resort for a single piece longer than the line (a hash).
 * The separator stays on the piece it ends, so copying the rendered text
 * (<wbr> adds no character) gives the exact name back.
 */
export function branchSegments(name: string): string[] {
  return name.match(/[^-/_.]*[-/_.]*/g)?.filter(Boolean) ?? [];
}
