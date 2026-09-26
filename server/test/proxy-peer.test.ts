// The rules that decide who a request is from once `tailscale serve` is in
// front of the port.
//
// The bug these lock down: tailscaled terminates TLS and re-dials 127.0.0.1, so
// every phone on the tailnet arrived as loopback. `POST /ingest` through the
// HTTPS name answered 400 — a schema complaint, i.e. it was already through the
// gate — while the same call to the raw tailnet IP answered 401. The device
// list was empty for those phones and Block could not touch them.
//
// The obvious fix (read X-Forwarded-For) is a worse bug, so most of what is
// asserted here is the *refusals*.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePeer, originOf, tailnetAddress, type Peer } from "../src/net.ts";
import { proxiedByTailscaled, __resetProxyProbe, __setProcNetFiles, __trustProxyUid } from "../src/remote.ts";

const H = (h: Record<string, string>) => new Headers(h);

const peer = (socketAddress: string | null, headers: Record<string, string>, proxied: boolean): Peer =>
  resolvePeer({ socketAddress, headers: H(headers), proxied });

describe("tailnetAddress", () => {
  it("accepts the two ranges a tailnet node actually answers on", () => {
    // Both ranges taken from a live `tailscale status --json`: a node answers
    // on one address in each.
    expect(tailnetAddress("100.101.102.103")).toBe(true);
    expect(tailnetAddress("fd7a:115c:a1e0::1a2b:3c4d")).toBe(true);
  });

  it("rejects everything that merely looks close", () => {
    expect(tailnetAddress("100.63.0.1")).toBe(false); // below the CGNAT range
    expect(tailnetAddress("100.128.0.1")).toBe(false); // above it
    expect(tailnetAddress("192.168.1.5")).toBe(false);
    expect(tailnetAddress("127.0.0.1")).toBe(false);
    expect(tailnetAddress("fd00::1")).toBe(false); // ULA, but not Tailscale's
    expect(tailnetAddress("100.101.102.103.evil.com")).toBe(false); // a name, not an address
  });
});

describe("resolvePeer — the local sender must keep working", () => {
  it("leaves a plain loopback caller alone: this is his hooks", () => {
    const p = peer("127.0.0.1", {}, false);
    expect(p).toEqual({ address: "127.0.0.1", source: "socket" });
    expect(originOf(p)).toBe("loopback");
  });

  it("ignores forged headers from an unverified loopback caller", () => {
    // A local process can set every one of these. Because nothing verified a
    // proxy, none of them is read, so it stays exactly as local as it was —
    // no better, no worse.
    const p = peer("127.0.0.1", {
      "x-forwarded-for": "100.99.99.99",
      "tailscale-user-login": "attacker@evil.example",
      "tailscale-headers-info": "https://tailscale.com/s/serve-headers",
    }, false);
    expect(p).toEqual({ address: "127.0.0.1", source: "socket" });
    expect(originOf(p)).toBe("loopback");
  });
});

describe("resolvePeer — nothing may claim to be local", () => {
  it("refuses to promote a LAN caller that forges loopback", () => {
    // The whole reason the header is only consulted for a loopback socket. On a
    // 0.0.0.0 bind this is the attack the naive fix would have created.
    const p = peer("192.168.1.77", { "x-forwarded-for": "127.0.0.1" }, false);
    expect(p).toEqual({ address: "192.168.1.77", source: "socket" });
    expect(originOf(p)).toBe("remote");
  });

  it("refuses even when the proxy check somehow passed for a non-loopback socket", () => {
    const p = peer("192.168.1.77", { "x-forwarded-for": "127.0.0.1" }, true);
    expect(p.address).toBe("192.168.1.77");
    expect(originOf(p)).toBe("remote");
  });

  it("keeps a proxied request remote even when the forwarded address is loopback", () => {
    // originOf does not look at the address for a proxied request, on purpose:
    // that address is attacker-adjacent and this is the line that opens the
    // tokenless intake sinks.
    const p = peer("127.0.0.1", { "x-forwarded-for": "127.0.0.1" }, true);
    expect(p.source).toBe("proxy");
    expect(originOf(p)).toBe("remote");
  });
});

