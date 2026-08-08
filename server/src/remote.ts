// Everything the "open this on your phone" panel needs to tell the truth.
//
// Reaching the dashboard from another device is already possible — bind off
// loopback, set AGENTGLASS_TRUST_LAN=1, carry a token — but every part of that
// is invisible from inside the app, and one part of it is invisible from
// inside the *machine*: a host firewall. On a box with ufw's default deny the
// server binds 0.0.0.0 happily, prints its reassuring warning, answers every
// local check (loopback traffic never leaves `lo`, which ufw allows), and the
// phone still sees nothing at all. ufw DROPs rather than REJECTs, so the
// browser does not even get a refusal to render: it sits on a blank white page
// until it times out. There is no way to conclude anything from that except
// "this feature is broken".
//
// So this module answers three questions the UI could not ask before:
//   * where am I reachable — the actual LAN/tailnet URLs, not localhost;
//   * has any device actually arrived — proof, rather than a hopeful yes;
//   * if not, what is most likely eating it — the firewall on this machine,
//     named, with the exact command to open the port for the local subnet only.
//
// It never runs that command. Handing a GUI a root shell to fix a network
// problem is a worse trade than reading one line and pasting it.
import { networkInterfaces } from "node:os";
import { readFileSync, statSync } from "node:fs";

/**
 * A non-loopback address that has talked to us, and what we know about it.
 *
 * The panel used to say "one device has connected, last seen 4m" and that was
 * the whole story: a number, an age, and no way to tell a phone in your hand
 * from a phone in a drawer, or either from something on the wifi that is not
 * yours. What is on the other end of an open port carrying a terminal is not a
 * detail to summarise. So each address keeps its own record, including whether
 * a socket from it is open *right now*, which is the only honest answer to
 * "connected" — an HTTP request proves a device was here a moment ago, and a
 * held-open WebSocket proves it is here.
 */
export interface DeviceRecord {
  address: string;
  firstAt: number;
  lastAt: number;
  /** Sockets from this address open at this instant. Zero is "was here". */
  live: number;
  /** What it calls itself, condensed. See deviceLabel. */
  label: string;
  /** The raw User-Agent, for the ones the condenser cannot name. */
  agent: string;
  /** Requests seen since it first arrived. */
  hits: number;
  /** Turned away at the door until it is let back in, or the server restarts. */
  blocked: boolean;
  /** This machine, reaching itself through one of its own addresses rather
   *  than through loopback. Never a device to cut off. */
  self?: boolean;
}

const seen = new Map<string, DeviceRecord>();

