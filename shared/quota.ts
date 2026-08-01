/**
 * Naming a rate-limit window by its length.
 *
 * Codex's `primary`/`secondary` are positional, not semantic — which of them is
 * the short window depends on the plan, and on a weekly-only plan `primary` IS
 * the weekly one. So the length names the window and the key never does.
 */
export function windowLabel(minutes: number): string {
  if (minutes === 300) return "5h";
  if (minutes === 10080) return "weekly";
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}
