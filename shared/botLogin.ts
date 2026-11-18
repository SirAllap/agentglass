// The ONE answer to "is this login a bot". The server marks review and comment
// authors with it, the board's review facets read through it, and a second copy
// is how a bot ends up counted as a person on one screen and not on another.

/*
 * `github-advanced-security` is here because it was MEASURED, not guessed.
 *
 * GitHub's own code scanning reviews a pull request as a plain login with no
 * `[bot]` suffix — checked against this repository, where three of the five most
 * recently discussed pull requests have exactly one "review" on them and it is
 * that. Every one of them would have counted as a person: an unread badge on the
 * board, a notification, and a name in the Humans filter, for an alert that is
 * already a check.
 */
const BOT_RE = /\[bot\]$|^(github-actions|dependabot|codecov|sonarcloud|claude|github-advanced-security)$/i;
export const isBotLogin = (login: string): boolean => BOT_RE.test(login || "");
