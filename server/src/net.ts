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
import tls from "node:tls";

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

/** The IPv4 address a v6 address carries in its low 32 bits, when it is one of
 *  the wrappers that means "that v4 host": IPv4-mapped (`::ffff:0:0/96`), the
 *  deprecated IPv4-compatible (`::/96`), NAT64 (`64:ff9b::/96`) and 6to4
 *  (`2002::/16`, where the v4 sits in groups 1-2). Null for any other v6. */
function embeddedV4(h: string): string | null {
  const g = ipv6Groups(h);
  const quad = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && (g[5] === 0xffff || g[5] === 0)) {
    // `::` and `::1` are v6 addresses in their own right; they fall through.
    if (g[5] === 0 && g[6] === 0 && g[7]! <= 1) return null;
    return quad(g[6]!, g[7]!);
  }
  if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) return quad(g[6]!, g[7]!);
  if (g[0] === 0x2002) return quad(g[1]!, g[2]!);
  return null;
}

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
  // The address inside a v6 wrapper, however it is spelled: the dotted form
  // (`::ffff:127.0.0.1`), the hex form the URL parser and a resolver both
  // produce (`::ffff:7f00:1`), the long form, and the NAT64 and 6to4 prefixes.
  // A regex on the dotted form alone judged the hex spelling of loopback and of
  // the metadata address to be public.
  const inner = isIP(h) === 6 ? embeddedV4(h) : null;
  if (inner) h = inner;
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
    if (ipv6Groups(h).slice(0, 7).every((x) => x === 0) && ipv6Groups(h)[7]! <= 1) return true; // :: and ::1, any spelling
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
  const t = await resolveTarget(hRaw);
  return "error" in t ? t.error : null;
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

/** The browser's URL policy on a host — `safeUrl` in browserdrive.ts and the
 *  robots.txt fetch in robots.ts hold to the same one, which is why it lives
 *  here. Addresses the browser relay refuses even over http(s): link-local — which is
 *  where the cloud metadata endpoint 169.254.169.254 lives — and the unspecified
 *  address. `open` drives a real, logged-in browser and `read` hands back the
 *  page, so without this the relay is an SSRF probe with a credentialed response
 *  channel. Loopback and RFC1918 are deliberately NOT blocked: pointing the
 *  browser at a local dev server or a box on your own LAN is ordinary use here.
 *  On a literal only: for `safeUrl` a bare hostname passes, because the browser
 *  resolves it again when it connects, and the desktop app's egress guard
 *  (electron/egress-guard.js) is where a name is judged at connect time. The
 *  robots.txt fetch judges names too, through `resolveTarget(…, blockedTarget)`. */
function blockedV4(h: string): boolean {
  return h.startsWith("169.254.") || h === "0.0.0.0";
}

/** The eight 16-bit groups of a valid IPv6 address (isIP has already said v6),
 *  with `::` expanded and any trailing dotted-quad (`::ffff:1.2.3.4`) folded
 *  into its two hex groups. Given a valid address this always yields eight. */
function ipv6Groups(h: string): number[] {
  let s = h;
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) { // embedded IPv4 dotted-quad → two hex groups
    const q = tail.split(".").map((n) => parseInt(n, 10) & 0xff);
    s = s.slice(0, lastColon + 1) +
      ((q[0]! << 8) | q[1]!).toString(16) + ":" + ((q[2]! << 8) | q[3]!).toString(16);
  }
  const [left, right] = s.split("::");
  const head = left ? left.split(":") : [];
  const rear = right !== undefined ? (right ? right.split(":") : []) : [];
  const gap = right !== undefined ? 8 - head.length - rear.length : 0;
  return [...head, ...Array(Math.max(gap, 0)).fill("0"), ...rear].map((g) => parseInt(g, 16));
}

export function blockedTarget(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase(); // URL keeps IPv6 brackets
  const v = isIP(h);
  if (v === 4) return blockedV4(h);
  if (v === 6) {
    if (/^fe[89ab]/.test(h) || h === "::") return true; // fe80::/10 link-local, unspecified
    // A v4 host wearing a v6 hat — `[::ffff:169.254.169.254]` (which the URL
    // parser folds to `::ffff:a9fe:a9fe`), NAT64, 6to4 — is judged by the v4
    // rules only; loopback/LAN mapped this way stays allowed, like its v4 self.
    const inner = embeddedV4(h);
    if (inner) return blockedV4(inner);
    return false;
  }
  return false;
}