/** Bun hands v4-mapped v6 back on a dual-stack listener; compare the v4 part. */
function unmap(ip: string): string {
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

export function isLoopback(ip: string): boolean {
  const h = unmap(ip);
  return h === "127.0.0.1" || h.startsWith("127.") || h === "::1";
}

/**
 * Record that `ip` reached us, if it came from off-box.
 *
 * The whole point is evidence: the panel can say "your phone got through"
 * instead of "the port is open, good luck". Only remote addresses are kept —
 * loopback is every local fetch the app makes of itself, thousands an hour,
 * and it proves nothing about reachability.
 */
export function noteClient(ip: string | null | undefined, opts: { now?: number; agent?: string | null } = {}): void {
  if (!ip) return;
  const h = unmap(ip);
  if (isLoopback(h)) return;
  const now = opts.now ?? Date.now();
  const agent = (opts.agent ?? "").slice(0, 300);
  const prev = seen.get(h);
  if (prev) {
    prev.lastAt = now;
    prev.hits++;
    // A device that starts sending a User-Agent (or changes it) renames itself;
    // a request without one — the phone app's fetch, a hook, curl — must not
    // erase the name we already have.
    if (agent && agent !== prev.agent) { prev.agent = agent; prev.label = deviceLabel(agent); }
  } else {
    seen.set(h, {
      address: h, firstAt: now, lastAt: now, live: 0,
      label: deviceLabel(agent), agent, hits: 1, blocked: false,
    });
  }
  // A cap, because this is fed by unauthenticated connection metadata: without
  // one, anything that can reach the port can grow this map without limit. A
  // device with a socket open, or one deliberately blocked, is never the one
  // dropped: both are answers the user is relying on.
  if (seen.size > 64) {
    const evictable = [...seen.values()].filter((d) => d.live === 0 && !d.blocked).sort((a, b) => a.lastAt - b.lastAt)[0];
    if (evictable) seen.delete(evictable.address);
  }
}

/**
 * A socket from `ip` opened (+1) or closed (-1).
 *
 * This is what separates "connected" from "was connected". It is called for
 * every kind of socket the server holds — the event stream, a terminal, the
 * notification mirror — because any of them being open means that device is
 * live on this machine right now.
 */
export function noteSocket(ip: string | null | undefined, delta: 1 | -1, now = Date.now()): void {
  if (!ip) return;
  const h = unmap(ip);
  if (isLoopback(h)) return;
  const d = seen.get(h);
  if (!d) {
    if (delta < 0) return; // a close for something we never saw open
    noteClient(h, { now });
    const made = seen.get(h);
    if (made) made.live = 1;
    return;
  }
  // Clamped: a close that arrives twice, or after a reset, must not push this
  // negative and make a live device look absent forever.
  d.live = Math.max(0, d.live + delta);
  d.lastAt = now;
}

/**
 * Refuse this address, or let it back in.
 *
 * Honest about what it is: an address-level block, held in memory until the
 * server restarts. It stops a device that is on the network now, which is the
 * thing you want when you see something you do not recognise holding a
 * terminal. It is not a replacement for rotating the code — anything that can
 * pick a new address on the same network can come back — which is why the UI
 * offers both and says which is which.
 */
export function blockDevice(address: string, blocked: boolean, own: Iterable<string> = ownAddresses()): boolean {
  const d = seen.get(unmap(address));
  if (!d) return false;
  // Never this machine. Blocking an address the dashboard itself arrives on
  // would lock the user out of the window they pressed the button in, and
  // there is no undo from a page that can no longer talk to its server.
  if (blocked && isSelf(address, own)) return false;
  d.blocked = blocked;
  return true;
}

export function isBlocked(ip: string | null | undefined): boolean {
  if (!ip) return false;
  return seen.get(unmap(ip))?.blocked === true;
}

/**
 * Newest activity first, with anything currently holding a socket on top.
 *
 * `own` is the set of addresses this machine answers on. Anything arriving
 * from one of them is this machine talking to itself the long way round — the
 * app opened at its own tailnet address rather than at loopback, a browser
 * tab on the same box — and the panel listed it as a stranger with a
 * Disconnect button beside it. Pressing that would have blocked the address
 * the dashboard itself was arriving on. Marking it is what lets the UI
 * suppress the button, and the block route refuse it outright.
 */
export function remoteDevices(own: Iterable<string> = ownAddresses()): DeviceRecord[] {
  const mine = new Set([...own].map(unmap));
  return [...seen.values()]
    .sort((a, b) => (b.live > 0 ? 1 : 0) - (a.live > 0 ? 1 : 0) || b.lastAt - a.lastAt)
    .map((d) => ({ ...d, self: mine.has(d.address) }));
}

/** Every address this machine answers on, from the live interfaces. */
export function ownAddresses(): string[] {
  return reachableAddresses().map((a) => a.address);
}

/** Whether an address belongs to this machine (loopback included). */
export function isSelf(ip: string | null | undefined, own: Iterable<string> = ownAddresses()): boolean {
  if (!ip) return false;
  const h = unmap(ip);
  if (isLoopback(h)) return true;
  return [...own].map(unmap).includes(h);
}

export interface RemoteClients {
  count: number;
  lastAt: number | null;
  addresses: string[];
  /** How many are holding a socket open at this instant. */
  liveCount: number;
}

export function remoteClients(): RemoteClients {
  // This machine does not count as a device that reached us: "one device is
  // connected" meaning the window you are reading it in is a lie of the kind
  // that makes the number useless. The row still appears in the list, named.
  const all = remoteDevices().filter((d) => !d.self);
  return {
    count: all.length,
    lastAt: all.reduce<number | null>((n, d) => (n === null || d.lastAt > n ? d.lastAt : n), null),
    addresses: all.slice(0, 8).map((d) => d.address),
    liveCount: all.filter((d) => d.live > 0).length,
  };
}

/**
 * A User-Agent, reduced to the phrase a person would use for that device.
 *
 * Deliberately coarse. The point is telling "my Pixel" apart from "something
 * else on this wifi", not building a fingerprint: a wrong-but-specific guess
 * ("Galaxy S22") is worse than a right-and-vague one ("An Android phone"),
 * because the user acts on this by deciding whether to cut a device off.
 */
export function deviceLabel(uaRaw: string | null | undefined): string {
  const ua = (uaRaw ?? "").trim();
  if (!ua) return "Unnamed device";
  if (/^(curl|wget|python-requests|node-fetch|go-http-client|httpie)/i.test(ua)) {
    return `A script (${ua.split("/")[0]!.toLowerCase()})`;
  }
  // Electron says Chrome as well, and on this server the Electron in question
  // is almost always agentglass itself talking to its own sidecar over a real
  // address rather than loopback. Naming it beats calling the cockpit "Chrome".
  if (/\bElectron\//.test(ua)) return "The agentglass app";
  const browser =
    /\bEdg\//.test(ua) ? "Edge"
    : /\bOPR\/|\bOpera\b/.test(ua) ? "Opera"
    : /\bFirefox\//.test(ua) ? "Firefox"
    : /\bChrome\//.test(ua) ? "Chrome"
    : /\bSafari\//.test(ua) ? "Safari"
    : null;
  // The model is inside the Android comment, before the build tag. It is the
  // one place a phone says something a person recognises — when it says
  // anything at all. Chrome on Android 13 and later freezes the model to the
  // literal "K" for privacy, and `wv` means a WebView rather than a device, so
  // both are placeholders to see through. A row reading "K · Chrome" is what
  // this pane looked like on a Pixel, which is worse than admitting the phone
  // did not say.
  const android = ua.match(/Android[^;)]*;\s*([^;)]+?)(?:\s+Build\/[^;)]*)?\s*\)/);
  const model = android?.[1]?.trim() ?? "";
  const namedModel = model && !/^(k|wv)$/i.test(model) ? model : "";
  const device =
    /\biPhone\b/.test(ua) ? "iPhone"
    : /\biPad\b/.test(ua) ? "iPad"
    : /\bCrOS\b/.test(ua) ? "Chromebook"
    : android ? (namedModel || "An Android device")
    : /\bMacintosh\b/.test(ua) ? "Mac"
    : /\bWindows NT\b/.test(ua) ? "Windows PC"
    : /\bLinux\b/.test(ua) ? "Linux machine"
    : null;
  if (device && browser) return `${device} · ${browser}`;
  return device ?? browser ?? "Unnamed device";
}

