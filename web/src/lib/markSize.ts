/**
 * Whether a mark can be read at the 12px a segment label is: a square-ish icon can; a wide pixel
 * logotype (Omarchy's is 4.3 times wider than tall) is 50px of blocks at that height and reads as
 * noise, so the segment says the name instead.
 */
export function markReadsAtLabelSize(svg: string): boolean {
  const vb = svg.match(/viewBox="([0-9.\s-]+)"/)?.[1]?.trim().split(/\s+/).map(Number);
  return !!vb && vb.length === 4 && vb[3]! > 0 && vb[2]! / vb[3]! <= 2.5;
}
