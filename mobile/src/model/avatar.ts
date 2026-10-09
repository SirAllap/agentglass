/*
 * Where a face comes from, decided apart from the component that draws it.
 *
 * A person on GitHub has a picture at a fixed address, and the phone may not
 * fetch it directly: images go through the computer's allowlisted proxy, the
 * same one a pull request's own pictures use. Two rules keep that from costing
 * anything. The address for a login is ONE string, so the image cache treats
 * every face of the same person on the screen as a single request, and the
 * proxy tells the phone to keep it for ten minutes. A picture that failed is
 * remembered for as long, so scrolling a conversation back and forth does not
 * ask a dead address again each time a row mounts.
 */
import type { Host } from "../lib/host.ts";

/** The four sizes a face is drawn at, each for one job: a stack on a list row,
 *  a row in a field or a reply, the rail of a conversation, a people sheet. */
export const AVATAR = { stack: 24, field: 28, rail: 34, sheet: 44 } as const;

/** GitHub's automation accounts carry a `[bot]` suffix, and their address is
 *  somebody else's: `orbit-ci` without it is a different account. They get a
 *  glyph, not a picture. */
export const isBotLogin = (login: string): boolean => /\[bot\]$/i.test(login);

export interface FaceSource {
  uri: string;
  headers: { authorization: string };
}

/** The proxy address for a login's picture, or null when there is none to ask
 *  for: no computer, no login, or an automation account. */
export function githubFace(host: Pick<Host, "origin" | "token"> | null, login: string | undefined): FaceSource | null {
  const name = (login ?? "").trim();
  if (!host || !name || isBotLogin(name)) return null;
  const raw = `https://avatars.githubusercontent.com/${encodeURIComponent(name)}?size=96`;
  return {
    uri: `${host.origin}/prs/asset?url=${encodeURIComponent(raw)}`,
    headers: { authorization: `Bearer ${host.token}` },
  };
}

/** The hue of a person's tinted disc: the same name is the same colour on every
 *  screen, and two neighbours are usually two colours. */
export function hueOf(name: string): number {
  let h = 0;
  for (const ch of name.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

const DEAD_FOR_MS = 10 * 60_000;
const dead = new Map<string, number>();

/** Remember that this address did not load. */
export function markDead(uri: string, now = Date.now()): void {
  dead.set(uri, now + DEAD_FOR_MS);
}

/** Whether to skip asking for this address and draw the initials straight away. */
export function isDead(uri: string, now = Date.now()): boolean {
  const until = dead.get(uri);
  if (until === undefined) return false;
  if (now >= until) { dead.delete(uri); return false; }
  return true;
}
