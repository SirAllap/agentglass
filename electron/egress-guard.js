// The boundary between the browser and the network: where a name becomes an
// address, and the one place the URL policy can be held at connect time.
//
// `safeUrl` in server/src/browserdrive.ts judges the LITERAL host of a URL
// before it is handed to the browser: link-local (169.254/16, where the cloud
// metadata endpoint lives, and fe80::/10) and the unspecified address are
// refused; loopback and the private ranges are deliberately allowed, because a
// dev server on this machine or a box on the LAN is ordinary use. A hostname
// passed through untouched, with a note that resolving it there would be a
// race nobody wins — and it would: the browser resolves the name again when it
// connects, and a name is free to answer differently the second time. That is
// DNS rebinding, in two shapes. A name that answers 169.254.169.254 from the
// start is a metadata read wearing a hostname. A name that answers a public
// address while the policy looks, and a loopback or LAN one when the page's
// own script fetches it a minute later, is a page reaching a service on this
// machine under an origin that service trusts.
//
// Both close only where the address is USED, so this module is the network
// step: a forward proxy on a loopback port that every browser session is
// pointed at. Each connection resolves its name once, judges every address the
// name answered, and opens the socket to the address it judged — there is no
// second resolution for a flip to land in. HTTPS is a CONNECT tunnel, the TLS
// inside it untouched; plain HTTP is forwarded one request per connection.
//
// The rules, in the order a connection meets them:
//   - a literal address is judged as it is, and never pinned: it IS the answer.
//   - a name that does not resolve is refused — the connection would fail
//     anyway, and this way the reason is said.
//   - any answer that is link-local or unspecified refuses the whole name: a
//     name with one public record and one link-local one is a name whose owner
//     wants the second used.
//   - an answer set that mixes a public address with a private one (loopback,
//     RFC1918, CGNAT, unique-local) refuses the whole name. That is
//     multiple-A-record rebinding: the page loads from the public address,
//     that port closes, and the next connection falls through to 127.0.0.1
//     under the same origin. The first version pinned such a name private and
//     tried the addresses in order, which is exactly that.
//   - a name is remembered by class, and "public" is sticky: a name that has
//     EVER answered public is public from then on, and a private answer for
//     it is refused. That is the rebinding shape. The first version pinned the
//     FIRST answer only, so a page could pre-pin its name private with one
//     early request, answer public for the attack page, then answer loopback,
//     and every step passed. A name that has only ever answered private stays
//     allowed — `myapp.test` in a hosts file, a LAN box, a tailnet name —
//     which is what keeps local development working without an allow-list.
//     A private name that moves to a public address is fine (a dev box that
//     grew a public name); it is the way back that is refused.
//   - only public names are remembered, and a pin is never evicted. A private
//     answer needs no memory: judged fresh every time, it is allowed every
//     time, and the moment the name answers public it is pinned. The first
//     version remembered both classes and evicted FIFO, so a page could
//     request N fresh subdomains, push its own public pin off the front, and
//     be pinned fresh as private. The memory is bounded, and when it is full
//     a NEW public name is refused with the reason: a page grinding through
//     hostnames gets a loud refusal of new names, never a silent hole; names
//     already pinned, and every private name, keep working. The memory lasts
//     as long as the app does.
//
// What this cannot do, written down so a gap is not read as a choice:
//   - Chromium sends localhost, 127/8, ::1 and link-local LITERALS straight to
//     the network, never to a proxy. Loopback literals are allowed anyway;
//     link-local ones are refused by `literalRefusal` on the session's request
//     hook, which sees the URL and cancels the request.
//   - a proxy the operator sets on the session replaces this one, and with an
//     upstream proxy the name is resolved there: the pin is off while it is set,
//     and the session verb says so.
//   - a laptop whose VPN turns a public name private mid-session meets the
//     rebinding rule, because from here the two are the same event. The
//     refusal names the way out: a restart, or AGENTGLASS_BROWSER_EGRESS=off.
//   - there is no authentication on the port. It answers loopback only, and
//     everything it does is refuse: a process on this machine that can reach
//     it can reach the network directly and gain nothing by going through.
//
// CommonJS with no dependencies, like guest-guard.js and for the same reason:
// main.js requires it, and web/test/browser-egress-guard.test.ts loads it
// under bun and runs the proxy against real sockets without Electron. Keep it
// in `build.files` in package.json — left out of the asar, the app does not
// start.
"use strict";
const net = require("node:net");
const dns = require("node:dns");

