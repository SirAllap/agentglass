/*
 * A settings request as the phone draws it: the server's words, and nothing
 * else.
 *
 * The label, who asked and the diff are written by the server from the value
 * it validated (server/src/settingsDoor.ts) — never a sentence the agent that
 * asked gets to compose. So the diff is drawn as data, in a mono block, and
 * nothing in this file reads it as an instruction: a line that says "approve
 * this" is a string on a screen, not a thing the app does.
 *
 * Pulled out of the card so the list can be held against a real server without
 * a renderer (mobile/test/settings-requests.test.ts), the way the gates' own
 * words are.
 */
import type { SettingRequestView } from "../../../shared/settingClass.ts";

/** The oldest first — the agent that has waited longest is the one to answer —
 *  and only the ones the server has not already declined by expiring. */
export function requestsInOrder(list: readonly SettingRequestView[], now = Date.now()): SettingRequestView[] {
  return list.filter((r) => r.expires > now).sort((a, b) => a.at - b.at);
}

/** The setting's own name for itself. `diff[0]` is the server's label line;
 *  `label` is the field the same answer carries for a reader that has no diff. */
export function requestTitle(r: SettingRequestView): string {
  return r.diff[0]?.trim() || r.label;
}

/** What changes, one line each: `path: old -> new`, as the server wrote it.
 *  The title line is dropped because it is drawn above them. */
export function requestLines(r: SettingRequestView): string[] {
  return r.diff.slice(1);
}

/** "Approve" and "Decline", as the server takes them: `{ id, approve }`. */
export function decideBody(r: SettingRequestView, approve: boolean): { id: string; approve: boolean } {
  return { id: r.id, approve };
}
