/*
 * Choosing what to bring over from another browser.
 *
 * The panel this drives opened on Firefox — three sites, opened twice last
 * year — while Zen sat beside it with 201 and the browser actually in use. It
 * then asked for those 201 to be ticked one at a time, having pre-selected
 * none of them. Every test here is one of those decisions.
 */
import { describe, expect, it } from "bun:test";
import {
  addVisible, allSites, bestSource, dropVisible, lockedWhy, rankSites, reachable, siteView, SHOWN_MAX,
} from "../src/lib/cookiePick.ts";
import type { CookieSite, CookieSource } from "../src/lib/desktop.ts";

const site = (s: string, cookies: number): CookieSite => ({ site: s, cookies });
const src = (over: Partial<CookieSource> = {}): CookieSource => ({
  id: "x", label: "X", kind: "firefox", readable: true, rows: 0, sites: [], ...over,
});
const many = (n: number): CookieSite[] => Array.from({ length: n }, (_, i) => site(`s${String(i).padStart(3, "0")}.test`, n - i));

describe("which browser to open on", () => {
  it("is the one with the most sites, not the first that happens to be readable", () => {
    // The actual bug, with the actual numbers.
    const firefox = src({ id: "firefox", label: "Firefox", sites: many(3) });
    const zen = src({ id: "zen", label: "Zen", sites: many(201) });
    expect(bestSource([firefox, zen])!.id).toBe("zen");
  });

  it("never opens on one it cannot read", () => {
    const locked = src({ id: "chrome", readable: false, rows: 900, sites: [] });
    const small = src({ id: "firefox", sites: many(2) });
    expect(bestSource([locked, small])!.id).toBe("firefox");
  });

  it("falls back to a readable but empty profile rather than nothing", () => {
    const empty = src({ id: "firefox", sites: [] });
    expect(bestSource([empty])!.id).toBe("firefox");
  });

  it("would rather show a locked one than an empty screen", () => {
    const locked = src({ id: "chrome", readable: false, rows: 900 });
    expect(bestSource([locked])!.id).toBe("chrome");
  });

  it("says nothing when there is nothing", () => {
    expect(bestSource([])).toBeNull();
  });
});

describe("the order they come in", () => {
  it("is most-used first, which is the closest thing a cookie jar knows", () => {
    const r = rankSites([site("b.test", 2), site("a.test", 40), site("c.test", 9)]);
    expect(r.map((s) => s.site)).toEqual(["a.test", "c.test", "b.test"]);
  });

  it("breaks ties alphabetically, so the list does not shift under a scroll", () => {
    const r = rankSites([site("z.test", 5), site("a.test", 5)]);
    expect(r.map((s) => s.site)).toEqual(["a.test", "z.test"]);
  });

  it("does not disturb the list it was handed", () => {
    const given = [site("b.test", 1), site("a.test", 9)];
    rankSites(given);
    expect(given[0]!.site).toBe("b.test");
  });
});

describe("what is drawn", () => {
  it("stops at a readable number and says how many it did not draw", () => {
    const v = siteView(many(201), "");
    expect(v.rows).toHaveLength(SHOWN_MAX);
    expect(v.hidden).toBe(201 - SHOWN_MAX);
    // The ones it did not draw are still chosen — the count is the whole point.
    expect(v.matched).toHaveLength(201);
  });

  it("draws them all when there are few", () => {
    const v = siteView(many(5), "");
    expect(v.rows).toHaveLength(5);
    expect(v.hidden).toBe(0);
  });

  it("filters before it ranks, and matches anywhere in the name", () => {
    const v = siteView([site("mail.google.com", 3), site("github.com", 40), site("googleapis.com", 1)], "goog");
    expect(v.matched.map((s) => s.site)).toEqual(["mail.google.com", "googleapis.com"]);
  });

  it("is not upset by a filter that matches nothing", () => {
    const v = siteView(many(4), "zzz");
    expect(v.rows).toEqual([]);
    expect(v.hidden).toBe(0);
  });

  it("ignores case and surrounding space", () => {
    expect(siteView([site("GitHub.com", 1)], "  github ").matched).toHaveLength(1);
  });
});

describe("what is chosen to begin with", () => {
  it("is everything", () => {
    // It used to be nothing, which with 201 sites is not a safeguard, it is a
    // reason never to finish.
    expect(allSites(many(201)).size).toBe(201);
  });
});

describe("all visible, and none visible", () => {
  const sites = [site("a.test", 3), site("b.test", 2), site("other.test", 1)];

  it("adds what the filter matches and leaves the rest alone", () => {
    const chosen = new Set(["other.test"]);
    const next = addVisible(chosen, siteView(sites, ".test"));
    expect(next.size).toBe(3);
  });

  it("keeps a choice made outside the current filter", () => {
    const chosen = new Set(["other.test"]);
    const next = addVisible(chosen, siteView(sites, "a.test"));
    expect([...next].sort()).toEqual(["a.test", "other.test"]);
  });

  it("removes only what the filter matches", () => {
    const chosen = allSites(sites);
    const next = dropVisible(chosen, siteView(sites, "a.test"));
    expect([...next].sort()).toEqual(["b.test", "other.test"]);
  });

  it("clears everything matched, including the rows past the cap", () => {
    const sites201 = many(201);
    const next = dropVisible(allSites(sites201), siteView(sites201, ""));
    expect(next.size).toBe(0);
  });
});

describe("a profile that cannot be read", () => {
  it("can be selected, so the reason is reachable at all", () => {
    // It used to be a disabled button, which left the explanation of the lock
    // attached to a state nobody could get to.
    expect(reachable(src({ readable: false, rows: 900 }))).toBe(true);
  });

  it("is not offered when it holds nothing either", () => {
    expect(reachable(src({ readable: false, rows: 0 }))).toBe(false);
  });

  it("names the thing that can actually be done about it", () => {
    // This message used to say there was no way to ask for the key. There is,
    // and it is asked for now, so reaching this means the ASK failed — which is
    // a different problem with a different answer.
    const why = lockedWhy(src({ label: "Google Chrome", readable: false, rows: 900, reason: "v11-keyring" }));
    expect(why).toContain("keyring");
    expect(why).toContain("unlock it");
    expect(why).not.toContain("no way");
  });

  it("is honest when the lock genuinely cannot be opened", () => {
    // App-bound encryption ties the key to the browser binary. Offering a
    // remedy here would be the old lie in a new place.
    const why = lockedWhy(src({ label: "Google Chrome", readable: false, rows: 4, reason: "app-bound" }));
    expect(why).toContain("app-bound");
    expect(why).not.toContain("unlock it");
  });
});