/** Test seam: forget every recorded client. */
export function __resetRemoteClients(): void {
  seen.clear();
}

// ---------------------------------------------------------------------------
// Was this loopback connection really tailscaled?
// ---------------------------------------------------------------------------
//
// net.ts explains the hole (`tailscale serve` re-originates from 127.0.0.1, so
// the whole tailnet looked like the desk). This is the half of the fix that
// cannot be forged, and it exists because the cheap version of the fix is a
// fresh vulnerability: every header on a proxied request is attacker-adjacent,
// and a local process can set all of them.
//
// Measured, same box, same headers, one through a real `tailscale serve` and
// one straight at the port from my own shell:
//
//   through serve : peer 127.0.0.1:36388  -> socket uid 0
//   forged direct : peer 127.0.0.1:36394  -> socket uid 1000
//
// with the forging curl sending the real peer's tailnet address in
// `X-Forwarded-For`, plus `Tailscale-User-Login:` and `Tailscale-Headers-Info:`
// verbatim. Every header matched; the uid did not, and a process cannot choose
// the uid the kernel records against its own socket. That is the whole basis of
// the check.
//
// (Through serve, tailscaled *overwrites* those headers — the forged
// `Tailscale-User-Login: attacker@evil.example` came out as the real login. So
// they are unforgeable *through* the proxy and trivially forgeable *around*
// it, which is exactly why they are a trigger below and never a decision.
// `X-Real-IP` and `Tailscale-Headers` are passed through untouched, so a
// tailnet client sets those itself: never read them.)

/** Where tailscaled puts its LocalAPI socket on Linux. Owned by the uid
 *  tailscaled runs as, inside a root-owned directory — so one stat answers
 *  "which uid is tailscaled" without a /proc scan (3.75ms) or hardcoding 0.
 *  Root is the honest default: tailscaled needs it for the TUN device. */
const TAILSCALED_SOCK = "/var/run/tailscale/tailscaled.sock";

let uidCache: { uid: number; at: number } | null = null;
/** Set only by __trustProxyUid, declared here rather than beside it: a `let`
 *  read by a function defined above it is a TDZ crash waiting for the first
 *  caller that runs during module evaluation. This codebase has had that
 *  black-screen bug once already. */
let forcedUid: number | null = null;

function tailscaledUid(now = Date.now()): number {
  if (forcedUid !== null) return forcedUid;
  if (uidCache && now - uidCache.at < 60_000) return uidCache.uid;
  let uid = 0;
  try { uid = statSync(TAILSCALED_SOCK).uid; } catch { /* not Linux, or not installed */ }
  uidCache = { uid, at: now };
  return uid;
}

/**
 * uid per local port, for sockets currently connected TO `ourPort`.
 *
 * Cached as a whole table for a second rather than memoised per connection,
 * and that is a deliberate trade. Ephemeral ports get reused, so a per-port
 * verdict can outlive the connection it was about and bless whatever picks the
 * number up next. Caching the *table* instead means no answer is ever more
 * than a second stale, for the same cost: the parse measured 2.2-4.5ms over
 * 185 rows, so one read per second is ~0.25% of a core even under load.
 *
 * Reading it at all is rare: the trigger below fires only on requests carrying
 * forwarding headers, and his hooks send none.
 */
let tableCache: { map: Map<number, number>; port: number; at: number } | null = null;

function socketOwners(ourPort: number, now = Date.now()): Map<number, number> {
  if (tableCache && tableCache.port === ourPort && now - tableCache.at < 1000) return tableCache.map;
  const map = new Map<number, number>();
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    for (const line of text.split("\n").slice(1)) {
      const c = line.trim().split(/\s+/);
      if (c.length < 10) continue;
      if (c[3] !== "01") continue; // ESTABLISHED only; a TIME_WAIT row reports uid 0 for everyone
      const localPort = parseInt(c[1]!.split(":")[1] ?? "", 16);
      const remPort = parseInt(c[2]!.split(":")[1] ?? "", 16);
      if (remPort !== ourPort || !Number.isFinite(localPort)) continue;
      map.set(localPort, Number(c[7]));
    }
  }
  tableCache = { map, port: ourPort, at: now };
  return map;
}

