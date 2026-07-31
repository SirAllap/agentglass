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
 */
let tailnet: { names: Set<string>; https: { name: string; url: string } | null } = { names: new Set(), https: null };
export function tailnetNames(): ReadonlySet<string> { return tailnet.names; }

async function tsCmd(args: string[]): Promise<string | null> {
  const bin = Bun.which("tailscale");
  if (!bin) return null;
  try {
    const p = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return p.exitCode === 0 ? out : null;
  } catch { return null; }
}

/** Read the tailnet name and whether serve is fronting our port. Cheap, and it
 *  fails soft: no Tailscale, or serve not set up, just leaves nothing offered. */
export async function refreshTailscale(port: number): Promise<void> {
  const statusOut = await tsCmd(["status", "--json"]);
  const names = new Set<string>();
  let self = "";
  if (statusOut) {
    try {
      const dns = JSON.parse(statusOut)?.Self?.DNSName;
      if (typeof dns === "string" && dns) { self = dns.replace(/\.$/, "").toLowerCase(); names.add(self); }
    } catch { /* not JSON we recognise */ }
  }
  let https: { name: string; url: string } | null = null;
  const serveOut = self ? await tsCmd(["serve", "status", "--json"]) : null;
  if (serveOut) {
    try {
      const web = JSON.parse(serveOut)?.Web ?? {};
      const hits = `:${port}`;
      for (const [hostPort, cfg] of Object.entries(web)) {
        const handlers = (cfg as { Handlers?: Record<string, { Proxy?: string }> })?.Handlers ?? {};
        const proxiesUs = Object.values(handlers).some((h) => typeof h?.Proxy === "string" && h.Proxy.includes(hits));
        if (proxiesUs) { const name = hostPort.replace(/:\d+$/, "").toLowerCase(); https = { name, url: `https://${name}/` }; break; }
      }
    } catch { /* serve status shape changed — offer nothing rather than guess */ }
  }
  tailnet = { names, https };
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
  };
}
