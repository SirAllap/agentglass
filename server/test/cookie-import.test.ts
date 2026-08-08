/*
 * Converting somebody's real logins into cookies this browser will send.
 *
 * Every case here is a failure that does not announce itself. `cookies.set`
 * accepts a cookie Chromium will then decline to attach to any request and says
 * nothing; a lifetime a thousand times too long is silently clamped rather than
 * rejected. So the only place any of this can be checked is here, against the
 * rules as written down — which is why the file is mostly assertions about
 * fields being *present* and *absent* rather than about anything happening.
 */
import { describe, expect, test } from "bun:test";
import {
  chromeEpochSeconds, cookieUrl, ffExpirySeconds, FF_MS_SCHEMA, isHostOnly, planImport,
  sameSiteOf, siteOf, toElectronCookie, type CookieRow,
} from "../src/cookieimport.ts";

const NOW = 1_800_000_000; // a fixed "now", so "expired" is a decision not a race

const row = (over: Partial<CookieRow> = {}): CookieRow => ({
  host: "app.example.com", name: "session", value: "abc", path: "/",
  expires: NOW + 86_400, secure: true, httpOnly: true, sameSite: 1, ...over,
});

describe("expiry, which is silently wrong when it is wrong", () => {
  test("Firefox stores milliseconds from schema 16, and seconds before it", () => {
    const raw = 1_800_000_000_000;
    expect(ffExpirySeconds(raw, 17)).toBe(1_800_000_000);
    expect(ffExpirySeconds(raw, FF_MS_SCHEMA)).toBe(1_800_000_000);
    // A thousand times apart from the same number: fed straight through, the
    // millisecond value becomes the year 58356 and Chromium clamps it to its
    // 400-day cap without complaining, so every cookie gets one wrong lifetime.
    expect(ffExpirySeconds(raw, 15)).toBe(raw);
  });

  test("Chromium counts microseconds from 1601, and the answer is whole seconds", () => {
    const s = chromeEpochSeconds(13_423_576_883_116_640);
    expect(Number.isInteger(s)).toBe(true);
    expect(new Date(s * 1000).toISOString().slice(0, 10)).toBe("2026-05-18");
  });

  test("nonsense is zero, which reads as a session cookie rather than as 1970", () => {
    expect(chromeEpochSeconds(0)).toBe(0);
    expect(chromeEpochSeconds(Number.NaN)).toBe(0);
    expect(ffExpirySeconds(Number.NaN, 17)).toBe(0);
  });
});

describe("sameSite, which Electron defaults to lax when it is missing", () => {
  test("Firefox's table, including 256", () => {
    expect(sameSiteOf("firefox", 0)).toBe("no_restriction");
    expect(sameSiteOf("firefox", 1)).toBe("lax");
    expect(sameSiteOf("firefox", 2)).toBe("strict");
    // Not corruption and not "lax": SAMESITE_UNSET. Chromium's Lax-by-default
    // carries a two-minute top-level-POST exemption that a literal lax does not,
    // so mapping it across breaks exactly the SSO callbacks people notice.
    expect(sameSiteOf("firefox", 256)).toBe("unspecified");
  });

  test("Chromium's table, including -1", () => {
    expect(sameSiteOf("chromium", -1)).toBe("unspecified");
    expect(sameSiteOf("chromium", 0)).toBe("no_restriction");
    expect(sameSiteOf("chromium", 2)).toBe("strict");
  });

  test("an unknown constant does not abort an import", () => {
    expect(sameSiteOf("firefox", 99)).toBe("unspecified");
  });

  test("and the field is on every cookie that is produced", () => {
    // Absent means "lax" to Electron, so anything a site uses cross-site is
    // imported successfully and then withheld in silence.
    const plan = planImport(
      [row(), row({ host: ".example.com", name: "a" }), row({ host: "b.example.com", name: "b", secure: false })],
      "firefox", { sites: ["example.com"], nowSeconds: NOW },
    );
    expect(plan.install.length).toBe(3);
    for (const c of plan.install) expect("sameSite" in c).toBe(true);
  });
});

