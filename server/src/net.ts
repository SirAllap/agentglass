// Address classification for the origin/rebinding guards — pure and testable.
//
// The host is parsed as a real IP (not string-matched), so `10.evil.com` — a
// name anyone can register and point at 127.0.0.1 — is NOT treated as private:
// matching `/^10\./` against a hostname would turn "private network" into "any
// website", with a shell on the other end. A name is trusted only when it is
// literally localhost; everything else must *be* an address in a private range.
//
// `trustLan` gates the non-loopback private ranges. Off (the default) only
// loopback/localhost is trusted, so exposing the server to a LAN is a deliberate
// act — AGENTGLASS_TRUST_LAN=1 on top of a token — rather than something a
// browser on a colleague's machine gets for free.
import { isIP } from "node:net";

export function privateHost(hRaw: string, trustLan: boolean): boolean {
  const h = hRaw.replace(/^\[|\]$/g, ""); // a URL keeps IPv6 brackets
  if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".localhost")) return true;
  const v = isIP(h);
  if (v === 4) {
    const [a, b] = h.split(".").map(Number);
    if (a === 127) return true; // loopback is always local
    if (!trustLan) return false; // RFC1918 only when opted in
    // 100.64/10 is CGNAT, which is what Tailscale hands every node on a
    // tailnet. Without it the dashboard opened over Tailscale loads its HTML
    // and then 403s every single API call, because the page's own origin is
    // refused — a failure that looks exactly like a broken build. A tailnet
    // address is a stronger claim than an RFC1918 one, not a weaker one: it is
    // reachable only through an authenticated, encrypted mesh, whereas any
    // café can hand out 192.168.1.x. It rides the same opt-in flag regardless.
    if (a === 100 && b >= 64 && b <= 127) return true;
    return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
  }
  if (v === 6) {
    if (h === "::1") return true;
    return trustLan && /^f[cd]/i.test(h); // fc00::/7 unique-local
  }
  return false; // a name that isn't localhost resolves wherever its owner says
}

/**
 * Who the request is really from, once a reverse proxy is in the picture.
 *
 * WHY THIS EXISTS — the bug it was written for, so nobody deletes it as
 * over-engineering:
 *
 * `tailscale serve` terminates TLS in tailscaled and re-originates the request
 * to our port from 127.0.0.1. The socket peer is therefore loopback for every
 * client on the tailnet, and this server treats loopback as "the desk itself".
 * Measured against a real serve on this machine, with no credential at all:
 *
 *   https://<name>/health   -> 200
 *   https://<name>/ingest   -> 400   ** through the gate, into the handler **
 *   https://<name>/sessions -> 401
 *
 * A 400 is the schema complaining; the request had already been let in. The
 * LOCAL_SINKS exemption in auth.ts ("tokenless, but only from this machine")
 * was open to the whole tailnet. The same mistake blanked the device list —
 * noteClient/noteSocket drop loopback on purpose — so a phone that connected
 * through serve was invisible, and Block could not touch what it could not see.
 *
 * WHY NOT JUST READ X-Forwarded-For: because the obvious fix is a worse bug.
 * Anything that can reach the port can set that header, so "trust XFF" hands
 * every local process — and, on a non-loopback bind, everything on the LAN — a
 * free `X-Forwarded-For: 127.0.0.1` and the loopback exemption with it. The
 * rules below are shaped entirely around not doing that.
 */
export type PeerSource = "socket" | "proxy";

export interface Peer {
  /** The address to attribute this request to. Null only when the request was
   *  proxied and the proxy told us nothing usable — see `originOf`. */
  address: string | null;
  /** How we know. "socket" is the TCP peer; "proxy" means tailscaled spoke. */
  source: PeerSource;
}

/**
 * A Tailscale address: CGNAT 100.64/10, or the tailnet ULA fd7a:115c:a1e0::/48.
 *
 * Both halves are measured against a live tailnet, not guessed: a node answers
 * on both a 100.64/10 v4 address and an fd7a:115c:a1e0::/48 v6 one, and a
 * client that reaches `serve` over IPv6 arrives with the bare v6 address in
 * X-Forwarded-For — no brackets, no port, so it needs no unwrapping the v4
 * path does not need.
 */
