/*
 * Where tapping an alert goes.
 *
 * The notification's `data` comes back from the OS on a tap, and nothing on
 * this side proves the app wrote it, so it is read as untrusted: the only
 * outcomes are the Terminal tab, with or without a tmux pane to select. A
 * value is never handed to the router as a path, only as a pane id that has
 * passed the one shape tmux hands out.
 *
 * An agent's alert carries a pane or nothing (see AlertNote), so it lands on
 * the Terminal. A watch alert (`kind: "watch"`, watchAlerts.ts) names a pull
 * request or a card instead, and lands on that screen; one that names a pull
 * request without a usable checkout lands on the pull-request list, where the
 * person can find it. Jira cards have no phone screen, so they never get here.
 */

export type AlertRoute =
  | {
      pathname: "/terminal";
      /** `host` is the computer the pane is on, when the alert said; the terminal
       *  takes the pane only from that computer's own window list. */
      params?: { pane: string; host?: string };
    }
  | { pathname: "/pr/[number]"; params: { number: string; root: string } }
  | { pathname: "/card/[id]"; params: { id: string } }
  | { pathname: "/prs" };

/** tmux pane ids are `%` and digits. Anything else is not one. */
const PANE = /^%\d{1,9}$/;

/** The computer an alert came from, when its data names one in the shape an id
 *  has. Anything else is ignored rather than switched to: the data comes back
 *  from the OS, and an id is only ever looked up in the phone's own list. */
export function alertHost(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const id = (data as Record<string, unknown>).hostId;
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
}

/** A pull request number: a whole number a repository could have. */
export const validPrNumber = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0 && n <= 9_999_999;

/** A card id in the shapes a tracker hands out (`86abc12`, `ORBIT-1042`). */
export const validCardId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id);

/** A checkout path as the computer reports it: absolute, one line, no `..`.
 *  The computer checks it against its own repositories again; this keeps junk
 *  out of a route. */
export const validRoot = (r: unknown): r is string =>
  typeof r === "string" && r.length <= 1024 && /^(\/|[A-Za-z]:[\\/])[^\0-\x1f]*$/.test(r) && !/(^|[\\/])\.\.([\\/]|$)/.test(r);

/** `owner/name`, as GitHub spells a repository. */
export const validRepo = (r: unknown): r is string => typeof r === "string" && /^[\w.-]{1,100}\/[\w.-]{1,100}$/.test(r);

/** A server alert id (a UUID), the only thing sent back to the computer on a tap. */
export const validAlertId = (id: unknown): id is string =>
  typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

function watchRoute(d: Record<string, unknown>): AlertRoute | null {
  if (d.summary === true) return { pathname: "/prs" };
  if (validCardId(d.card)) return { pathname: "/card/[id]", params: { id: d.card } };
  if (validPrNumber(d.pr)) {
    return validRoot(d.root)
      ? { pathname: "/pr/[number]", params: { number: String(d.pr), root: d.root } }
      : { pathname: "/prs" };
  }
  return null;
}

export function alertRoute(data: unknown): AlertRoute | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d.kind === "watch") return watchRoute(d);
  if (d.kind !== "alert") return null;
  if (typeof d.pane === "string" && PANE.test(d.pane)) {
    const host = alertHost(data);
    return { pathname: "/terminal", params: host ? { pane: d.pane, host } : { pane: d.pane } };
  }
  return { pathname: "/terminal" };
}