describe("resolvePeer — a verified proxy speaks for its peer", () => {
  it("attributes the request to the tailnet peer, v4", () => {
    const p = peer("127.0.0.1", { "x-forwarded-for": "100.101.102.103" }, true);
    expect(p).toEqual({ address: "100.101.102.103", source: "proxy" });
    expect(originOf(p)).toBe("remote");
  });

  it("attributes the request to the tailnet peer, v6", () => {
    // Measured: a client reaching serve over IPv6 arrives with the bare
    // address, no brackets and no port.
    const p = peer("127.0.0.1", { "x-forwarded-for": "fd7a:115c:a1e0::1a2b:3c4d" }, true);
    expect(p.address).toBe("fd7a:115c:a1e0::1a2b:3c4d");
    expect(p.source).toBe("proxy");
  });
});

describe("resolvePeer — fails closed rather than guessing", () => {
  it("discards a comma list instead of picking an end of it", () => {
    // "first entry is authoritative" and "last entry is authoritative" give
    // opposite code, and neither is right: tailscaled REPLACES the header. Two
    // forged entries sent through a real serve arrived as the single peer
    // address, both forgeries gone. So a list means somebody else wrote this.
    const p = peer("127.0.0.1", { "x-forwarded-for": "127.0.0.1, 100.101.102.103" }, true);
    expect(p).toEqual({ address: null, source: "proxy" });
    expect(originOf(p)).toBe("remote");
  });

  it("stays remote with no forwarded address at all", () => {
    // This is the Funnel-shaped case. Falling back to the socket address here
    // would hand the open internet the loopback exemption.
    const p = peer("127.0.0.1", { "tailscale-headers-info": "x" }, true);
    expect(p).toEqual({ address: null, source: "proxy" });
    expect(originOf(p)).toBe("remote");
  });

  it("stays remote for a forwarded value that is not an address", () => {
    const p = peer("127.0.0.1", { "x-forwarded-for": "localhost" }, true);
    expect(p.address).toBeNull();
    expect(originOf(p)).toBe("remote");
  });

  it("treats a public address from a proxy as remote, not as a parse failure", () => {
    // Funnel with the header intact: a real public IP. Remote is correct.
    const p = peer("127.0.0.1", { "x-forwarded-for": "203.0.113.7" }, true);
    expect(p).toEqual({ address: "203.0.113.7", source: "proxy" });
    expect(originOf(p)).toBe("remote");
  });
});

describe("proxiedByTailscaled — his own requests stay loopback", () => {
  it("says no for a real header-less request from this user", () => {
    // His hooks: a fresh connection, no forwarding header, his own uid. They
    // must never stop being loopback, whether or not tailscaled is installed.
    if (process.platform !== "linux") return;
    __resetProxyProbe();
    const srv = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req, s) => new Response(String(proxiedByTailscaled(s.requestIP(req), s.port!, req.headers))),
    });
    return fetch(`http://127.0.0.1:${srv.port}/`)
      .then((r) => r.text())
      .then((t) => expect(t).toBe("false"))
      .finally(() => srv.stop(true));
  });

  it("says no for a socket peer that is not loopback", () => {
    __resetProxyProbe();
    expect(
      proxiedByTailscaled({ address: "192.168.1.77", port: 12345 }, 4000, H({ "x-forwarded-for": "127.0.0.1" }))
    ).toBe(false);
  });

  it("says no for a loopback socket owned by this user rather than tailscaled", () => {
    // The measurement this encodes: the same headers through a real serve came
    // off a socket with uid 0, and forged straight at the port came off one
    // with uid 1000. A process cannot choose the uid recorded against its own
    // socket, which is why this is the decision and the headers are not.
    //
    // Only meaningful where /proc exists; elsewhere there is nothing to consult
    // and the documented fallback (believe the header, which can only downgrade
    // a caller from loopback to remote) applies instead.
    if (process.platform !== "linux") return;
    __resetProxyProbe();
    const srv = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req, s) => {
        const p = s.requestIP(req);
        return new Response(String(proxiedByTailscaled(p, s.port!, req.headers)));
      },
    });
    return fetch(`http://127.0.0.1:${srv.port}/`, {
      headers: { "x-forwarded-for": "100.101.102.103" },
    })
      .then((r) => r.text())
      .then((t) => {
        expect(t).toBe("false");
      })
      .finally(() => srv.stop(true));
  });
});