/** Test seam: drop both caches so a test can change what /proc would say. */
export function __resetProxyProbe(): void {
  uidCache = null;
  tableCache = null;
  forcedUid = null;
}

/**
 * Test seam: treat `uid` as tailscaled's.
 *
 * A test proxy runs as whoever runs the tests, never as root, so without this
 * the end-to-end proof could only ever be run on a machine with Tailscale
 * installed and configured — which is to say, never in CI, on exactly the file
 * that must not regress. Reachable only from inside the process (the e2e test
 * spawns the server with `--preload`), and anything that can choose the
 * server's command line already owns the server.
 */
export function __trustProxyUid(uid: number): void {
  forcedUid = uid;
}

/**
 * True when the local tailscaled is the one holding this connection.
 *
 * Two stages, cheap then certain:
 *
 *  1. Trigger — does the request carry any forwarding header at all. Broad on
 *     purpose (any of the three, not the exact marker), because a false
 *     negative here silently re-opens the hole while a false positive costs
 *     one cached /proc read and is then rejected by stage 2. His hooks carry
 *     none of them and never reach stage 2.
 *
 *  2. Decision — the uid that owns the connecting socket. Un-forgeable by any
 *     non-root local process. If an attacker is already root the token file is
 *     readable anyway, so root is not a boundary this check pretends to hold.
 *
 * Where /proc does not exist (macOS, Windows) stage 2 cannot run and the
 * trigger stands alone, so the headers are believed. That is safe *for
 * authorization* and not for bookkeeping, and the difference matters: a forged
 * `X-Forwarded-For` can only ever move a caller from loopback to remote, which
 * takes privilege away — remote needs a token, loopback does not. What it can
 * still do is invent a row in the device list or spend another device's rate
 * limit. Both need a process already on the machine, and neither grants
 * anything.
 */
export function proxiedByTailscaled(
  peer: { address?: string; port?: number } | null | undefined,
  ourPort: number,
  headers: { get(name: string): string | null },
  now = Date.now()
): boolean {
  if (!peer?.address || !isLoopback(peer.address)) return false;
  const forwarded =
    headers.get("x-forwarded-for") ||
    headers.get("tailscale-headers-info") ||
    headers.get("tailscale-user-login");
  if (!forwarded) return false;
  let owners = socketOwners(ourPort, now);
  let uid = peer.port === undefined ? undefined : owners.get(peer.port);
  // A miss is usually a connection newer than the one-second table, so pay for
  // one fresh read before drawing any conclusion from absence. Without this the
  // very first request on a new tailscaled connection — which is every request
  // that matters until the pool warms — would be decided by the fallback.
  if (uid === undefined && peer.port !== undefined) {
    tableCache = null;
    owners = socketOwners(ourPort, now);
    uid = owners.get(peer.port);
  }
  // Genuinely nothing to consult: no /proc (macOS, Windows), or the socket went
  // away between accept and now. Both land on the trigger alone — see above for
  // why believing a forwarding header can only ever cost privilege, not grant it.
  if (owners.size === 0 || uid === undefined) return true;
  return uid === tailscaledUid(now);
}

export interface Reachable {
  /** The address to put in a URL. */
  address: string;
  /** Interface name, so "which wifi" is answerable. */
  iface: string;
  /** A tailnet address (CGNAT 100.64/10) rather than a plain LAN one. */
  tailnet: boolean;
  /** CIDR of the local subnet, for the firewall command. */
  subnet: string | null;
  /** A full base URL to use verbatim instead of `http://address:port/` — a
   *  Tailscale HTTPS name, which is the only address a phone can pair over. */
  url?: string;
  /** Served over HTTPS (a secure context). */
  secure?: boolean;
  /** A friendlier name than the raw address. */
  label?: string;
}

/**
 * This machine's Tailscale identity, cached.
 *
 * `names` is every hostname this box answers to on its tailnet (its MagicDNS
 * name). `https` is set only when `tailscale serve` is actually terminating TLS
 * and proxying to our port — i.e. when a phone opening the https name would
 * reach us — so the pane never offers a secure address that 404s.
 *
 * Refreshed on a timer rather than per request: the gate reads `names`
 * synchronously on the hot path, and shelling out to `tailscale` there would
 * add a process spawn to every request.
 *
 * ── why this is not just a value ──────────────────────────────────────────
 * It is a TRUST cache. `trustedName` in index.ts reads it to decide whether a
 * WebSocket upgrade is allowed, and the phone deliberately presents its
 * MagicDNS origin (mobile/src/lib/live.ts says why at length). So an empty
 * `names` does not merely hide a row in a picker — it refuses `/stream`, and
 * the phone stops receiving alert frames while REST keeps answering on its 20s
 * poll. The app looks alive and has quietly stopped buzzing.
 *
 * The bug this shape fixes: every failure of `tailscale status` used to be
 * indistinguishable from "this machine has no tailnet name", and the empty set
 * was assigned unconditionally. One blip — tailscaled restarting, the socket
 * slow, the binary busy — landing on the 120s tick emptied it, and it healed
 * only on the next successful tick, up to two minutes later, with nothing said
 * anywhere. So: a probe that could not ASK never overwrites the last answer,
 * and it is retried sooner than a probe that could.
 */