/** How a host name is turned into addresses; a parameter so a test can answer. */
export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;
export const dnsResolver: Resolver = (h) => lookup(h, { all: true, verbatim: true });

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
export type Fetcher = (url: string, init: RequestInit, address?: string) => Promise<Response>;

export interface GuardedFetchOptions {
  maxHops?: number;
  /** Test seam: what makes the request. Given the address the check settled on. */
  fetchImpl?: Fetcher;
  /** Test seam: a host judgement that does not resolve. When set, nothing is pinned. */
  hostCheck?: (host: string) => Promise<string | null>;
  /** How a name is resolved (default: the system resolver). */
  resolver?: Resolver;
  /** Which resolved or literal addresses are refused (default: `privateAddress`). */
  refuses?: (address: string) => boolean;
}

/**
 * The address a fetch will be connected to, judged, or why not.
 *
 * Every answer a name gives is judged (one private record is enough to refuse),
 * and the first one is returned so the caller connects to THAT address rather
 * than asking the resolver again. Checking a name and then fetching it resolves
 * twice, and a resolver the owner of the name controls can answer a public
 * address to the check and a private one to the connect.
 */
export async function resolveTarget(
  hRaw: string,
  resolver: Resolver = dnsResolver,
  refuses: (address: string) => boolean = privateAddress,
): Promise<{ address: string } | { error: string }> {
  const h = hRaw.replace(/^\[|\]$/g, "");
  if (!h) return { error: "no host" };
  if (refuses(h)) return { error: `${h} is a private or local address` };
  if (isIP(h)) return { address: h };
  try {
    const answers = await resolver(h);
    if (!answers.length) return { error: `${h} does not resolve` };
    for (const a of answers) if (refuses(a.address)) return { error: `${h} resolves to ${a.address}, a private or local address` };
    // v4 first: a host that answers a v6 address first is unreachable from a
    // machine with no v6 route, where the fetch it replaces fell back to v4.
    return { address: (answers.find((a) => isIP(a.address) === 4) ?? answers[0]!).address };
  } catch {
    return { error: `${h} does not resolve` };
  }
}

/**
 * `fetch` with the connection made to a given address.
 *
 * The request goes to the address itself, with the name kept where it matters:
 * `Host` from the URL's host and the TLS server name from its hostname, so the
 * certificate is still checked against the name and only the DNS answer
 * changes. (node:https with a `lookup` hook was tried first: Bun then checks the
 * certificate against the IP and every https fetch fails.) Redirects are left to
 * guardedFetch, which judges each hop.
 */
export function pinnedFetch(url: string, init: RequestInit, address: string): Promise<Response> {
  const u = new URL(url);
  const target = new URL(u);
  target.hostname = isIP(address) === 6 ? `[${address}]` : address;
  const headers = new Headers(init.headers);
  headers.set("host", u.host);
  return fetch(target.toString(), {
    ...init,
    headers,
    redirect: "manual",
    ...(u.protocol === "https:" ? { tls: { ...(init as { tls?: object }).tls, serverName: u.hostname,
      // Bun checks the certificate against the address it connected to unless told otherwise.
      checkServerIdentity: (_h: string, cert: tls.PeerCertificate) => tls.checkServerIdentity(u.hostname, cert) } } : {}),
  } as RequestInit);
}

export async function guardedFetch(
  urlIn: string,
  init: RequestInit,
  allow: (u: URL) => string | null,
  opts: GuardedFetchOptions = {},
): Promise<GuardedFetch> {
  const maxHops = opts.maxHops ?? 5;
  let url: URL;
  try { url = new URL(urlIn); } catch { return { error: "not a URL" }; }
  for (let hop = 0; hop <= maxHops; hop++) {
    let bad = allow(url);
    let address: string | undefined;
    if (!bad) {
      const t = opts.hostCheck
        ? { error: await opts.hostCheck(url.hostname) }
        : await resolveTarget(url.hostname, opts.resolver, opts.refuses);
      if ("address" in t) address = t.address; else bad = t.error;
    }
    if (bad) return { error: hop === 0 ? bad : `redirected to ${url.host}: ${bad}` };
    const req = { ...init, redirect: "manual" as const };
    const res = opts.fetchImpl
      ? await opts.fetchImpl(url.toString(), req, address)
      : address ? await pinnedFetch(url.toString(), req, address) : await fetch(url.toString(), req);
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      if (hop === maxHops) return { error: "too many redirects" };
      try { url = new URL(res.headers.get("location")!, url); } catch { return { error: "redirected to something that is not a URL" }; }
      continue;
    }
    return { res };
  }
  return { error: "too many redirects" };
}
