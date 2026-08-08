/**
 * A path a person can read, shortened at the front.
 *
 * `dir="rtl"` was the first attempt and it is wrong: it truncates from the left
 * as intended and it also MOVES the leading slash to the other end, so
 * `/home/you/code/app` was drawn as `home/you/code/app/`. A path that is not
 * the path is worse than a truncated one.
 *
 * So the home directory is folded to `~` — the part everything shares and
 * nobody needs to read — and what is left is the part that tells two checkouts
 * apart.
 */
export const shortPath = (p: string): string =>
  p.replace(/^\/(?:home|Users)\/[^/]+/, "~");