interface Tailnet {
  names: Set<string>;
  https: { name: string; url: string } | null;
  /** `tailscale` was on PATH at the last look. */
  installed: boolean;
  /** When the last probe that got an ANSWER landed. 0 ⇒ never had one. */
  at: number;
  /** Consecutive probes that could not ask. 0 while healthy. */
  fails: number;
  /** Why the last probe could not ask. Null while healthy. */
  problem: string | null;
  /** The grace ran out while still unable to ask, so the held names were
   *  dropped. Empty `names` then means "we gave up", not "no tailnet". */
  dropped: boolean;
}
let tailnet: Tailnet = { names: new Set(), https: null, installed: true, at: 0, fails: 0, problem: null, dropped: false };
export function tailnetNames(): ReadonlySet<string> { return tailnet.names; }

/**
 * How long to wait before looking again.
 *
 * Two cadences, because a failure is the state most worth leaving: a held name
 * has a deadline on it, and every second spent failing is a second of that
 * deadline. Backed off all the same — a daemon that is down tends to stay down
 * for a while, and a process spawn every ten seconds for an hour is not free.
 */
export const TAILNET_OK_MS = 120_000;
const TAILNET_RETRY_MS = 10_000;
const TAILNET_RETRY_MAX_MS = 60_000;

/**
 * How long a trusted name may outlive the last time we could confirm it.
 *
 * This is the staleness budget of a TRUST cache, so it is not "as long as
 * possible". Ten minutes, and the reasoning is about what an attacker would
 * need in the window rather than about how long a restart takes:
 *
 *   - The name only leaves `names` for real when `tailscale status` ANSWERS and
 *     this node has no MagicDNS name — logged out, or removed from the tailnet.
 *     That answer is authoritative and applied at once, whatever the exit code
 *     (see selfNameOf). The grace is only ever spent while we CANNOT ASK.
 *   - So the exposure is the overlap of two things: this machine removed from
 *     the tailnet, AND its local tailscaled unreachable. In that state nothing
 *     is routing over the tailnet to us anyway; the only caller that can still
 *     present the name is one that already reaches the port some other way —
 *     loopback, or the LAN with AGENTGLASS_TRUST_LAN already on, both of which
 *     `privateHost` trusts without this cache.
 *   - And an accepted origin is not access. The token gate (auth.ts) and
 *     pairing are untouched by any of this; the origin check is the anti-CSRF
 *     layer, not the credential.
 *
 * Ten minutes is roughly forty retries at the schedule above, which is far more
 * than any tailscaled restart measured on this machine (single-digit seconds),
 * and short enough that a genuinely dead daemon fails closed inside a coffee.
 */
const TAILNET_GRACE_MS = 10 * 60_000;

/*
 * The two "said once" latches, declared HERE rather than beside the functions
 * that use them.
 *
 * `let` in a module is in its temporal dead zone until the line runs, so a
 * declaration further down the file is a live grenade for anything that could
 * be reached during module evaluation — this app has already lost a window to
 * exactly that. Nothing calls refreshTailscale at import time today; putting
 * these above every reader means nothing can start.
 */
let expiredAlreadySaid = false;
let healedIsNews = false;

interface TsRun {
  /** `tailscale` is not on PATH. An ANSWER — there is no tailnet — not a
   *  failure to ask. The old `string | null` said the same thing here as it did
   *  for a daemon mid-restart, which is the whole of T26. */
  absent?: boolean;
  /** Exit status; null when the process could not be started or read at all. */
  code: number | null;
  out: string;
  why?: string;
}

async function tsCmd(args: string[]): Promise<TsRun> {
  // The PATH is passed rather than left implicit, and it is not a style choice:
  // measured, `Bun.which("tailscale")` resolves against the PATH the process
  // was STARTED with, and a `process.env.PATH` changed afterwards has no effect
  // at all. It cost this ticket a proof — a stub put on PATH at runtime was
  // silently bypassed and the real binary answered instead. The same staleness
  // applies in the app: a server started before Tailscale was installed would
  // never find it, however many times this ran.
  const bin = Bun.which("tailscale", { PATH: process.env.PATH ?? "" });
  if (!bin) return { absent: true, code: null, out: "" };
  try {
    const p = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return { code: p.exitCode, out };
  } catch (e) {
    return { code: null, out: "", why: String((e as Error)?.message ?? e).slice(0, 120) };
  }
}

