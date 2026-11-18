/*
 * The person's OK for one sensitive vault pull (login vault, decision D).
 *
 * Electron MAIN asks the person itself, with a native dialog (default Deny,
 * five minutes then Deny), and reports the yes here on the one channel the
 * window cannot speak on: the main key, the second line of the pipe main hands
 * the sidecar it spawns (desk.ts). Main never gives that key to a renderer, so
 * the window, a page in it or a plugin cannot send a yes. A desk key (the
 * window's) is not enough, and an agent never is.
 *
 * The server grants the pull only on main's report, and keeps the grant: when
 * the pull's answer comes back through the window and says sensitive, the
 * server checks it holds a grant for that lane and site. None: the lane is
 * closed and the pull refused (browserdrive.ts composeVaultPull).
 *
 * Nothing here ever holds a cookie value: only names, the agent, and times.
 */
import { timingSafeEqual } from "node:crypto";

/** How long the person has to answer main's dialog: then the answer is no. */
export const VAULT_ASK_MS = 5 * 60_000;
/** The header Electron main carries its own key in. */
export const MAIN_HEADER = "x-agentglass-main";
/** A grant is used by the pull it was asked for, right after the yes. */
const GRANT_MS = VAULT_ASK_MS + 60_000;

type Grant = { lane: string; site: string; agent: string; until: number };
const grants: Grant[] = [];

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * POST /vault/ok: main reports the person's yes for one pull. `key` is the
 * server's main key ("" where there is none: an adopted server refuses every
 * sensitive pull until the app restarts it).
 */
export function vaultOkDoor(
  h: { main: string; agent: boolean },
  body: { lane?: unknown; site?: unknown; agent?: unknown },
  key: string,
  now = Date.now(),
): { status: number; body: { ok: true } | { ok: false; error: string } } {
  if (h.agent || !key || !h.main || !same(h.main, key)) {
    return { status: 403, body: { ok: false, error: "only Electron main reports the person's OK for a sensitive pull; the window and agents cannot" } };
  }
  const { lane, site } = body;
  if (typeof lane !== "string" || !lane || typeof site !== "string" || !site) {
    return { status: 400, body: { ok: false, error: "the OK names one lane and one site" } };
  }
  for (let i = grants.length - 1; i >= 0; i--) if (grants[i]!.until < now) grants.splice(i, 1);
  grants.push({ lane, site, agent: typeof body.agent === "string" ? body.agent.slice(0, 64) : "", until: now + GRANT_MS });
  return { status: 200, body: { ok: true } };
}

/**
 * POST /vault/lane: main says it is about to set a vault login into one lane
 * (finding 3). Every pull goes through main, the window's own ones too, so
 * main reports each lane here BEFORE the first cookie, and the server guards
 * it (browserdrive.ts markVaultLane). Main's key only: the window must not
 * be able to mark, or unmark, a lane. `signOutAtEnd` is the vault's setting,
 * read by the helper.
 */
export function vaultLaneDoor(
  h: { main: string; agent: boolean },
  body: { lane?: unknown; signOutAtEnd?: unknown },
  key: string,
): { status: number; body: { ok: true; lane: string; signOutAtEnd?: boolean } | { ok: false; error: string } } {
  if (h.agent || !key || !h.main || !same(h.main, key)) {
    return { status: 403, body: { ok: false, error: "only Electron main reports a lane it signs in from the vault" } };
  }
  const { lane } = body;
  if (typeof lane !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(lane)) return { status: 400, body: { ok: false, error: "name one lane" } };
  return { status: 200, body: { ok: true, lane, ...(typeof body.signOutAtEnd === "boolean" ? { signOutAtEnd: body.signOutAtEnd } : {}) } };
}

/** The pull's answer said sensitive: is there main's grant for it? Used up either way. */
export function takeVaultGrant(lane: string, site: string, now = Date.now()): boolean {
  const i = grants.findIndex((g) => g.lane === lane && g.site === site && g.until >= now);
  if (i < 0) return false;
  grants.splice(i, 1);
  return true;
}

/** Tests only. */
export function resetVaultAsks(): void { grants.length = 0; }
