/*
 * What this server may be talked into fetching.
 *
 * Two routes fetch a URL that arrived from outside — the plugin catalogue's
 * `?url=` and the attachment address the tracker returned — and both followed
 * redirects blind after checking only the scheme. `redirect: "follow"` lets the
 * FIRST server choose the second URL, so a public https catalogue answering
 * 302 to `http://127.0.0.1:<port>/…` had this server fetch itself, and the
 * same hop reaches a router's admin page or a cloud metadata address.
 *
 * Nothing here touches a network. The fake fetch records every URL it is asked
 * for, so the property under test — "the second hop is never made" — is read
 * off that list rather than inferred from an error string.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardedFetch, hostsOnly, pinnedFetch, privateAddress, unfetchableHost } from "../src/net.ts";
import { fetchCatalogue } from "../src/plugin-catalogue.ts";

describe("a private address, judged without a resolver", () => {
  test("loopback, RFC1918, CGNAT, link-local, unspecified, and their IPv6 spellings", () => {
    for (const h of ["127.0.0.1", "127.9.9.9", "10.0.0.1", "192.168.1.1", "172.16.0.1", "172.31.255.255", "100.64.0.1", "100.127.0.1",
      "169.254.169.254", "0.0.0.0", "localhost", "LOCALHOST", "foo.localhost", "::1", "::", "[::1]", "fc00::1", "fd12::1", "fe80::1", "FE80::1",
      "::ffff:127.0.0.1", "::ffff:10.1.2.3", "::ffff:169.254.169.254"]) {
      expect(privateAddress(h), h).toBe(true);
    }
  });

  test("a public address is not, and neither is a NAME that merely looks like one", () => {
    for (const h of ["93.184.216.34", "1.1.1.1", "172.32.0.1", "172.15.0.1", "100.63.0.1", "100.128.0.1", "2606:4700::1111", "example.com", "10.evil.example"]) {
      expect(privateAddress(h), h).toBe(false);
    }
  });

  test("a literal private address is refused with a reason; a literal public one passes", async () => {
    expect(await unfetchableHost("127.0.0.1")).toContain("private or local");
    expect(await unfetchableHost("169.254.169.254")).toContain("private or local");
    expect(await unfetchableHost("")).toBe("no host");
    expect(await unfetchableHost("93.184.216.34")).toBeNull();
  });

  test("a name that resolves to loopback is refused by what it resolves to", async () => {
    /* `localhost` short-circuits above; this exercises the resolver branch on
       the one name every machine answers for. */
    expect(await unfetchableHost("localhost.")).toMatch(/private or local|does not resolve/);
  });
});

describe("the host allowlist", () => {
  const allow = hostsOnly(["clickup.com", "clickup-attachments.com"]);
  test("admits the domains and their subdomains over https", () => {
    for (const u of ["https://clickup.com/x", "https://app.clickup.com/x", "https://t123.p.clickup-attachments.com/v.mov", "https://ATTACHMENTS.CLICKUP.COM/a"]) {
      expect(allow(new URL(u)), u).toBeNull();
    }
  });
  test("and refuses look-alikes, other hosts, and plain http", () => {
    for (const u of ["https://notclickup.com/x", "https://clickup.com.example.net/x", "https://evilclickup-attachments.com/x", "https://example.com/x", "http://app.clickup.com/x"]) {
      expect(allow(new URL(u)), u).not.toBeNull();
    }
  });
});

/** A fetch that answers from a script and writes down what it was asked. */
function scripted(answers: Record<string, Response | (() => Response)>, asked: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    asked.push(u);
    const a = answers[u];
    if (!a) return new Response("unexpected", { status: 599 });
    return typeof a === "function" ? a() : a.clone();
  }) as typeof fetch;
}

const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });

/** Literal addresses only — no resolver, so an invented name is "public" and
 *  the test does not depend on what this machine's DNS says about it. */
const literal = async (h: string) => (privateAddress(h) ? `${h} is a private or local address` : null);

