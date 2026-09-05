/*
 * The words a volume row uses.
 *
 * Small on purpose, and separate from the component for the same reason as the
 * rest of this view's helpers: "3 days ago" is a sentence about somebody's
 * machine, and a wrong one — an epoch parsed as a string, a future date read as
 * "in -2 days" — is the kind of thing that gets noticed and not reported.
 */
export { humanSize } from "../../../shared/dockerSize.ts";

/**
 * How long ago, in words, from an ISO timestamp.
 *
 * Coarse by design: nobody needs "3 days, 4 hours" to decide whether a bundle
 * is theirs. Anything unparseable comes back empty rather than as "NaN days
 * ago", which is the failure this exists to make impossible.
 */
export function sinceLabel(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.round((now - t) / 1000);
  // A clock that is behind the container's is not worth a paragraph; it reads
  // as "just now" rather than as a negative number.
  if (s < 90) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d < 14 ? `${d}d ago` : `${Math.round(d / 7)}w ago`;
}