/**
 * The MagicDNS name in a `tailscale status --json` body.
 *
 * Three returns, and the distinction is the point:
 *   a name  — this node answers to it;
 *   ""      — we read a real status body and this node has no name (logged out,
 *             or removed from the tailnet). An ANSWER, applied immediately;
 *   null    — that was not a status body. We could not ask.
 *
 * The BODY decides, and the exit code is never consulted. Measured, on this
 * machine's real tailscaled: running, `--json` gives exit 0 and a body with
 * `BackendState: "Running"`. NOT measured, and deliberately: what `--json`
 * exits with when the backend is stopped or logged out — that would have meant
 * stopping a daemon that is not this code's to stop.
 *
 * Which is the reason for the rule rather than an excuse for it. An exit-code
 * test has to be right about that unmeasured case in BOTH directions: read it
 * as failure and a name that has genuinely gone is held for the grace; read it
 * as an answer and a daemon that merely could not be reached empties the cache,
 * which is the bug. Reading the body cannot be wrong either way — a daemon that
 * is not there writes nothing to stdout, and nothing does not parse.
 */
function selfNameOf(out: string): string | null {
  let j: unknown;
  try { j = JSON.parse(out); } catch { return null; }
  if (!j || typeof j !== "object") return null;
  const dns = (j as { Self?: { DNSName?: unknown } }).Self?.DNSName;
  return typeof dns === "string" && dns ? dns.replace(/\.$/, "").toLowerCase() : "";
}

/** What one refresh worked out, and when to come back. */
export interface TailnetProbe {
  /** We got an authoritative answer about the tailnet this pass. */
  ok: boolean;
  /** Milliseconds until the next look. Sooner after a failure — see above. */
  nextMs: number;
  /** Why we could not ask, when we could not. */
  problem?: string;
  /** This pass gave up on a held name (the grace ran out). */
  dropped?: boolean;
}

/**
 * Read the tailnet name and whether serve is fronting our port.
 *
 * Fails SOFT in the sense that matters and fails LOUD in the sense that used to
 * be missing: no Tailscale, or serve not set up, still just leaves nothing
 * offered — but a probe that could not run keeps the last good answer, says so
 * on `/remote/status`, logs it once, and asks to be called back sooner.
 */
export async function refreshTailscale(port: number, now = Date.now()): Promise<TailnetProbe> {
  const run = await tsCmd(["status", "--json"]);

  // Not installed is an answer, and a stable one: there is no tailnet, and no
  // amount of retrying will produce a name. Assigned, not held.
  if (run.absent) {
    const had = tailnet.names.size;
    tailnet = { names: new Set(), https: null, installed: false, at: now, fails: 0, problem: null, dropped: false };
    if (had) console.warn(`[remote] tailscale is no longer on PATH — dropped ${had} trusted tailnet name(s)`);
    // Not `sayTailnetHealed()`: this IS an answer, so the hold is over, but
    // "tailscale answered again" under a line saying it is gone reads as two
    // contradictory events. Clear the latches without narrating a recovery.
    healedIsNews = false;
    expiredAlreadySaid = false;
    return { ok: true, nextMs: TAILNET_OK_MS };
  }

  const self = selfNameOf(run.out);
  if (self === null) return holdTailnet(run, now);

  const names = new Set<string>();
  if (self) names.add(self);

  /*
   * The serve offer follows the names, and only within the same answer.
   *
   * `tailscale serve status --json` prints `{}` when nothing is served, which
   * parses and is authoritative: serve was turned off, stop offering the HTTPS
   * row. If the serve probe itself could not be read we keep whatever we had,
   * but only while the identity is unchanged — an https URL built on a name
   * this node no longer answers to is worse than no row at all.
   */
  let https: { name: string; url: string } | null = null;
  if (self) {
    const serve = await tsCmd(["serve", "status", "--json"]);
    const web = serveWeb(serve.out);
    if (web === null) {
      https = tailnet.https && tailnet.https.name === self ? tailnet.https : null;
    } else {
      const hits = `:${port}`;
      for (const [hostPort, cfg] of Object.entries(web)) {
        const handlers = (cfg as { Handlers?: Record<string, { Proxy?: string }> })?.Handlers ?? {};
        const proxiesUs = Object.values(handlers).some((h) => typeof h?.Proxy === "string" && h.Proxy.includes(hits));
        if (proxiesUs) { const name = hostPort.replace(/:\d+$/, "").toLowerCase(); https = { name, url: `https://${name}/` }; break; }
      }
    }
  }

  tailnet = { names, https, installed: true, at: now, fails: 0, problem: null, dropped: false };
  sayTailnetHealed();
  return { ok: true, nextMs: TAILNET_OK_MS };
}

/** The `Web` map out of a serve status body, or null when that was not one. */
function serveWeb(out: string): Record<string, unknown> | null {
  let j: unknown;
  try { j = JSON.parse(out); } catch { return null; }
  if (!j || typeof j !== "object") return null;
  const web = (j as { Web?: unknown }).Web;
  return web && typeof web === "object" ? (web as Record<string, unknown>) : {};
}

/**
 * A probe that could not ask: keep what we knew, on a deadline.
 *
 * Nothing here overwrites `names` until the deadline passes, which is the whole
 * fix — the phone's upgrade survives a tailscaled restart instead of being
 * refused for up to two minutes with no trace anywhere.
 */