describe("guardedFetch walks the hops itself", () => {
  test("a redirect to a private address is refused, and that address is never fetched", async () => {
    const asked: string[] = [];
    const f = scripted({ "https://catalogue.example.invalid/c.json": redirect("http://127.0.0.1:4317/health") }, asked);
    const got = await guardedFetch("https://catalogue.example.invalid/c.json", {}, () => null, { fetchImpl: f, hostCheck: literal, maxHops: 5 });
    expect(got.res).toBeUndefined();
    expect(got.error).toMatch(/redirected to 127\.0\.0\.1:4317/);
    expect(asked, "the private hop was fetched").toEqual(["https://catalogue.example.invalid/c.json"]);
  }, 20_000);

  test("a redirect to a host the allow refuses is refused at that hop", async () => {
    const asked: string[] = [];
    const f = scripted({ "https://app.clickup.com/f/1": redirect("https://example.com/f/1") }, asked);
    const got = await guardedFetch("https://app.clickup.com/f/1", {}, hostsOnly(["clickup.com"]), { fetchImpl: f, hostCheck: literal });
    expect(got.error).toContain("example.com is not a host this may fetch from");
    expect(asked).toEqual(["https://app.clickup.com/f/1"]);
  }, 20_000);

  test("a redirect to plain http is a downgrade and is refused", async () => {
    const asked: string[] = [];
    const f = scripted({ "https://app.clickup.com/f/2": redirect("http://app.clickup.com/f/2") }, asked);
    const got = await guardedFetch("https://app.clickup.com/f/2", {}, hostsOnly(["clickup.com"]), { fetchImpl: f, hostCheck: literal });
    expect(got.error).toContain("https only");
    expect(asked).toHaveLength(1);
  }, 20_000);

  test("a legitimate redirect within the rules is followed, relative Location included", async () => {
    const asked: string[] = [];
    const f = scripted({
      "https://app.clickup.com/f/3": redirect("/moved/3"),
      "https://app.clickup.com/moved/3": redirect("https://t1.p.clickup-attachments.com/3.mov"),
      "https://t1.p.clickup-attachments.com/3.mov": new Response("bytes", { status: 200 }),
    }, asked);
    const got = await guardedFetch("https://app.clickup.com/f/3", {}, hostsOnly(["clickup.com", "clickup-attachments.com"]), { fetchImpl: f, hostCheck: literal });
    expect(got.error).toBeUndefined();
    expect(await got.res!.text()).toBe("bytes");
    expect(asked).toHaveLength(3);
  }, 20_000);

  test("a loop stops at the hop limit", async () => {
    const asked: string[] = [];
    const f = scripted({ "https://app.clickup.com/loop": redirect("https://app.clickup.com/loop") }, asked);
    const got = await guardedFetch("https://app.clickup.com/loop", {}, hostsOnly(["clickup.com"]), { fetchImpl: f, hostCheck: literal, maxHops: 3 });
    expect(got.error).toBe("too many redirects");
    /* The first request plus three followed hops: the fourth 302 is where it stops. */
    expect(asked).toHaveLength(4);
  }, 20_000);

  test("every hop is fetched with redirect: manual, whatever the caller passed", async () => {
    let saw: RequestInit | undefined;
    const f = (async (_u: string | URL | Request, init?: RequestInit) => { saw = init; return new Response("ok"); }) as typeof fetch;
    await guardedFetch("https://app.clickup.com/x", { redirect: "follow" }, hostsOnly(["clickup.com"]), { fetchImpl: f, hostCheck: literal });
    expect(saw?.redirect).toBe("manual");
  }, 20_000);
});

describe("the catalogue fetch", () => {
  test("refuses a first URL on a private address before any request is made", async () => {
    const asked: string[] = [];
    const r = await fetchCatalogue("https://127.0.0.1:8443/catalogue.json", { fetchImpl: scripted({}, asked), hostCheck: literal });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("private or local");
    expect(asked).toEqual([]);
  }, 20_000);

  test("refuses a catalogue that redirects to a LAN address, and never fetches it", async () => {
    const asked: string[] = [];
    const f = scripted({ "https://catalogue.example.invalid/c.json": redirect("http://192.168.1.1/admin") }, asked);
    const r = await fetchCatalogue("https://catalogue.example.invalid/c.json", { fetchImpl: f, hostCheck: literal });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("192.168.1.1");
    expect(asked).toEqual(["https://catalogue.example.invalid/c.json"]);
  }, 20_000);

  test("refuses a catalogue that redirects off https", async () => {
    const asked: string[] = [];
    const f = scripted({ "https://catalogue.example.invalid/c.json": redirect("http://catalogue.example.invalid/c.json") }, asked);
    const r = await fetchCatalogue("https://catalogue.example.invalid/c.json", { fetchImpl: f, hostCheck: literal });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("off https");
    expect(asked).toHaveLength(1);
  }, 20_000);
});

