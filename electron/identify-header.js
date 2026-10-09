// S9: an honest "an agent is driving this" header, and only to a dev origin.
//
// Its own file, next to guest-guard.js, for the same reason that one is: the
// decision is small and pure, and a test can require() it without pulling in
// main.js — see guest-guard.js's header comment for why that file cannot be
// imported at all. CommonJS with no build step, because main.js requires it.
//
// Which origins: loopback plus the two TLDs nothing
// on the public internet resolves — never a substring match on "localhost",
// which is exactly how `evil-localhost.com` and `localhost.evil.com` would
// have gotten a header meant for a machine's own dev server. RFC1918 LAN
// hosts are deliberately left out: a name on the LAN is somebody else's
// server, not this machine's, and an explicit per-profile list is
// deferred until somebody asks for one.

/** @param {string} host */
function isLoopbackV4(host) {
  const m = /^127(?:\.\d{1,3}){3}$/.exec(host);
  if (!m) return false;
  return host.split(".").every((n) => Number(n) <= 255);
}

/**
 * Whether URL points at a dev origin worth naming the agent to — never at
 * whether the request is safe to send; the egress guard and the proxy still
 * decide that.
 * @param {string} url */
function shouldIdentify(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "[::1]" || host === "::1") return true;
  if (host === "test" || host.endsWith(".test")) return true;
  return isLoopbackV4(host);
}

/** The header this feature sends, and the value it is allowed to carry: a
 *  slug, nothing that could inject a second header or a control character —
 *  Chromium would refuse a raw CRLF, but the caller of `ag:browserSessionSettings`
 *  is a renderer this process must not trust either way. */
const IDENTIFY_HEADER = "X-Agentglass-Agent";
const AGENT_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** @param {unknown} name */
function sanitizeAgentName(name) {
  return typeof name === "string" && AGENT_NAME_RE.test(name) ? name : null;
}

/**
 * Who a guest's requests are attributed to once `event` has happened — the one
 * decision about the name, so that nothing else has to remember to clear it.
 *
 * The name is a claim by whoever drove the guest LAST, not a property of the
 * tab. Measured on a tab an agent had driven with `--as orbit-bot`: a later
 * `--shared` ask (which sends no `as`) and the person typing an address both
 * left `orbit-bot` in the map, so the next page's requests to a dev server
 * named an agent that was not there. Only an ask that names itself keeps or
 * sets a name; anything else — an ask with no `as`, an empty or malformed one,
 * the person acting on the tab — takes it away. A guest that is destroyed is
 * dropped by the book below, not by an event.
 *
 * @param {string | null | undefined} current
 * @param {{ kind: "ask", as?: unknown } | { kind: "person" }} event
 * @returns {string | null} */
function ownerAfter(current, event) {
  if (event && event.kind === "ask") return sanitizeAgentName(event.as);
  return null;
}

/** The names by guest id, with `ownerAfter` the only way in. A plain object
 *  a test can build; `main.js` holds one. */
function createOwnerBook() {
  /** @type {Map<number, string>} */
  const names = new Map();
  return {
    /** @param {number} guestId @param {Parameters<typeof ownerAfter>[1]} event */
    apply(guestId, event) {
      const next = ownerAfter(names.get(guestId), event);
      if (next) names.set(guestId, next); else names.delete(guestId);
    },
    /** @param {number} guestId */
    get: (guestId) => names.get(guestId),
    /** @param {number} guestId */
    drop: (guestId) => { names.delete(guestId); },
  };
}

module.exports = { IDENTIFY_HEADER, shouldIdentify, sanitizeAgentName, ownerAfter, createOwnerBook };
