/*
 * The browser's egress guard: the URL policy held where the address is used.
 *
 * `safeUrl` on the server judges the literal host of a URL once, before it is
 * handed to the browser. A hostname passes it, and the browser resolves the
 * name again when it connects — so a name that answered a public address at
 * the check and 169.254.169.254, or 127.0.0.1, at the connect was a policy
 * that held on paper. The guard is a forward proxy every browser session is
 * pointed at: one resolution per connection, every answer judged, and the
 * socket opened to the address that was judged. It is run here for real,
 * against real sockets and a fake resolver, because the whole claim is about
 * which address a socket is opened to.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import net from "node:net";

/* `createRequire` for the same reason web/test/browser-guest-guard.test.ts
   gives: the shell is CommonJS with no build step, and this directory's
   tsconfig has no allowJs. */
const load = createRequire(import.meta.url);
type Answer = { address: string; family: number };
type Resolved = { ok: true; addresses: string[] } | { ok: false; reason: string };
const guard: {
  EGRESS_ENV: string;
  blockedAddress: (ip: string) => string | null;
  privateAddress: (ip: string) => boolean;
  literalRefusal: (url: string) => string | null;
  createResolver: (opts?: { lookup?: (host: string) => Promise<Answer[]>; remember?: Map<string, string>; maxRemembered?: number }) => (host: string) => Promise<Resolved>;
  startEgressProxy: (opts?: {
    resolve?: (host: string) => Promise<Resolved>;
    connect?: (o: { host: string; port: number }) => net.Socket;
    headTimeoutMs?: number;
  }) => Promise<{ port: number; close: () => void; refusals: () => { at: number; host: string; reason: string }[]; refuse: (host: string, reason: string) => void }>;
} = load("../../electron/egress-guard.js");

