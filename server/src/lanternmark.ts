/**
 * The first words of the Lantern's own prompt — the one mark that needs no
 * plumbing. A session whose first prompt starts like this is the Lantern's
 * chat whatever environment it was launched with, however it was reopened,
 * after any restart; a pane whose command line carries it is that chat and
 * is not photographed for a restore. A leaf module: tmuxrestore.ts reads it
 * and must not pull the board's dependencies in for one string.
 */
export const LANTERN_PROMPT_MARK = "You are the Lantern for this machine";