function holdTailnet(run: TsRun, now: number): TailnetProbe {
  const problem = run.why
    ? `tailscale could not be run (${run.why})`
    : `tailscale status answered nothing readable (exit ${run.code ?? "?"})`;
  const fails = tailnet.fails + 1;
  const expired = now - tailnet.at >= TAILNET_GRACE_MS;
  // `at` is left where it was: the grace is measured from the last ANSWER, not
  // from the last attempt, or a probe every ten seconds would renew it forever.
  const keep = expired ? new Set<string>() : tailnet.names;
  const dropped = expired && (tailnet.names.size > 0 || tailnet.dropped);
  const wasHolding = tailnet.problem !== null;
  tailnet = {
    ...tailnet,
    names: keep,
    https: expired ? null : tailnet.https,
    fails, problem, dropped,
  };
  // Said once per spell of trouble, not once per probe: at ten seconds a
  // ten-minute outage is forty identical lines, and a log nobody can skim is a
  // log nobody reads. Same treatment alerts.ts gives a missing notify-send.
  if (!wasHolding) {
    healedIsNews = true;
    const held = keep.size;
    console.warn(
      `[remote] ${problem} — ${held ? `holding ${held} trusted tailnet name(s) for up to ${Math.round((TAILNET_GRACE_MS - (now - tailnet.at)) / 1000)}s` : "no tailnet name is held"}`
    );
  }
  if (dropped && !expiredAlreadySaid) {
    expiredAlreadySaid = true;
    console.warn(
      `[remote] tailscale has not answered for ${Math.round(TAILNET_GRACE_MS / 60_000)} minutes — the trusted tailnet name is dropped. ` +
      `A phone connecting over its MagicDNS name will be refused at the WebSocket upgrade until tailscale answers again.`
    );
  }
  return {
    ok: false,
    nextMs: Math.min(TAILNET_RETRY_MS * 2 ** (fails - 1), TAILNET_RETRY_MAX_MS),
    problem,
    dropped,
  };
}

function sayTailnetHealed(): void {
  expiredAlreadySaid = false;
  if (!healedIsNews) return;
  healedIsNews = false;
  console.log(`[remote] tailscale answered again — ${tailnet.names.size} trusted tailnet name(s)`);
}

/** Whether the answer above is an answer at all. Read by `/remote/status` so
 *  "no tailnet" and "could not ask" stop looking identical from outside. */
export interface TailnetHealth {
  /** `tailscale` was on PATH at the last look. */
  installed: boolean;
  /** Names trusted right now. */
  names: string[];
  /** When we last got an ANSWER. 0 ⇒ never. */
  at: number;
  /** Set while we cannot ask: `names` is what we last KNEW, not what is true. */
  problem?: string;
  /** Consecutive failed probes. */
  fails?: number;
  /** The grace ran out — `names` is empty because we gave up holding it. */
  dropped?: boolean;
}

export function tailnetHealth(): TailnetHealth {
  return {
    installed: tailnet.installed,
    names: [...tailnet.names],
    at: tailnet.at,
    ...(tailnet.problem ? { problem: tailnet.problem, fails: tailnet.fails } : {}),
    ...(tailnet.dropped ? { dropped: true } : {}),
  };
}

/** Test seam: put the cache back to a fresh boot. Nothing in the app calls it —
 *  a suite that leaves a held name behind poisons the next file's expectations,
 *  and these are module-level by design (the gate reads them synchronously). */
export function __resetTailnet(): void {
  tailnet = { names: new Set(), https: null, installed: true, at: 0, fails: 0, problem: null, dropped: false };
  expiredAlreadySaid = false;
  healedIsNews = false;
}

const cgnat = (ip: string): boolean => {
  const [a, b] = ip.split(".").map(Number);
  return a === 100 && b! >= 64 && b! <= 127;
};

/**
 * Every IPv4 address another device could plausibly use to reach this machine.
 *
 * IPv6 is deliberately left out: a URL with a bracketed v6 literal in it is not
 * something anyone types on a phone, and the QR path makes the address the
 * user never sees anyway — so the only cost of skipping it is a shorter list.
 */
export function reachableAddresses(
  ifaces: ReturnType<typeof networkInterfaces> = networkInterfaces()
): Reachable[] {
  const out: Reachable[] = [];
  for (const [iface, addrs] of Object.entries(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      // Docker/podman bridges answer on the host but lead nowhere useful for a
      // phone: nothing on the wifi routes to them.
      if (/^(docker|br-|virbr|veth|podman)/.test(iface)) continue;
      out.push({ address: a.address, iface, tailnet: cgnat(a.address), subnet: subnetOf(a.address, a.netmask) });
    }
  }
  // A plain LAN address first: it is the one that works with no extra software
  // on the phone. Tailnet addresses follow — they work from anywhere, which is
  // better, but only once Tailscale is installed on both ends.
  return out.sort((x, y) => Number(x.tailnet) - Number(y.tailnet));
}

