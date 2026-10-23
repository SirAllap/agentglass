// The finder's routes that only the desktop app may call, for a person: the server asks for the
// app's own key on each (index.ts: `deskHeld() && deskKeyOk(req)`). A request without it is refused
// with a sentence that says "only the desktop app", whoever is asking.

/** Routes that take the desk key. A prefix ends in a slash or is a whole path. */
export const DESK_GATED: readonly string[] = ["/finder/bookmarks"];

export function deskGated(path: string): boolean {
  const p = path.split("?")[0]!;
  return DESK_GATED.some((g) => p === g || (g.endsWith("/") && p.startsWith(g)));
}
