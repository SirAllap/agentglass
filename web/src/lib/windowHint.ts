/**
 * Tooltip for a time-window chip that reaches back past retention.
 *
 * It used to send the person to "Statistics (s)", a view that no longer
 * exists. The one export that still outlives retention is the daily totals
 * CSV in Settings, so the hint points there.
 */
export function windowBeyondHint(w: { ms: number }, retentionDays: number | undefined): string | undefined {
  if (!retentionDays || w.ms <= retentionDays * 86_400_000) return undefined;
  return `Events are kept for ${retentionDays} days, so this window is answered from the last ${retentionDays}d. Settings → Take your data out → “Daily totals — CSV” goes further back.`;
}
