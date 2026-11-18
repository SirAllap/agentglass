/**
 * Which of the detail's tabs are drawn in the strip and which go behind "More".
 * A tab is whole or it is not drawn: text is never clipped or covered. The open
 * tab always stays in the strip so the person can see where they are.
 */
export function fitTabs(widths: readonly number[], avail: number, active: number, moreW: number): number[] {
  const all = widths.map((_, i) => i);
  if (widths.reduce((a, b) => a + b, 0) <= avail) return all;
  let room = avail - moreW;
  const keep = new Set<number>();
  if (active >= 0 && active < widths.length) { keep.add(active); room -= widths[active] ?? 0; }
  for (const i of all) {
    if (keep.has(i)) continue;
    const w = widths[i] ?? 0;
    if (w > room) break;
    keep.add(i); room -= w;
  }
  return all.filter((i) => keep.has(i));
}
