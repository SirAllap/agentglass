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
  // The list is narrowed to the caller's own projects unless the server reads the key (index.ts
  // mayPublishReview); without it the person's window missed other projects' requests.
  "/settings/door", "/settings/requests", "/settings/requests/decide", "/launch-permissions", "/launch-flags", "/seat/settings", "/seat/change", "/seat/wake",
  "/hooks/gate", "/budgets/set", "/lantern/settings", "/agents/roles", "/plugins/master", "/plugins/enable", "/plugins/allow-unboxed",
  "/plugins/session-reads", "/jira/writes", "/clickup/writes", "/clickup/prefs",
  // A press of an account chip: only the person in the desktop window, never an agent staging it.
  "/usage/accounts/switch", "/usage/accounts/manage",
  // The person's own press of the keyring switch and of Clean up disk (mayPublishReview).
  "/keyring/toggle", "/keyring/rehydrate", "/machine/disk-clean/run", "/machine/disk-clean/explain", "/machine/disk-clean/explain/cancel", "/cleanup/run", "/cleanup/build-cache/prune", "/cleanup/undo-briefs",
  // The memory reserve asks for the person's password: the person's own press only (personMayPress).
  "/machine/memory-reserve",
  // Adoption is the person's click: the server takes the desk key as the only
  // proof that is not an Origin an agent's own CLI can write.
  "/seat/adopt",
  // The manifest's signOff answer, its verdicts and the start line are mayAnswerSettingsRequest, and on a
  // server the app started that is the desk key alone: without it the app's own read said sign-off was off.
  "/manifest", "/manifest/signoff", "/manifest/start",
  // Data & privacy and the Jira write switches, judged the same way.
  "/privacy/retention", "/privacy/erase-history", "/jira/write-kinds",
  // Flight plan: Go, No-go, Launch, a one-run cap and the author tab a new plan starts are the
  // person's (mayPublishReview). Without the key the window's Go was refused as an agent's.
  "/flight-plan/plans", "/flight-plan/plans/", "/flight-plan/runs/",
  // The person's merge lock: set, tick and "Unlock now" are the person's alone, like Go/No-go.
  "/prs/merge-lock", "/prs/merge-lock/tick", "/prs/merge-lock/unlock",
  // Merge, close and approving held workflows are the person's too (server/src/personOnlyPrRoutes.ts):
  // without the desk key the server reads the click as an agent's and refuses it.
  "/prs/merge", "/prs/close", "/prs/unstick-close", "/prs/approve-runs",
  // Hold is anyone's; Resume is the person's, and both come from the strip's one button.
  "/flight-plan/hold", "/flight-plan/resume",
  // A raise lasts until the day (or week) turns over, and raising the budget is the person's (mayPublishReview).
  "/flight-plan/budget/raise",
  // The project's agent rules: the person's own write applies at once and only the person answers a
  // waiting one (setRule/answer get mayPublishReview); without the key the person waited on themselves.
  "/agent-rules", "/agent-rules/",
  // Tracker accounts and the Jira writes that spend a stored account's token are the person's (mayPublishReview);
  // without the key the window's own press was read as an agent's.
  "/providers/workspaces", "/providers/default", "/providers/x", "/tracker/accounts", "/jira/activity", "/jira/connect",
  "/jira/sprint-move", "/jira/backlog-move", "/jira/bulk", "/jira/edit",
  // A project's flow is the person's, like the policy beside it (index.ts /flow), and so is its undo.
  "/flow", "/flow/",
];

export function deskGated(path: string): boolean {
  const p = path.split("?")[0]!;
  return DESK_GATED.some((g) => p === g || (g.endsWith("/") && p.startsWith(g)));
}