const EGRESS_ENV = "AGENTGLASS_BROWSER_EGRESS";
const STATUS_TEXT = { 400: "Bad Request", 403: "Forbidden", 408: "Request Timeout", 431: "Request Header Fields Too Large", 502: "Bad Gateway" };
const HEAD_CAP = 64 * 1024;
const REFUSALS_KEPT = 50;
/* Public names remembered. A pin is never evicted, so this is also how many
   distinct public names a session may meet before new ones are refused:
   100k pins is a few megabytes, and more names than a person meets in a
   session by orders of magnitude. */
const MAX_REMEMBERED = 100_000;

/** The eight 16-bit groups of a valid IPv6 address (isIP has already said v6),
 *  with `::` expanded and a trailing dotted-quad folded into two groups. */
function ipv6Groups(h) {
  let s = h;
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const q = tail.split(".").map((n) => parseInt(n, 10) & 0xff);
    s = s.slice(0, lastColon + 1) + ((q[0] << 8) | q[1]).toString(16) + ":" + ((q[2] << 8) | q[3]).toString(16);
  }
  const [left, right] = s.split("::");
  const head = left ? left.split(":") : [];
  const rear = right !== undefined ? (right ? right.split(":") : []) : [];
  const gap = right !== undefined ? 8 - head.length - rear.length : 0;
  return [...head, ...Array(Math.max(gap, 0)).fill("0"), ...rear].map((g) => parseInt(g, 16));
}

const v4At = (g, i) => `${g[i] >> 8}.${g[i] & 0xff}.${g[i + 1] >> 8}.${g[i + 1] & 0xff}`;

/** The v4 address a v6 one carries in its low bits, when its prefix says it
 *  carries one: IPv4-mapped (::ffff:0:0/96), the deprecated IPv4-compatible
 *  form (::/96), NAT64 (64:ff9b::/96) and 6to4 (2002::/16). Folded ONLY when
 *  the prefix matches, so a global address whose low bits merely resemble
 *  169.254.x.x is not judged as it. */
function embeddedV4(h) {
  const g = ipv6Groups(h);
  const zero5 = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0;
  if (zero5 && (g[5] === 0xffff || g[5] === 0)) return v4At(g, 6);
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) return v4At(g, 6);
  if (g[0] === 0x2002) return v4At(g, 1);
  return null;
}

const strip = (h) => String(h || "").replace(/^\[|\]$/g, "").toLowerCase();

/** Why an address may not be connected to at all, or null. The same rule as
 *  `safeUrl`'s, so a name is held to exactly what a literal is held to. */
function blockedAddress(ipRaw) {
  const ip = strip(ipRaw);
  const v = net.isIP(ip);
  if (v === 4) {
    if (ip === "0.0.0.0") return "the unspecified address";
    const [a, b] = ip.split(".").map(Number);
    return a === 169 && b === 254 ? "link-local (where cloud metadata lives)" : null;
  }
  if (v === 6) {
    if (ip === "::") return "the unspecified address";
    if (/^fe[89ab]/.test(ip)) return "link-local";
    const inner = embeddedV4(ip);
    return inner ? blockedAddress(inner) : null;
  }
  return null;
}

/** Loopback, RFC1918, CGNAT, unique-local, and 0/8: the class a name is
 *  pinned to when it first answers one of these. Not a refusal on its own. */
