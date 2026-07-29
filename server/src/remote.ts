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
    // a request without one — the phone's own service worker, say — must not
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
export function blockDevice(address: string, blocked: boolean): boolean {
  const d = seen.get(unmap(address));
  if (!d) return false;
  d.blocked = blocked;
  return true;
}

export function isBlocked(ip: string | null | undefined): boolean {
  if (!ip) return false;
  return seen.get(unmap(ip))?.blocked === true;
}

/** Newest activity first, with anything currently holding a socket on top. */
export function remoteDevices(): DeviceRecord[] {
  return [...seen.values()]
    .sort((a, b) => (b.live > 0 ? 1 : 0) - (a.live > 0 ? 1 : 0) || b.lastAt - a.lastAt)
    .map((d) => ({ ...d }));
}

export interface RemoteClients {
  count: number;
  lastAt: number | null;
  addresses: string[];
  /** How many are holding a socket open at this instant. */
  liveCount: number;
}

export function remoteClients(): RemoteClients {
  const all = remoteDevices();
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
  const browser =
    /\bEdg\//.test(ua) ? "Edge"
    : /\bOPR\/|\bOpera\b/.test(ua) ? "Opera"
    : /\bFirefox\//.test(ua) ? "Firefox"
    : /\bChrome\//.test(ua) ? "Chrome"
    : /\bSafari\//.test(ua) ? "Safari"
    : null;
  // The model is inside the Android comment, before the build tag. It is the
  // one place a phone says something a person recognises.
  const android = ua.match(/Android[^;)]*;\s*([^;)]+?)(?:\s+Build\/[^;)]*)?\s*\)/);
  const device =
    /\biPhone\b/.test(ua) ? "iPhone"
    : /\biPad\b/.test(ua) ? "iPad"
    : /\bCrOS\b/.test(ua) ? "Chromebook"
    : android ? (android[1] && !/^wv$/i.test(android[1].trim()) ? android[1].trim() : "An Android device")
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

export interface Reachable {
  /** The address to put in a URL. */
  address: string;
  /** Interface name, so "which wifi" is answerable. */
  iface: string;
  /** A tailnet address (CGNAT 100.64/10) rather than a plain LAN one. */
  tailnet: boolean;
  /** CIDR of the local subnet, for the firewall command. */
  subnet: string | null;
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
  /** URLs to hand another device, token included when we know it. */
  urls: string[];
  addresses: Reachable[];
  clients: RemoteClients;
  /** One row per device that has reached this machine, live state included. */
  devices: DeviceRecord[];
  firewall: FirewallHint | null;
  /** Present only for a local caller — see the gate in index.ts. */
  token?: string;
}

export function remoteStatus(opts: {
  bind: string;
  port: number;
  trustLan: boolean;
  token: string | null;
  webUi: boolean;
  /** Whether to include the token (and tokenised URLs) in the answer. */
  includeToken: boolean;
  addresses?: Reachable[];
  which?: (cmd: string) => string | null;
}): RemoteStatus {
  const addresses = opts.addresses ?? reachableAddresses();
  const exposed = !["127.0.0.1", "::1", "localhost"].includes(opts.bind);
  const q = opts.includeToken && opts.token ? `/?token=${encodeURIComponent(opts.token)}` : "/";
  return {
    exposed,
    bind: opts.bind,
    port: opts.port,
    trustLan: opts.trustLan,
    tokenRequired: opts.token !== null,
    webUi: opts.webUi,
    urls: addresses.map((a) => `http://${a.address}:${opts.port}${q}`),
    addresses,
    clients: remoteClients(),
    devices: remoteDevices(),
    firewall: firewallHint(opts.port, addresses[0]?.subnet ?? null, opts.which),
    ...(opts.includeToken && opts.token ? { token: opts.token } : {}),
  };
}
