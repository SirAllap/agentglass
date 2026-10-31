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

/**
 * Docker's human sizes back to bytes: `1.9GB`, `318MB`, `0B`, `1.317GB`.
 *
 * Its units are decimal (GB, not GiB) whatever the tool that prints them says,
 * so this uses 1000s. Being consistent with `docker system df` matters more
 * than being right about SI: the two numbers sit next to each other on screen.
 */
export function parseSize(text: string | null | undefined): number | null {
  const m = /^\s*([\d.]+)\s*([KMGTP]?i?)B?\s*$/i.exec(String(text ?? ""));
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] ?? "").toUpperCase().replace("I", "");
  const mult = { "": 1, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15 }[unit];
  return mult ? Math.round(n * mult) : null;
}
