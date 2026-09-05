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
import { describe, expect, test } from "bun:test";
import { guardedFetch, hostsOnly, privateAddress, unfetchableHost } from "../src/net.ts";
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
