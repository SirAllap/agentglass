import type { ControlCmd } from "../../shared/types.ts";
import { UI_ACTIONS, legacyToUi, parseUi, uiToLegacy, idOfLegacy, type UiActionId, type UiLevel } from "../../shared/uiActions.ts";

// The closed sets a /control body is checked against now live in
// shared/uiActions.ts, one entry per door, and this file only applies them. They
// used to be held here by hand (VIEW_IDS, OPEN_WHAT, CHAT_DO) and pinned by
// control.test.ts so a view added to the rail without being added here was
// noticed; the registry is imported by the window as well, so the two cannot
// disagree, and web/test/ui-registry-guard.test.ts pins the lists against the
// places the app itself enumerates (the rail, the Settings pages, the chords).
//
// The reason the set is closed at all is unchanged: a /control body is
// untrusted input broadcast to every window, and every field it can set must
// map to a closed set first. `understudy` and `browser` being on the view list
// is deliberate (a scorecard that acts on nothing; a view an agent driving the
// built-in browser needs mounted) and is explained where the list is kept.

/** The highest level of door this server will open. Level 1 is look-or-open;
 *  2 (change a local setting) and 3 (an effect outside the app) are not built,
 *  so an entry that claims them is refused rather than trusted. */
export const UI_MAX_LEVEL: UiLevel = 1;

/**
 * Validate an untrusted POST /control body into a ControlCmd, or null.
 *
 * The command rides the same socket every dashboard tab holds, so a malformed
 * or unknown cmd is turned away here rather than broadcast for each client to
 * second-guess. Nothing here executes — the worst a valid command does is open
 * a panel or repaint a theme — but a string that reached a setter unchecked
 * would still be a bug, so each field is matched against a closed set.
 */
export function parseControlCmd(body: unknown): ControlCmd | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  // The general door: an id and its args. Unknown ids are refused (deny by default).
  if (b.cmd === "ui") return parseUi(UI_ACTIONS, b.do, b.args, UI_MAX_LEVEL) as ControlCmd | null;
  // The older spellings are the same entries written the old way, and are
  // answered in the old shape so a client that predates `ui` still understands.
  const m = legacyToUi(b, UI_MAX_LEVEL);
  return m ? (uiToLegacy(m.id, m.args) as ControlCmd | null) : null;
}

/**
 * The registry id a validated command is an instance of, for the audit line.
 * Never the arguments: a path or a row is a value, and the log records that a
 * door was opened, not what was looked at.
 */
export function controlId(cmd: ControlCmd): UiActionId | null {
  return cmd.cmd === "ui" ? cmd.do : idOfLegacy(cmd as { cmd: string } & Record<string, unknown>);
}