/** `192.168.1.131` + `255.255.255.0` → `192.168.1.0/24`. Null if unparseable. */
export function subnetOf(address: string, netmask: string | undefined): string | null {
  if (!netmask) return null;
  const ip = address.split(".").map(Number);
  const mask = netmask.split(".").map(Number);
  if (ip.length !== 4 || mask.length !== 4 || [...ip, ...mask].some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  const bits = mask.reduce((n, o) => n + ((o >>> 0).toString(2).match(/1/g)?.length ?? 0), 0);
  return `${ip.map((o, i) => o & mask[i]!).join(".")}/${bits}`;
}

export interface FirewallHint {
  /** Which tool is on this machine: what the user is expected to run. */
  tool: "ufw" | "firewalld" | "nftables";
  /** The exact command, scoped to the local subnet rather than the world. */
  command: string;
  /** How to put it back. */
  undo: string | null;
}

/**
 * The most likely thing standing between an exposed port and a phone.
 *
 * Presence of the binary is the whole detection. Reading the actual rules would
 * need root on every one of these, and being wrong in the reassuring direction
 * ("your firewall is fine") is the failure this exists to prevent — so it says
 * "if nothing arrives, this is probably why" rather than claiming to know.
 */
export function firewallHint(
  port: number,
  subnet: string | null,
  which: (cmd: string) => string | null = (c) => Bun.which(c)
): FirewallHint | null {
  const from = subnet ?? "192.168.0.0/16";
  if (which("ufw")) {
    return {
      tool: "ufw",
      command: `sudo ufw allow from ${from} to any port ${port} proto tcp comment 'agentglass'`,
      undo: `sudo ufw delete allow from ${from} to any port ${port} proto tcp`,
    };
  }
  if (which("firewall-cmd")) {
    return {
      tool: "firewalld",
      command:
        `sudo firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="${from}" port port="${port}" protocol="tcp" accept' && sudo firewall-cmd --reload`,
      undo: `sudo firewall-cmd --permanent --remove-rich-rule='rule family="ipv4" source address="${from}" port port="${port}" protocol="tcp" accept' && sudo firewall-cmd --reload`,
    };
  }
  if (which("nft")) {
    return {
      tool: "nftables",
      command: `sudo nft add rule inet filter input ip saddr ${from} tcp dport ${port} accept`,
      undo: null, // nft deletes by handle; telling someone to guess one is worse than nothing
    };
  }
  return null;
}

export interface RemoteStatus {
  /** Bound somewhere other than loopback, so off-box traffic can arrive. */
  exposed: boolean;
  bind: string;
  port: number;
  /** Private-network origins accepted. Without it an exposed port 403s. */
  trustLan: boolean;
  /** A token is configured, so URLs need to carry it once. */
  tokenRequired: boolean;
  /** This port serves the dashboard itself, not just the API. */
  webUi: boolean;
  /**
   * Where this machine answers. Addresses only — no credential.
   *
   * These used to arrive with `?token=` on the end for a local caller, because
   * the QR was the credential and the pane had to draw it. Pairing replaced
   * that (see pairing.ts), and once nothing needs the secret in a URL, serving
   * it in one is a hole with no user left: a link that grants a terminal is
   * exactly the sort of thing that ends up in a screenshot, a chat, or an
   * issue about why the phone will not connect.
   */
  urls: string[];
  addresses: Reachable[];
  clients: RemoteClients;
  /** One row per device that has reached this machine, live state included. */
  devices: DeviceRecord[];
  firewall: FirewallHint | null;
  /**
   * What we know about this machine's tailnet name, and whether we know it.
   *
   * Here because the empty set had two meanings and no way to tell them apart
   * from outside — "there is no tailnet" and "tailscale would not answer, so
   * the phone's origin is about to be refused" produced the identical, silent,
   * healthy-looking page. See Tailnet.
   */
  tailnet: TailnetHealth;
}

export function remoteStatus(opts: {
  bind: string;
  port: number;
  trustLan: boolean;
  token: string | null;
  webUi: boolean;
  addresses?: Reachable[];
  which?: (cmd: string) => string | null;
}): RemoteStatus {
  const base = opts.addresses ?? reachableAddresses();
  // Lead with the Tailscale HTTPS name when `tailscale serve` is fronting us:
  // it is the only address a phone can actually PAIR over (HTTPS ⇒ WebCrypto),
  // so it belongs at the top of the QR picker, not buried under raw http IPs.
  const secure: Reachable[] = tailnet.https
    ? [{ address: tailnet.https.name, iface: "tailscale", tailnet: true, subnet: null, url: tailnet.https.url, secure: true, label: "Tailscale (HTTPS)" }]
    : [];
  const addresses = [...secure, ...base];
  const exposed = !["127.0.0.1", "::1", "localhost"].includes(opts.bind);
  return {
    exposed,
    bind: opts.bind,
    port: opts.port,
    trustLan: opts.trustLan,
    tokenRequired: opts.token !== null,
    webUi: opts.webUi,
    urls: addresses.map((a) => a.url ?? `http://${a.address}:${opts.port}/`),
    addresses,
    clients: remoteClients(),
    devices: remoteDevices(base.map((a) => a.address)),
    firewall: firewallHint(opts.port, base[0]?.subnet ?? null, opts.which),
    tailnet: tailnetHealth(),
  };
}
