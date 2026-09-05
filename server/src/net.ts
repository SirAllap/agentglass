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
import { lookup } from "node:dns/promises";

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

/*
 * ---------------------------------------------------------------------------
 * Outbound: what this server may be talked into fetching.
 *
 * Two routes take a URL from outside and fetch it with this process's network
 * position — `/plugins/catalogue?url=` and `/clickup/file`, whose address is
 * whatever the tracker returned for an attachment. Both checked the scheme and
 * neither checked the HOST, and both followed redirects blind. With
 * `redirect: "follow"` the FIRST server chooses the second URL, so an https
 * catalogue whose answer is a 302 to `http://127.0.0.1:<port>/…` is fetched by
 * this server against itself — and the same shape reaches a router's admin
 * page or a cloud metadata address from any machine that can see them. The
 * test drives exactly that hop through a fake fetch and asserts it is never
 * made.
 *
 * `privateHost` above answers the inbound question ("may this caller be
 * trusted as local?") and its `trustLan` switch widens trust. The outbound
 * question is the opposite one, so it gets its own function with no switch:
 * anything private, link-local, unspecified, or a name that resolves there,
 * is refused, and LAN trust never opens it.
 * ---------------------------------------------------------------------------
 */

/**
 * A literal host this server must not fetch from, judged without a resolver:
 * loopback, RFC1918, CGNAT, unique-local, link-local (169.254/16 is where cloud
 * metadata lives, fe80::/10 the IPv6 twin), the unspecified address, and the
 * IPv4-mapped IPv6 spellings of all of them. A hostname is not judged here —
 * `10.evil.example` is a name, not an address — so a name is resolved by
 * `unfetchableHost` below and every answer judged by this.
 */
export function privateAddress(hRaw: string): boolean {
  let h = hRaw.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) h = mapped[1]!;
  const v = isIP(h);
  if (v === 4) {
    const [a, b] = h.split(".").map(Number) as [number, number];
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (v === 6) {
    if (h === "::" || h === "::1") return true;
    if (/^f[cd]/.test(h)) return true;      // fc00::/7 unique-local
    if (/^fe[89ab]/.test(h)) return true;   // fe80::/10 link-local
    return false;
  }
  return false;
}

/**
 * Why a host may not be fetched, or null.
 *
 * A literal address is judged as it is. A name is resolved — every address,
 * not the first — and refused if ANY answer is private: a name with one public
 * and one private record is a name whose owner wants the private one used. A
 * name that does not resolve is refused too, since a fetch of it would fail
 * anyway and the refusal says why. Resolution is a real DNS round trip, so
 * this is async and the caller pays it once per hop, not per byte.
 */
export async function unfetchableHost(hRaw: string): Promise<string | null> {
  const h = hRaw.replace(/^\[|\]$/g, "");
  if (!h) return "no host";
  if (privateAddress(h)) return `${h} is a private or local address`;
  if (isIP(h)) return null;
  try {
    const answers = await lookup(h, { all: true, verbatim: true });
    if (!answers.length) return `${h} does not resolve`;
    for (const a of answers) if (privateAddress(a.address)) return `${h} resolves to ${a.address}, a private or local address`;
    return null;
  } catch {
    return `${h} does not resolve`;
  }
}

/**
 * An `allow` for guardedFetch that admits https on the named domains and their
 * subdomains, and nothing else. The `.` in the suffix test is the whole rule:
 * a bare `endsWith("clickup.com")` also admits `notclickup.com`, which is
 * somebody else's host — the same trap clickup.ts:parseViewUrl documents.
 */
export function hostsOnly(domains: string[]): (u: URL) => string | null {
  const roots = domains.map((d) => d.toLowerCase());
  return (u: URL) => {
    if (u.protocol !== "https:") return "fetched over https only";
    const h = u.hostname.toLowerCase();
    return roots.some((d) => h === d || h.endsWith(`.${d}`)) ? null : `${h} is not a host this may fetch from`;
  };
}

export interface GuardedFetch {
  /** The final response, when every hop passed. */
  res?: Response;
  /** Why it stopped, when one did not. */
  error?: string;
}

/**
 * `fetch` that checks every hop rather than trusting the first.
 *
 * `redirect: "follow"` hands the decision about the second URL to the first
 * server, which is the whole of the blind-SSRF shape. So redirects are manual:
 * each `Location` is resolved against the current URL, run through the same
 * `allow` the caller applied to the original (scheme, host allowlist) and
 * through `unfetchableHost`, and only then fetched. Five hops is more than any
 * legitimate download chain uses and few enough to stop a loop.
 *
 * `fetchImpl` and `hostCheck` exist for the test: a fetch that answers a 302 to
 * a private address without a network, and a host check that judges literals
 * without a resolver, let the test prove the second hop is never made without
 * depending on what this machine's DNS says about an invented name.
 */
export interface GuardedFetchOptions {
  maxHops?: number;
  fetchImpl?: typeof fetch;
  hostCheck?: (host: string) => Promise<string | null>;
}

export async function guardedFetch(
  urlIn: string,
  init: RequestInit,
  allow: (u: URL) => string | null,
  opts: GuardedFetchOptions = {},
): Promise<GuardedFetch> {
  const maxHops = opts.maxHops ?? 5;
  const doFetch = opts.fetchImpl ?? fetch;
  const hostCheck = opts.hostCheck ?? unfetchableHost;
  let url: URL;
  try { url = new URL(urlIn); } catch { return { error: "not a URL" }; }
  for (let hop = 0; hop <= maxHops; hop++) {
    const bad = allow(url) ?? await hostCheck(url.hostname);
    if (bad) return { error: hop === 0 ? bad : `redirected to ${url.host}: ${bad}` };
    const res = await doFetch(url.toString(), { ...init, redirect: "manual" });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      if (hop === maxHops) return { error: "too many redirects" };
      try { url = new URL(res.headers.get("location")!, url); } catch { return { error: "redirected to something that is not a URL" }; }
      continue;
    }
    return { res };
  }
  return { error: "too many redirects" };
}