describe("proxiedByTailscaled — a raw TCP forward carries no header", () => {
  // `tailscale serve --tcp` (and --tls-terminated-tcp) re-dials 127.0.0.1 and
  // adds nothing to the bytes, so a header trigger never fires and the socket
  // alone said "loopback": a tailnet peer reached the tokenless sinks, and on a
  // hand-started server with no token, everything. The uid that owns the
  // connecting socket is what tells the two apart, header or not.
  //
  // /proc is faked with a fixture so the test can say "tailscaled owns this
  // socket" without root and without Tailscale. The fixture uid is never this
  // process's own: a CI container runs as root, and a tailscaled that shares
  // our uid is a case the code refuses to decide on (see below).
  const ours = 4000;
  const peerPort = 51234;
  const hex = (n: number) => n.toString(16).toUpperCase().padStart(4, "0");
  const me = typeof process.getuid === "function" ? process.getuid() : 1000;
  const daemon = me + 1;
  const row = (uid: number, st = "01") =>
    `   0: 0100007F:${hex(peerPort)} 0100007F:${hex(ours)} ${st} 00000000:00000000 00:00000000 00000000  ${uid}        0 4242 1 0000000000000000 20 4 30 10 -1`;
  const header = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
  let dir = "";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "agx-procnet-"));
  });
  afterAll(() => {
    __setProcNetFiles(null);
    __resetProxyProbe();
    rmSync(dir, { recursive: true, force: true });
  });
  const fake = (body: string) => {
    const f = join(dir, `tcp-${Math.random().toString(36).slice(2)}`);
    writeFileSync(f, header + "\n" + body + "\n");
    __resetProxyProbe();
    __setProcNetFiles([f]);
  };

  it("treats a header-less loopback socket owned by tailscaled as proxied, so not loopback", () => {
    fake(row(daemon));
    __trustProxyUid(daemon);
    const proxied = proxiedByTailscaled({ address: "127.0.0.1", port: peerPort }, ours, H({}));
    expect(proxied).toBe(true);
    // And what that means for the caller: no forwarded address, never loopback.
    const p = resolvePeer({ socketAddress: "127.0.0.1", headers: H({}), proxied });
    expect(originOf(p)).not.toBe("loopback");
  });

  it("keeps a header-less loopback socket owned by this user as loopback", () => {
    // His hooks: same shape, his own uid. They must stay local.
    fake(row(me));
    __trustProxyUid(daemon);
    expect(proxiedByTailscaled({ address: "127.0.0.1", port: peerPort }, ours, H({}))).toBe(false);
  });

  it("treats a half-closed socket owned by tailscaled as proxied", () => {
    // A forward that sends and then half-closes is FIN_WAIT1 (04) by the time
    // the handler runs, with its owner still on the row.
    fake(row(daemon, "04"));
    __trustProxyUid(daemon);
    expect(proxiedByTailscaled({ address: "127.0.0.1", port: peerPort }, ours, H({}))).toBe(true);
    fake(row(daemon, "05"));
    __trustProxyUid(daemon);
    expect(proxiedByTailscaled({ address: "127.0.0.1", port: peerPort }, ours, H({}))).toBe(true);
  });

  it("keeps a half-closed socket owned by this user as loopback", () => {
    // The other side of reading FIN_WAIT rows: a hook that half-closes is
    // found, and so is not failed closed as a socket nobody owns.
    fake(row(me, "04"));
    __trustProxyUid(daemon);
    expect(proxiedByTailscaled({ address: "127.0.0.1", port: peerPort }, ours, H({}))).toBe(false);
  });

  it("fails closed when a readable table has no row for the connection", () => {
    // tailscaled is present under another uid and the socket cannot be found
    // even after a fresh read: not loopback. Only a TIME_WAIT row, which is
    // ignored, is left for the port.
    fake(row(me, "06"));
    __trustProxyUid(daemon);
    expect(proxiedByTailscaled({ address: "127.0.0.1", port: peerPort }, ours, H({}))).toBe(true);
  });

  it("keeps a header-less socket as loopback where there is no socket table at all", () => {
    __resetProxyProbe();
    __setProcNetFiles([join(dir, "no-such-table")]);
    __trustProxyUid(daemon);
    expect(proxiedByTailscaled({ address: "127.0.0.1", port: peerPort }, ours, H({}))).toBe(false);
  });

  it("refuses to decide from the uid alone when tailscaled runs as this user", () => {
    // Then every local process has tailscaled's uid and the socket owner says
    // nothing; only the header trigger is left, as before.
    fake(row(me));
    __trustProxyUid(me);
    expect(proxiedByTailscaled({ address: "127.0.0.1", port: peerPort }, ours, H({}))).toBe(false);
  });
});