function privateAddress(ipRaw) {
  const ip = strip(ipRaw);
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (v === 6) {
    if (ip === "::1" || ip === "::") return true;
    if (/^f[cd]/.test(ip)) return true;
    const inner = embeddedV4(ip);
    return inner ? privateAddress(inner) : false;
  }
  return false;
}

/** For the session's request hook: a literal host the proxy will never see,
 *  because Chromium bypasses proxies for it. Null for a hostname — that one
 *  reaches the proxy and is judged there. */
function literalRefusal(url) {
  let host;
  try { host = new URL(String(url)).hostname; } catch { return null; }
  const ip = strip(host);
  if (!net.isIP(ip)) return null;
  const why = blockedAddress(ip);
  return why ? `${ip} is ${why}` : null;
}

/**
 * The resolver with the policy in it. `lookup` and `remember` are injectable
 * for the test: a resolver that answers what the test says, and a memory it
 * can read.
 */
function createResolver(opts = {}) {
  const lookup = opts.lookup || ((h) => dns.promises.lookup(h, { all: true, verbatim: true }));
  const remember = opts.remember || new Map();
  const maxRemembered = opts.maxRemembered || MAX_REMEMBERED;
  return async function resolve(hostRaw) {
    const host = strip(hostRaw);
    if (!host) return { ok: false, reason: "no host" };
    const literal = net.isIP(host);
    if (literal) {
      const why = blockedAddress(host);
      return why ? { ok: false, reason: `${host} is ${why}` } : { ok: true, addresses: [host] };
    }
    let answers;
    try { answers = await lookup(host); } catch { answers = []; }
    if (!Array.isArray(answers) || answers.length === 0) return { ok: false, reason: `${host} does not resolve` };
    for (const a of answers) {
      const why = blockedAddress(a.address);
      if (why) return { ok: false, reason: `${host} resolves to ${a.address}, which is ${why}` };
    }
    const priv = answers.find((a) => privateAddress(a.address));
    const pub = answers.find((a) => !privateAddress(a.address));
    if (priv && pub) {
      return {
        ok: false,
        reason: `${host} answers both a public address (${pub.address}) and a private or loopback one (${priv.address}) — `
          + "a name whose owner wants the second reached under the first's origin, the multiple-record shape of DNS rebinding, refused.",
      };
    }
    const pinnedPublic = remember.get(host) === "public";
    if (priv && pinnedPublic) {
      return {
        ok: false,
        reason: `${host} answered a public address earlier in this session and now answers ${priv.address}, `
          + "a private or loopback one — the shape of DNS rebinding, refused. If the name really moved (a VPN that came up, "
          + `a hosts file edit), restart the app, or set ${EGRESS_ENV}=off.`,
      };
    }
    if (!priv && !pinnedPublic) {
      if (remember.size >= maxRemembered) {
        return {
          ok: false,
          reason: `${host} is a public name this session has not met, and the egress guard's memory of names is full (${maxRemembered}) — `
            + "the shape of a page grinding through hostnames to push its own out. Names already met still work; "
            + `for new ones, restart the app, or set ${EGRESS_ENV}=off.`,
        };
      }
      remember.set(host, "public");
    }
    /* IPv4 first, whatever order the resolver used: the proxy tries these in
       turn, and a v6 answer on a network with no v6 route is a wait for a
       timeout before the v4 one that would have worked. */
    const v4 = answers.filter((a) => net.isIP(a.address) === 4).map((a) => a.address);
    const v6 = answers.filter((a) => net.isIP(a.address) === 6).map((a) => a.address);
    return { ok: true, addresses: [...v4, ...v6] };
  };
}

/** `host:port` as CONNECT writes it, brackets and all. */
function splitHostPort(target, defaultPort) {
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(String(target || ""));
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : defaultPort;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host: m[1], port };
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const headerSafe = (s) => String(s).replace(/[\r\n]+/g, " ").slice(0, 500);