describe("a v6 address that is a v4 host in disguise", () => {
  /** The URL parser and a resolver both hand back the hex form, so a check on
   *  the dotted spelling alone let loopback and the metadata address through. */
  test("the hex, long and translated spellings of private v4 hosts are private", () => {
    for (const h of ["::ffff:7f00:1", "::ffff:a9fe:a9fe", "::ffff:c0a8:101", "::ffff:a00:1", "0:0:0:0:0:ffff:7f00:1",
      "[::ffff:a9fe:a9fe]", "::7f00:1", "0:0:0:0:0:0:0:1", "0:0:0:0:0:0:0:0", "64:ff9b::a9fe:a9fe", "64:ff9b::7f00:1", "2002:7f00:1::", "2002:a9fe:a9fe::1"]) {
      expect(privateAddress(h), h).toBe(true);
    }
  });

  test("the same wrappers around a public v4 host, and ordinary public v6, are not", () => {
    for (const h of ["::ffff:5db8:d822", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1", "2606:4700::1111", "2001:db8::1"]) {
      expect(privateAddress(h), h).toBe(false);
    }
  });

  test("a name whose only record is a hex-mapped loopback is refused by what it resolves to", async () => {
    const t = await guardedFetch("https://mapped.example.invalid/x", {}, () => null,
      { resolver: async () => [{ address: "::ffff:7f00:1", family: 6 }], fetchImpl: async () => { throw new Error("must not connect"); } });
    expect(t.error).toContain("private or local");
  });
});

describe("the address that was checked is the address that is connected to", () => {
  /** Check-then-fetch resolved twice: a resolver the name's owner controls
   *  answers a public address to the check and a private one to the connect. */
  test("guardedFetch hands the judged address to the fetch and never resolves again", async () => {
    let lookups = 0;
    let connectedTo: string | undefined;
    const resolver = async () => (++lookups === 1
      ? [{ address: "93.184.216.34", family: 4 }]
      : [{ address: "127.0.0.1", family: 4 }]);
    const got = await guardedFetch("https://rebind.example.invalid/x", {}, () => null, {
      resolver,
      fetchImpl: async (_u, _i, address) => { connectedTo = address; return new Response("ok"); },
    });
    expect(got.res?.status).toBe(200);
    expect(connectedTo).toBe("93.184.216.34");
    expect(lookups).toBe(1);
  });

  test("a redirect hop is pinned to its own judged address", async () => {
    const seen: (string | undefined)[] = [];
    const answers: Record<string, string> = { "a.example.invalid": "93.184.216.34", "b.example.invalid": "1.1.1.1" };
    const got = await guardedFetch("https://a.example.invalid/1", {}, () => null, {
      resolver: async (h) => [{ address: answers[h]!, family: 4 }],
      fetchImpl: async (u, _i, address) => {
        seen.push(address);
        return u.includes("a.example") ? new Response(null, { status: 302, headers: { location: "https://b.example.invalid/2" } }) : new Response("done");
      },
    });
    expect(got.res?.status).toBe(200);
    expect(seen).toEqual(["93.184.216.34", "1.1.1.1"]);
  });

  test("pinnedFetch connects to the address, whatever the name says, and keeps the name in Host", async () => {
    let host = "";
    const srv = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (r) => { host = r.headers.get("host") ?? ""; return new Response("pinned"); } });
    try {
      // `pin.invalid` cannot resolve; only a connection made to the given address can answer.
      const res = await pinnedFetch(`http://pin.invalid:${srv.port}/x`, {}, "127.0.0.1");
      expect(await res.text()).toBe("pinned");
      expect(host).toBe(`pin.invalid:${srv.port}`);
    } finally { srv.stop(true); }
  });

  test("a redirect from pinnedFetch is returned, not followed", async () => {
    const srv = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 302, headers: { location: "http://elsewhere.invalid/" } }) });
    try {
      const res = await pinnedFetch(`http://pin.invalid:${srv.port}/x`, {}, "127.0.0.1");
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("http://elsewhere.invalid/");
    } finally { srv.stop(true); }
  });
});

describe("pinnedFetch over https", () => {
  /** A connection to an address must still check the certificate against the NAME. */
  const dir = mkdtempSync(join(tmpdir(), "agx-pin-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const cert = (cn: string) => {
    const key = join(dir, `${cn}.key`), crt = join(dir, `${cn}.crt`);
    const r = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", crt,
      "-subj", `/CN=${cn}`, "-addext", `subjectAltName=DNS:${cn}`, "-days", "1"]);
    expect(r.exitCode).toBe(0);
    return { key: Bun.file(key), crt: Bun.file(crt) };
  };

  test("the certificate is checked against the name, not the address", async () => {
    const ok = cert("pinned.test");
    const srv = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { key: ok.key, cert: ok.crt }, fetch: () => new Response("secure") });
    try {
      const good = await pinnedFetch(`https://pinned.test:${srv.port}/`, { tls: { ca: ok.crt } } as RequestInit, "127.0.0.1");
      expect(await good.text()).toBe("secure");
      // Same server, a name the certificate does not cover: refused.
      await expect(pinnedFetch(`https://other.test:${srv.port}/`, { tls: { ca: ok.crt } } as RequestInit, "127.0.0.1")).rejects.toThrow();
    } finally { srv.stop(true); }
  });
});
