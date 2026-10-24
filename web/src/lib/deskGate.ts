// The routes that only the desktop app may call, for a person: the server asks for the
// app's own key on each (index.ts: `deskHeld() && deskKeyOk(req)`). A request without it is refused
// with a sentence that says "only the desktop app", whoever is asking.

/** Routes that take the desk key. A prefix ends in a slash or is a whole path. */
export const DESK_GATED: readonly string[] = [
  "/finder/bookmarks", "/finder/remotes/", "/finder/devices/", "/finder/actions/", "/finder/openwith/launch", "/fs/op",
  // Posting a local review to GitHub is the person's click (mayPublishReview
  // asks for the key whenever the app holds one); without the header here the
  // window's own press was refused as if an agent had made it.
  "/plugins/pr-notes/publish-preview", "/plugins/pr-notes/publish",
  // The settings an agent's change waits on the person for: the person's own save
  // and answer carry the key, so the server does not read them as an agent's
  // (index.ts mayPublishReview, the settings door).
  "/settings/door", "/settings/requests/decide", "/launch-permissions", "/seat/settings", "/seat/change", "/seat/wake",
  "/hooks/gate", "/budgets/set", "/lantern/settings", "/agents/roles", "/plugins/master", "/plugins/enable", "/plugins/allow-unboxed",
  "/plugins/session-reads", "/jira/writes", "/clickup/writes", "/clickup/prefs",
  // A press of an account chip: only the person in the desktop window, never an agent staging it.
  "/usage/accounts/switch", "/usage/accounts/manage",
  // The person's own press of the keyring switch and of Clean up disk (mayPublishReview).
  "/keyring/toggle", "/keyring/rehydrate", "/machine/disk-clean/run",
];

export function deskGated(path: string): boolean {
  const p = path.split("?")[0]!;
  return DESK_GATED.some((g) => p === g || (g.endsWith("/") && p.startsWith(g)));
}
