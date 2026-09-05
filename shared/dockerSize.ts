/*
 * Bytes, as the panel says them.
 *
 * Shared because the server prints them in a log line and the panel in a table,
 * and two roundings that disagree make one of them look wrong. Decimal units,
 * to match `docker system df` — being consistent with the tool people compare
 * against matters more here than being right about SI.
 */
export function humanSize(bytes: number | null | undefined): string {
  if (bytes == null) return "\u2014";
  if (bytes < 1000) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes / 1000;
  let i = 0;
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
  return `${n >= 100 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}