describe("host-only versus domain, the accepted-then-never-sent one", () => {
  test("a leading dot means and-subdomains, and it is carried across", () => {
    expect(isHostOnly("accounts.example.com")).toBe(true);
    expect(isHostOnly(".example.com")).toBe(false);

    const domainCookie = toElectronCookie(row({ host: ".example.com" }), "firefox", NOW);
    expect(domainCookie.ok && domainCookie.cookie.domain).toBe(".example.com");

    const hostOnly = toElectronCookie(row({ host: "accounts.example.com" }), "firefox", NOW);
    // Absent, not empty: Electron normalises whatever it is given with a leading
    // dot, so passing anything here makes it a domain cookie.
    expect(hostOnly.ok && "domain" in hostOnly.cookie).toBe(false);
  });

  test("the url is built from host, path and secure, so they cannot disagree", () => {
    expect(cookieUrl(".example.com", "/app", true)).toBe("https://example.com/app");
    expect(cookieUrl("example.com", "/app", false)).toBe("http://example.com/app");
    expect(cookieUrl("example.com", "", true)).toBe("https://example.com/");
  });

  test("a __Host- cookie comes out with the four things Chromium demands", () => {
    const r = toElectronCookie(
      row({ host: "example.com", name: "__Host-sid", path: "/", secure: true }), "firefox", NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect("domain" in r.cookie).toBe(false);
    expect(r.cookie.path).toBe("/");
    expect(r.cookie.secure).toBe(true);
    expect(r.cookie.url.startsWith("https:")).toBe(true);
  });
});

describe("what is refused, and named", () => {
  test("each reason is its own answer", () => {
    expect(toElectronCookie(row({ expires: NOW - 1 }), "firefox", NOW)).toEqual({ ok: false, reason: "expired" });
    expect(toElectronCookie(row({ expires: 0 }), "firefox", NOW)).toEqual({ ok: false, reason: "session-only" });
    expect(toElectronCookie(row({ partition: "^userContextId=2" }), "firefox", NOW)).toEqual({ ok: false, reason: "partitioned" });
    expect(toElectronCookie(row({ encrypted: true }), "chromium", NOW)).toEqual({ ok: false, reason: "encrypted" });
    expect(toElectronCookie(row({ host: "" }), "firefox", NOW)).toEqual({ ok: false, reason: "bad-host" });
  });

  test("an expired row is refused rather than set and purged moments later", () => {
    // `cookies.set` takes a past date without complaint. The row is still in the
    // file; the login is not.
    const plan = planImport([row({ expires: NOW - 10 })], "firefox", { sites: ["example.com"], nowSeconds: NOW });
    expect(plan.install).toEqual([]);
    expect(plan.skipped.expired).toBe(1);
  });
});

describe("which sites, and the invariant underneath it", () => {
  test("nothing chosen imports nothing", () => {
    // The whole feature rests on this: handing over every cookie on the machine
    // is handing over every session on it.
    const plan = planImport([row(), row({ host: ".other.com" })], "firefox", { sites: [], nowSeconds: NOW });
    expect(plan.install).toEqual([]);
    expect(plan.skipped["not-selected"]).toBe(2);
    // And it still says what it saw, so the picker has something to offer.
    expect(plan.sites.map((s) => s.site).sort()).toEqual(["example.com", "other.com"]);
  });

  test("a site is the registrable domain, not the host", () => {
    // Measured in a real profile: grouping by host puts `.mozilla.org` and
    // `support.mozilla.org` in separate rows, and ticking one imports half a
    // session.
    expect(siteOf(".mozilla.org")).toBe("mozilla.org");
    expect(siteOf("support.mozilla.org")).toBe("mozilla.org");
    expect(siteOf("accounts.google.com")).toBe("google.com");
    // A public second level is not somebody's domain.
    expect(siteOf("www.bbc.co.uk")).toBe("bbc.co.uk");
    expect(siteOf("shop.example.com.au")).toBe("example.com.au");
    expect(siteOf("localhost")).toBe("localhost");
  });

  test("counts add up, per reason, so the UI can say what happened", () => {
    const plan = planImport([
      row({ host: ".example.com", name: "live" }),
      row({ host: ".example.com", name: "old", expires: NOW - 5 }),
      row({ host: ".example.com", name: "jar", partition: "^userContextId=3" }),
      row({ host: ".other.com", name: "elsewhere" }),
    ], "firefox", { sites: ["example.com"], nowSeconds: NOW });

    expect(plan.install.map((c) => c.name)).toEqual(["live"]);
    expect(plan.skipped).toEqual({
      expired: 1, "session-only": 0, partitioned: 1, encrypted: 0, "not-selected": 1, "bad-host": 0,
    });
    expect(plan.sites).toEqual([
      { site: "example.com", cookies: 1 },
      { site: "other.com", cookies: 1 },
    ]);
  });
});