describe("what an address is", () => {
  test("link-local and unspecified are refused, in every spelling that reaches them", () => {
    for (const ip of [
      "169.254.169.254", "169.254.0.1", "0.0.0.0",
      "fe80::1", "fe9f::1", "::",
      "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", // IPv4-mapped, both spellings
      "::169.254.169.254",                          // deprecated IPv4-compatible
      "64:ff9b::a9fe:a9fe", "64:ff9b::169.254.169.254", // NAT64
      "2002:a9fe:a9fe::",                            // 6to4
    ]) expect(guard.blockedAddress(ip), ip).not.toBeNull();
  });

  test("loopback, the private ranges and the public internet are not — that is the pinning rule's job", () => {
    for (const ip of ["127.0.0.1", "10.0.0.1", "172.16.5.5", "192.168.1.1", "100.64.0.1", "::1", "fd00::1", "::ffff:127.0.0.1",
      "93.184.216.34", "2001:db8::1", "2001:db8::a9fe:a9fe", "64:ff9b:1::a9fe:a9fe"]) {
      expect(guard.blockedAddress(ip), ip).toBeNull();
    }
  });

  test("private is loopback, RFC1918, CGNAT and unique-local, mapped forms included", () => {
    for (const ip of ["127.0.0.1", "127.8.8.8", "10.1.2.3", "172.31.0.1", "192.168.0.9", "100.127.255.1", "::1", "fc00::1", "fd12::1", "::ffff:10.0.0.1", "0.0.0.0"]) {
      expect(guard.privateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["93.184.216.34", "172.32.0.1", "100.128.0.1", "2001:db8::1", "::ffff:93.184.216.34"]) {
      expect(guard.privateAddress(ip), ip).toBe(false);
    }
  });

  test("a literal link-local host in a URL is refused by name; a hostname is left to the resolver", () => {
    expect(guard.literalRefusal("http://169.254.169.254/latest/meta-data/")).not.toBeNull();
    expect(guard.literalRefusal("http://[fe80::1]/")).not.toBeNull();
    expect(guard.literalRefusal("http://[::ffff:169.254.169.254]/")).not.toBeNull();
    expect(guard.literalRefusal("http://127.0.0.1:4000/")).toBeNull();
    expect(guard.literalRefusal("https://example.com/")).toBeNull();
    expect(guard.literalRefusal("not a url")).toBeNull();
  });
});

describe("the resolver: every answer judged, a mixed set reached only at its public addresses, and a name that ever answered public pinned public", () => {
  const A = (...ips: string[]): Answer[] => ips.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

  test("a name that answers the metadata address is refused, and so is a name that answers it among others", async () => {
    const resolve = guard.createResolver({ lookup: async (h) => (h === "meta.example" ? A("169.254.169.254") : A("93.184.216.34", "169.254.169.254")) });
    const r1 = await resolve("meta.example");
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toMatch(/169\.254\.169\.254/);
    const r2 = await resolve("mixed.example");
    expect(r2.ok).toBe(false);
  });

  test("a name that was private from the start is a dev flow, and stays allowed", async () => {
    const resolve = guard.createResolver({ lookup: async () => A("127.0.0.1") });
    const r = await resolve("myapp.test");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.addresses).toEqual(["127.0.0.1"]);
    expect((await resolve("myapp.test")).ok).toBe(true);
  });

  test("a name met as public that later answers private is the rebinding shape, and is refused by name", async () => {
    let answer = A("93.184.216.34");
    const resolve = guard.createResolver({ lookup: async () => answer });
    expect((await resolve("flip.example")).ok).toBe(true);
    answer = A("127.0.0.1");
    const r = await resolve("flip.example");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/rebinding/);
      expect(r.reason).toContain("127.0.0.1");
      // The way out is named, for the laptop whose VPN just came up.
      expect(r.reason).toContain(guard.EGRESS_ENV);
    }
    answer = A("93.184.216.34");
    expect((await resolve("flip.example")).ok, "public again is public").toBe(true);
    // Case does not make a second name.
    answer = A("10.0.0.7");
    expect((await resolve("FLIP.example")).ok).toBe(false);
  });

  test("private first and public later is not the attack, and is allowed", async () => {
    let answer = A("10.0.0.5");
    const resolve = guard.createResolver({ lookup: async () => answer });
    expect((await resolve("box.example")).ok).toBe(true);
    answer = A("93.184.216.34");
    expect((await resolve("box.example")).ok).toBe(true);
  });

  /* Three shapes the first version let through. Each is the same attack —
     a page's own hostname ending up at a loopback or LAN address under an
     origin that address trusts — wearing a different DNS answer. */

  test("a name that answers a public AND a private address in one set is reached only at the public one: multiple-A-record rebinding", async () => {
    // The first version pinned such a name private (any private answer made
    // the class private) and connected in order: the page loaded from the
    // public address, then that port closed and the next connection fell
    // through to 127.0.0.1 under the same origin. Now the private addresses
    // of a mixed set are never handed to the socket, and the name is public
    // from then on.
    let answer = A("93.184.216.34", "127.0.0.1");
    const resolve = guard.createResolver({ lookup: async () => answer });
    const r = await resolve("both.example");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.addresses).toEqual(["93.184.216.34"]);
    answer = A("127.0.0.1");
    const later = await resolve("both.example");
    expect(later.ok, "and pinned public, so loopback alone next time is the rebinding shape").toBe(false);
  });

  test("a dual-stack LAN box — RFC1918 A record, global AAAA — keeps working, at its global address", async () => {
    // Refusing every mixed set outright broke this ordinary shape, which a
    // home network with IPv6 hands out for its own boxes.
    const resolve = guard.createResolver({ lookup: async () => A("192.168.1.5", "2001:db8::5") });
    const r = await resolve("nas.home.arpa");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.addresses).toEqual(["2001:db8::5"]);
    expect((await resolve("nas.home.arpa")).ok, "the same set twice is the same answer").toBe(true);
  });

  test("a name pinned private first, then public, then private again is refused: pre-pinning", async () => {
    // The page loads <img src=http://rb.evil.example/> while rb answers 10.x
    // (pinned private), then rb answers the public attack page, then
    // 127.0.0.1. The first version kept the first pin, and every step passed.
    // A name that has EVER answered public is public from then on.
    let answer = A("10.0.0.5");
    const resolve = guard.createResolver({ lookup: async () => answer });
    expect((await resolve("rb.example")).ok).toBe(true);
    answer = A("93.184.216.34");
    expect((await resolve("rb.example")).ok, "a dev name that moved to a public address is fine").toBe(true);
    answer = A("127.0.0.1");
    const r = await resolve("rb.example");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/rebinding/);
  });

  test("a public pin is never evicted: a page cannot push its own name out of the memory with fresh names", async () => {
    // With FIFO eviction a page requested N fresh subdomains, its own public
    // pin fell off the front, and the next answer was pinned fresh as
    // private. A pin now stays for the life of the process, and private
    // names take no slot at all.
    const remember = new Map<string, string>();
    let answer = A("93.184.216.34");
    const resolve = guard.createResolver({ lookup: async () => answer, remember, maxRemembered: 4 });
    expect((await resolve("victim.example")).ok).toBe(true);
    // Ten fresh names against four slots: the memory fills and stays full,
    // and the victim's pin is still in it.
    const outcomes = [];
    for (let i = 0; i < 10; i++) outcomes.push((await resolve(`fresh${i}.example`)).ok);
    expect(outcomes.slice(0, 3)).toEqual([true, true, true]);
    expect(outcomes.slice(3).some(Boolean), "no new name after the memory is full").toBe(false);
    expect(remember.size).toBeLessThanOrEqual(4);
    expect(remember.get("victim.example")).toBe("public");
    answer = A("127.0.0.1");
    expect((await resolve("victim.example")).ok, "the pin survived the churn").toBe(false);
    // A private name is not remembered: judged fresh every time, allowed
    // every time, and never in the way of a public pin — so a full memory
    // does not refuse the dev box.
    const priv = new Map<string, string>();
    let a2 = A("10.0.0.5");
    const r2 = guard.createResolver({ lookup: async () => a2, remember: priv, maxRemembered: 2 });
    expect((await r2("dev1.test")).ok).toBe(true);
    expect(priv.has("dev1.test")).toBe(false);
    a2 = A("93.184.216.34");
    expect((await r2("pub0.example")).ok).toBe(true);
    expect((await r2("pub1.example")).ok).toBe(true);
    a2 = A("10.0.0.5");
    expect((await r2("dev1.test")).ok, "full of public pins, a private name still passes").toBe(true);
    expect((await r2("dev2.test")).ok).toBe(true);
    a2 = A("93.184.216.34");
    expect((await r2("dev2.test")).ok, "and a private name that goes public needs a slot").toBe(false);
  });

  test("when the memory is all public pins and full, a NEW name is refused with the reason, not let through unpinned", async () => {
    // The ceiling, said out loud: a page grinding through hostnames can fill
    // the memory, and what it gets for it is a loud refusal of new names,
    // not a silent hole. Names already pinned keep working.
    const remember = new Map<string, string>();
    const resolve = guard.createResolver({ lookup: async () => A("93.184.216.34"), remember, maxRemembered: 3 });
    for (let i = 0; i < 3; i++) expect((await resolve(`p${i}.example`)).ok).toBe(true);
    const r = await resolve("one-more.example");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/memory|full/);
      expect(r.reason).toContain(guard.EGRESS_ENV);
    }
    expect((await resolve("p0.example")).ok, "a pinned name still resolves").toBe(true);
  });

  test("a literal is judged as it is and never looked up", async () => {
    let looked = 0;
    const resolve = guard.createResolver({ lookup: async () => { looked++; return A("93.184.216.34"); } });
    const ok = await resolve("127.0.0.1");
    expect(ok.ok).toBe(true);
    expect((await resolve("[::1]")).ok).toBe(true);
    expect((await resolve("169.254.169.254")).ok).toBe(false);
    expect(looked).toBe(0);
  });

  test("a name that does not resolve is refused with that reason, and an empty host too", async () => {
    const resolve = guard.createResolver({ lookup: async () => { throw new Error("ENOTFOUND"); } });
    const r = await resolve("nx.example");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/does not resolve/);
    expect((await resolve("")).ok).toBe(false);
  });

  test("IPv4 answers are tried before IPv6 ones, whatever order the resolver used", async () => {
    const resolve = guard.createResolver({ lookup: async () => A("2001:db8::1", "93.184.216.34") });
    const r = await resolve("dual.example");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.addresses).toEqual(["93.184.216.34", "2001:db8::1"]);
  });
});

