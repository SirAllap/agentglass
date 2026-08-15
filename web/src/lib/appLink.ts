/*
 * Which mirrored notifications can be opened, when they carry no link.
 *
 * Clicking a Slack message in agentglass used to do nothing, while clicking the
 * desktop pop-up it was copied from opens Slack at that message. The reason is
 * structural: a notification's default action belongs to the app that posted it,
 * and a bus monitor cannot invoke one. What is left is the app's URI scheme.
 *
 * That opens the APP, not the message — so the button says so. "Open Slack" is
 * a promise this can keep; "Open the message" is not, and a button that lands
 * you somewhere other than where it said is worse than no button.
 *
 * The list is a copy of the server's, which is where the launching happens: the
 * client never says WHAT to open, only WHICH of our notifications, so this side
 * decides nothing but whether to draw the button.
 */

const APPS: Record<string, string> = {
  slack: "Slack",
  discord: "Discord",
  telegram: "Telegram",
  signal: "Signal",
  spotify: "Spotify",
};

/**
 * The app a note can be opened in, or null.
 *
 * Matched on the first WORD, not on a prefix: a desktop app names itself
 * variously — "Slack", "slack", "Slack Desktop" — but "slackish" is a different
 * app, and a prefix test happily launched Slack for it.
 */
export function appLinkFor(app: string | null | undefined): string | null {
  if (!app) return null;
  const first = app.trim().toLowerCase().split(/[\s\-_.]+/)[0] ?? "";
  return APPS[first] ?? null;
}