/**
 * The proxy. Resolves with `{ port, close, refusals, refuse }` once it is
 * listening. `resolve` and `connect` are injectable for the test — a resolver
 * with scripted answers, and a connect that can be counted.
 */
function startEgressProxy(opts = {}) {
  const resolve = opts.resolve || createResolver();
  const connect = opts.connect || ((o) => net.connect(o));
  const bindHost = opts.host || "127.0.0.1";
  const headTimeoutMs = opts.headTimeoutMs || 10_000;
  const connectTimeoutMs = opts.connectTimeoutMs || 10_000;
  const log = opts.log || (() => {});
  const refused = [];
  const refuse = (host, reason) => {
    refused.push({ at: Date.now(), host: strip(host), reason: String(reason) });
    if (refused.length > REFUSALS_KEPT) refused.shift();
    log(`[egress] refused ${host}: ${reason}`);
  };

  /** A response of our own, and the end of the connection. For a refused
   *  CONNECT the browser discards the body and reports a tunnel failure; for
   *  refused plain http the body IS the page the browser shows, so it says
   *  what happened in words a person or an agent can act on. */
  const reply = (client, status, text, reason) => {
    const body = `<!doctype html><meta charset="utf-8"><title>${status} ${STATUS_TEXT[status] || ""}</title><p>${escapeHtml(text)}</p>\n`;
    const head = `HTTP/1.1 ${status} ${STATUS_TEXT[status] || "Refused"}\r\n`
      + "Content-Type: text/html; charset=utf-8\r\n"
      + `Content-Length: ${Buffer.byteLength(body)}\r\n`
      + (reason ? `X-Agentglass-Egress: ${headerSafe(reason)}\r\n` : "")
      + "Connection: close\r\n\r\n";
    client.end(head + body);
  };

  /** Open a socket to the first address that answers, in order — and never
   *  to one of a different class than the first: the resolver refuses a
   *  mixed set, and if one ever reached here the fall-through from a public
   *  address to a private one is the attack itself, so the list ends there. */
  const connectAny = (addresses, port) => new Promise((done, fail) => {
    let i = 0;
    const firstPrivate = addresses.length ? privateAddress(addresses[0]) : false;
    const next = (lastErr) => {
      if (i >= addresses.length) return fail(lastErr || new Error("no address to connect to"));
      const host = addresses[i++];
      if (privateAddress(host) !== firstPrivate) return fail(lastErr || new Error(`${host} is not of the class the name was judged as`));
      let settled = false;
      const sock = connect({ host, port });
      const timer = setTimeout(() => { if (!settled) { settled = true; sock.destroy(); next(new Error(`${host}: connect timed out`)); } }, connectTimeoutMs);
      sock.once("connect", () => { if (settled) return; settled = true; clearTimeout(timer); done(sock); });
      sock.once("error", (e) => { if (settled) return; settled = true; clearTimeout(timer); next(e); });
    };
    next(null);
  });

  const tunnel = (client, upstream, rest, banner) => {
    client.setTimeout(0);
    upstream.setNoDelay(true);
    if (banner) client.write(banner);
    if (rest.length) upstream.write(rest);
    client.pipe(upstream);
    upstream.pipe(client);
    const drop = () => { client.destroy(); upstream.destroy(); };
    client.on("error", drop);
    upstream.on("error", drop);
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  };

  const handle = async (client, head, rest) => {
    const lines = head.split("\r\n");
    const [method, target, version] = (lines[0] || "").split(" ");
    if (!method || !target || !/^HTTP\/1\.[01]$/.test(version || "")) return reply(client, 400, "this port is the browser's egress guard, not a web server");
    if (method === "CONNECT") {
      const hp = splitHostPort(target, 443);
      if (!hp) return reply(client, 400, `CONNECT ${target} is not host:port`);
      const r = await resolve(hp.host);
      if (!r.ok) { refuse(hp.host, r.reason); return reply(client, 403, `The built-in browser did not connect to ${strip(hp.host)}: ${r.reason}`, r.reason); }
      let upstream;
      try { upstream = await connectAny(r.addresses, hp.port); }
      catch (e) { return reply(client, 502, `${strip(hp.host)}:${hp.port} did not accept the connection: ${e && e.message ? e.message : e}`); }
      return tunnel(client, upstream, rest, "HTTP/1.1 200 Connection Established\r\n\r\n");
    }
    let url;
    try { url = new URL(target); } catch { return reply(client, 400, "this port is the browser's egress guard, not a web server"); }
    if (url.protocol !== "http:") return reply(client, 400, `${url.protocol} is not forwarded as plain text — https goes through CONNECT`);
    const port = url.port ? Number(url.port) : 80;
    const r = await resolve(url.hostname);
    if (!r.ok) { refuse(url.hostname, r.reason); return reply(client, 403, `The built-in browser did not connect to ${strip(url.hostname)}: ${r.reason}`, r.reason); }
    let upstream;
    try { upstream = await connectAny(r.addresses, port); }
    catch (e) { return reply(client, 502, `${strip(url.hostname)}:${port} did not accept the connection: ${e && e.message ? e.message : e}`); }
    /* Origin-form for the server, the proxy's own headers dropped, and one
       request per connection: `Connection: close` is what makes the browser
       open a fresh connection for the next request instead of reusing this
       one for a different host, which an HTTP/1.1 proxy would otherwise have
       to parse its way through. */
    const out = [`${method} ${url.pathname}${url.search} ${version}`];
    let sawHost = false;
    /* An Upgrade handshake needs its own Connection header, and after it
       the connection is a tunnel anyway — one per connection holds by
       itself, so that one is forwarded as written. */
    const upgrade = lines.some((line) => /^upgrade\s*:/i.test(line));
    for (const line of lines.slice(1)) {
      const key = line.slice(0, line.indexOf(":")).trim().toLowerCase();
      if (key === "proxy-connection" || key === "proxy-authorization" || key === "keep-alive") continue;
      if (key === "connection" && !upgrade) continue;
      if (key === "host") sawHost = true;
      out.push(line);
    }
    if (!sawHost) out.push(`Host: ${url.host}`);
    if (!upgrade) out.push("Connection: close");
    return tunnel(client, upstream, Buffer.concat([Buffer.from(out.join("\r\n") + "\r\n\r\n", "latin1"), rest]), null);
  };

  const server = net.createServer((client) => {
    client.setNoDelay(true);
    client.on("error", () => { /* a browser that went away mid-handshake */ });
    let buf = Buffer.alloc(0);
    let got = false;
    const headTimer = setTimeout(() => { if (!got) { got = true; reply(client, 408, "no request arrived"); } }, headTimeoutMs);
    const onData = (chunk) => {
      if (got) return;
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end === -1) {
        if (buf.length > HEAD_CAP) { got = true; clearTimeout(headTimer); reply(client, 431, "request head too large"); }
        return;
      }
      got = true;
      clearTimeout(headTimer);
      client.removeListener("data", onData);
      const head = buf.subarray(0, end).toString("latin1");
      const rest = buf.subarray(end + 4);
      handle(client, head, rest).catch((e) => {
        log(`[egress] ${e && e.message ? e.message : e}`);
        try { reply(client, 502, "the egress guard failed on this request"); } catch { /* already gone */ }
      });
    };
    client.on("data", onData);
    client.on("close", () => clearTimeout(headTimer));
  });

  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(opts.port || 0, bindHost, () => {
      const { port } = server.address();
      done({
        port,
        proxyRules: `${bindHost}:${port}`,
        close: () => server.close(),
        refusals: () => refused.slice(),
        refuse,
      });
    });
  });
}

module.exports = { EGRESS_ENV, blockedAddress, privateAddress, literalRefusal, createResolver, startEgressProxy, splitHostPort };