/*
 * The proxy itself, against sockets. A target on loopback that records every
 * request head it receives; a resolver that answers what the test says; and
 * a connect that can be counted, or told to reach the target whatever address
 * it was given — which is how "the first answer was public" is played without
 * a public address to connect to.
 */
describe("the proxy: one resolution per connection, and the socket goes where the judgement went", () => {
  const listen = (srv: net.Server) => new Promise<number>((r) => srv.listen(0, "127.0.0.1", () => r((srv.address() as net.AddressInfo).port)));

  const heads: string[] = [];
  const target = net.createServer((sock) => {
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString("latin1");
      const end = buf.indexOf("\r\n\r\n");
      if (end === -1) return;
      const head = buf.slice(0, end);
      heads.push(head);
      const path = head.split(" ")[1] ?? "/";
      const body = `hello from ${path}`;
      sock.end(`HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    });
  });
  let targetPort = 0;
  let proxy: Awaited<ReturnType<typeof guard.startEgressProxy>>;
  let connects: string[] = [];
  let flipAnswer = ["203.0.113.9"]; // TEST-NET-3: public on paper, reached through the counted connect below

  beforeAll(async () => {
    targetPort = await listen(target);
    proxy = await guard.startEgressProxy({
      resolve: async (host) => {
        if (host === "app.example") return { ok: true, addresses: ["127.0.0.1"] };
        if (host === "flip.example") {
          const r = flipAnswer[0] === "127.0.0.1"
            ? { ok: false as const, reason: "flip.example answered a public address when this session first met it and now answers 127.0.0.1 — the shape of DNS rebinding, refused" }
            : { ok: true as const, addresses: flipAnswer };
          return r;
        }
        if (host === "evil.example") return { ok: false, reason: "evil.example resolves to 169.254.169.254, which is link-local (where cloud metadata lives)" };
        return { ok: false, reason: `${host} does not resolve` };
      },
      /* Every upstream socket lands on the target, whatever address was
         judged: the assertion is about which addresses were ASKED for. */
      connect: (o) => { connects.push(`${o.host}:${o.port}`); return net.connect({ host: "127.0.0.1", port: o.port }); },
      headTimeoutMs: 2000,
    });
  });
  afterAll(() => { proxy.close(); target.close(); });

  /** Speak to the proxy: write, collect until it closes, or until `until` is
   *  satisfied and `then` has been written and collected. */
  function talk(first: string, then?: { after: string; write: string }): Promise<string> {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: "127.0.0.1", port: proxy.port });
      let got = "";
      let wrote = !then;
      sock.on("connect", () => sock.write(first));
      sock.on("data", (d) => {
        got += d.toString("latin1");
        if (!wrote && got.includes(then!.after)) { wrote = true; sock.write(then!.write); }
      });
      sock.on("close", () => resolve(got));
      sock.on("error", reject);
      setTimeout(() => { sock.destroy(); resolve(got); }, 4000);
    });
  }

  test("CONNECT to an allowed name tunnels to the judged address, and the bytes inside are untouched", async () => {
    connects = [];
    const out = await talk(
      `CONNECT app.example:${targetPort} HTTP/1.1\r\nHost: app.example:${targetPort}\r\n\r\n`,
      { after: "\r\n\r\n", write: `GET /tunnel HTTP/1.1\r\nHost: app.example\r\nConnection: close\r\n\r\n` },
    );
    expect(out).toMatch(/^HTTP\/1\.1 200 Connection Established\r\n\r\n/);
    expect(out).toContain("hello from /tunnel");
    expect(connects).toEqual([`127.0.0.1:${targetPort}`]);
    // Inside the tunnel the request arrived exactly as written: no proxy rewrote it.
    expect(heads.at(-1)).toBe("GET /tunnel HTTP/1.1\r\nHost: app.example\r\nConnection: close");
  });

  test("CONNECT to a refused name answers 403 with the reason and opens no socket", async () => {
    connects = [];
    const out = await talk(`CONNECT evil.example:443 HTTP/1.1\r\nHost: evil.example:443\r\n\r\n`);
    expect(out).toMatch(/^HTTP\/1\.1 403 /);
    expect(out).toContain("169.254.169.254");
    expect(connects).toEqual([]);
    const last = proxy.refusals().at(-1);
    expect(last?.host).toBe("evil.example");
    expect(last?.reason).toContain("link-local");
  });

  test("a plain-http request is forwarded one per connection, with the proxy's own headers gone", async () => {
    connects = [];
    const out = await talk(
      `GET http://app.example:${targetPort}/plain?x=1 HTTP/1.1\r\nHost: app.example:${targetPort}\r\nProxy-Connection: keep-alive\r\nAccept: */*\r\n\r\n`,
    );
    expect(out).toMatch(/^HTTP\/1\.1 200 OK/);
    expect(out).toContain("hello from /plain?x=1");
    expect(connects).toEqual([`127.0.0.1:${targetPort}`]);
    const head = heads.at(-1)!;
    expect(head.split("\r\n")[0]).toBe("GET /plain?x=1 HTTP/1.1");
    expect(head).not.toMatch(/proxy-connection/i);
    expect(head).toMatch(/\r\nConnection: close/);
    expect(head).toContain("Accept: */*");
  });

  test("an Upgrade handshake keeps its own Connection header — after it the connection is a tunnel anyway", async () => {
    const out = await talk(
      `GET http://app.example:${targetPort}/socket HTTP/1.1\r\nHost: app.example:${targetPort}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: x\r\n\r\n`,
    );
    expect(out).toContain("hello from /socket");
    const head = heads.at(-1)!;
    expect(head).toMatch(/\r\nConnection: Upgrade/);
    expect(head).toContain("Upgrade: websocket");
    expect(head).not.toMatch(/Connection: close/);
  });

  test("a plain-http request to a refused name gets a page that says why, since a page is what the browser will show", async () => {
    const out = await talk(`GET http://evil.example/ HTTP/1.1\r\nHost: evil.example\r\n\r\n`);
    expect(out).toMatch(/^HTTP\/1\.1 403 /);
    expect(out).toMatch(/text\/html/);
    expect(out).toContain("did not connect to evil.example");
    expect(out).toContain("169.254.169.254");
  });

  test("the rebinding shape, end to end: the second connection to a name that flipped is refused", async () => {
    connects = [];
    flipAnswer = ["203.0.113.9"];
    const first = await talk(
      `CONNECT flip.example:${targetPort} HTTP/1.1\r\nHost: flip.example\r\n\r\n`,
      { after: "\r\n\r\n", write: `GET /first HTTP/1.1\r\nHost: flip.example\r\nConnection: close\r\n\r\n` },
    );
    expect(first).toContain("hello from /first");
    expect(connects).toEqual([`203.0.113.9:${targetPort}`]);
    flipAnswer = ["127.0.0.1"];
    const second = await talk(`CONNECT flip.example:${targetPort} HTTP/1.1\r\nHost: flip.example\r\n\r\n`);
    expect(second).toMatch(/^HTTP\/1\.1 403 /);
    expect(second).toContain("rebinding");
    expect(connects, "no second socket was opened").toEqual([`203.0.113.9:${targetPort}`]);
  });

  test("the socket never falls from a public address to a private one, even if a resolver hands it that list", async () => {
    // Belt to the resolver's braces: the resolver refuses a mixed set, and
    // if one ever reached here the second address would not be tried.
    connects = [];
    const mixed = await guard.startEgressProxy({
      resolve: async () => ({ ok: true, addresses: ["203.0.113.9", "127.0.0.1"] }),
      connect: (o) => { connects.push(`${o.host}:${o.port}`); const s = new net.Socket(); setTimeout(() => s.destroy(new Error("closed")), 10); return s; },
      headTimeoutMs: 2000,
    });
    try {
      const out = await new Promise<string>((resolve, reject) => {
        const sock = net.connect({ host: "127.0.0.1", port: mixed.port });
        let got = "";
        sock.on("connect", () => sock.write(`CONNECT mixed.example:${targetPort} HTTP/1.1\r\nHost: mixed.example\r\n\r\n`));
        sock.on("data", (d) => { got += d.toString("latin1"); });
        sock.on("close", () => resolve(got));
        sock.on("error", reject);
        setTimeout(() => { sock.destroy(); resolve(got); }, 4000);
      });
      expect(out).toMatch(/^HTTP\/1\.1 (502|403) /);
      expect(connects).toEqual([`203.0.113.9:${targetPort}`]);
    } finally {
      mixed.close();
    }
  });

  test("an upstream that refuses the connection is a 502, not a hang", async () => {
    const dead = net.createServer();
    const deadPort = await listen(dead);
    await new Promise<void>((r) => dead.close(() => r()));
    const out = await talk(`CONNECT app.example:${deadPort} HTTP/1.1\r\nHost: app.example\r\n\r\n`);
    expect(out).toMatch(/^HTTP\/1\.1 502 /);
  });

  test("anything that is not a proxy request is a 400 — this port is not a web server", async () => {
    expect(await talk(`GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`)).toMatch(/^HTTP\/1\.1 400 /);
    expect(await talk(`GET https://app.example/ HTTP/1.1\r\nHost: app.example\r\n\r\n`)).toMatch(/^HTTP\/1\.1 400 /);
  });

  test("a connection that never sends a request is closed, not kept", async () => {
    const started = Date.now();
    const out = await talk("");
    expect(out).toMatch(/^HTTP\/1\.1 408 /);
    expect(Date.now() - started).toBeLessThan(3500);
  });

  test("the refusal log is bounded and newest-last, and a refusal can be noted from outside", () => {
    for (let i = 0; i < 60; i++) proxy.refuse(`h${i}.example`, "test");
    const rows = proxy.refusals();
    expect(rows.length).toBe(50);
    expect(rows.at(-1)?.host).toBe("h59.example");
  });
});