export function tailnetAddress(hRaw: string): boolean {
  const h = hRaw.replace(/^\[|\]$/g, "").toLowerCase();
  const v = isIP(h);
  if (v === 4) {
    const [a, b] = h.split(".").map(Number);
    return a === 100 && b! >= 64 && b! <= 127;
  }
  if (v === 6) return h.startsWith("fd7a:115c:a1e0:");
  return false;
}

const isLoopbackAddr = (ipRaw: string): boolean => {
  const ip = ipRaw.startsWith("::ffff:") ? ipRaw.slice(7) : ipRaw;
  return ip === "::1" || ip.startsWith("127.");
};

/**
 * Resolve the real peer.
 *
 * `proxied` is the caller's answer to "did the local tailscaled hand us this
 * request", and it must be *verified*, not read off a header — see
 * `proxiedByTailscaled` in remote.ts, which checks the uid that owns the
 * connecting socket. This function is pure so the rules can be tested without
 * root, without Tailscale, and without a network.
 *
 * Three rules, in this order, and the order is the security property:
 *
 *  1. The socket peer is NOT loopback -> it is the peer, and every forwarding
 *     header is ignored outright. This is the rule that stops the LAN version
 *     of the attack: a machine on the wifi hitting a 0.0.0.0 bind cannot send
 *     `X-Forwarded-For: 127.0.0.1` and be promoted to local, because we never
 *     look at the header for it.
 *
 *  2. The socket peer IS loopback and nothing verified a proxy -> it is the
 *     peer. This is his hooks: `POST /ingest` over 127.0.0.1 with no token,
 *     which must keep working. A local process can forge headers here all it
 *     likes and change nothing, because we do not read them.
 *
 *  3. The socket peer is loopback AND tailscaled is verified to be the one
 *     connecting -> the request came off the tailnet, and it is NEVER treated
 *     as local again, whatever we can or cannot parse out of it. If the
 *     forwarded address is unreadable we return a null address rather than
 *     falling back to loopback. That fail-closed direction is not paranoia: it
 *     is the Funnel case. With Funnel on, X-Forwarded-For carries a *public
 *     internet* address, and a version of this that fell back to "well, the
 *     socket said 127.0.0.1" would hand the open internet the loopback
 *     exemption.
 */
export function resolvePeer(opts: {
  socketAddress: string | null | undefined;
  headers: { get(name: string): string | null };
  proxied: boolean;
}): Peer {
  const sock = opts.socketAddress || null;
  // Rules 1 and 2: unless a proxy was *verified*, the socket is the whole truth.
  if (!opts.proxied) return { address: sock, source: "socket" };
  if (sock && !isLoopbackAddr(sock)) return { address: sock, source: "socket" };
  return { address: forwardedFor(opts.headers), source: "proxy" };
}

/**
 * The single address tailscaled put in X-Forwarded-For, or null.
 *
 * Measured, because "first entry is authoritative" and "last entry is
 * authoritative" produce opposite code and only one of them can be right here:
 * tailscaled **replaces** the header, it does not append. Sending two forged
 * entries through a real serve —
 *
 *   -H 'X-Forwarded-For: 203.0.113.7' -H 'X-Forwarded-For: 198.51.100.9'
 *
 * — arrived at the backend as exactly one address, the caller's real tailnet
 * one. Both forgeries were gone; there was no list to pick an entry from.
 *
 * So the rule is neither first nor last: it is **exactly one address, or
 * nothing**. A comma means something other than tailscaled wrote this header,
 * and the safe reading of "I do not recognise who wrote this" is to discard it
 * and let rule 3 fail closed — not to pick an end of the list and hope.
 */
function forwardedFor(headers: { get(name: string): string | null }): string | null {
  const raw = headers.get("x-forwarded-for");
  if (!raw) return null;
  const v = raw.trim();
  if (!v || v.includes(",")) return null;
  const bare = v.replace(/^\[|\]$/g, "");
  return isIP(bare) ? bare : null;
}

/**
 * Loopback or not, for the auth gate.
 *
 * A proxied request is remote unconditionally — not "remote if the address
 * does not look local". The address on a proxied request is attacker-adjacent
 * data and this is the one line that decides whether the tokenless intake
 * sinks open, so it does not get to depend on parsing.
 */
export function originOf(peer: Peer): "loopback" | "remote" {
  if (peer.source === "proxy") return "remote";
  return peer.address && isLoopbackAddr(peer.address) ? "loopback" : "remote";
}
