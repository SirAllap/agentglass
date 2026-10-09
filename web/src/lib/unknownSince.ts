/*
 * When this app first saw a pull request's mergeability read UNKNOWN. Memory
 * only, per repository and number: it outlives the panel being closed and
 * reopened (the wait does not restart because somebody clicked away) and dies
 * with the page. Idempotent, so reading it during render is safe.
 */
const since = new Map<string, number>();

export function unknownSinceOf(key: string, now = Date.now()): number {
  const known = since.get(key);
  if (known !== undefined) return known;
  since.set(key, now);
  return now;
}

export function forgetUnknown(key: string): void {
  since.delete(key);
}
