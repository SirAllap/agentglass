/*
 * Browsing as somebody else.
 *
 * The last thing on the browser's list after it was rebuilt: Orca has "New
 * Profile…", this had one Chromium partition, so signing into a site as
 * yourself and as a test user meant signing out in between.
 *
 * Almost all of the mechanism is Chromium's — a partition IS a profile. What is
 * ours, and what is here, is the naming: which suffix a tab attaches on, what
 * happens to the default one, and the rule that the main process will refuse
 * anything outside the family. That last one is the reason `partitionFor` and
 * `isProfileId` are not "just string helpers": a profile id decides which
 * cookie jar a page can read.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  addProfile, DEFAULT_PROFILE, isProfileId, loadProfiles, MAX_PROFILES, mintProfileId,
  partitionFor, partitionsFor, profileHue, profileName, removeProfile, saveProfiles,
} from "../src/lib/browserProfiles.ts";

const BASE = "persist:agentglass-browser";
/** The pattern electron/main.js validates against. Copied deliberately: if the
 *  two ever disagree, a profile stops being able to open a page at all, and the
 *  failure is a guest that silently refuses to attach. */
const MAIN_ALLOWS = /^persist:agentglass-browser(-[a-z0-9]{1,16})?$/;

describe("which partition a tab attaches on", () => {
  test("the default profile keeps the partition it always had", () => {
    // The upgrade rule. A suffix for everyone would have read, on first launch
    // after this shipped, as being signed out of every site at once.
    expect(partitionFor(BASE, "")).toBe(BASE);
  });

  test("a profile gets its own, and the main process would allow it", () => {
    expect(partitionFor(BASE, "work")).toBe(`${BASE}-work`);
    expect(MAIN_ALLOWS.test(partitionFor(BASE, "work"))).toBe(true);
  });

  test("every id this module can mint is one the main process allows", () => {
    // The two halves of the agreement, checked against each other rather than
    // by eye. A name with spaces, punctuation, accents and length is exactly
    // what a person types into "New profile…".
    for (const name of ["Work", "test user 2", "Cliente Ñ", "a".repeat(40), "🙂", ""]) {
      const id = mintProfileId(name, []);
      expect(isProfileId(id), `${name} → ${id}`).toBe(true);
      expect(MAIN_ALLOWS.test(partitionFor(BASE, id)), `${name} → ${id}`).toBe(true);
    }
  });

  test("an id that is not one of ours gets a jar of its own, never the default", () => {
    /*
     * This used to fall back to BASE, and the reasoning was that the worst
     * case is a tab in the default profile. Measured, that worst case is the
     * bug: `newtab --profile review-pr-540` handed an agent the person's own
     * cookies while `tabs` reported the isolated identity it had asked for.
     *
     * The value is still never trusted as written — it is slugged to the same
     * alphabet a minted id uses, so no caller can compose a partition string —
     * it is simply never the shared one.
     */
    for (const bad of ["../../app", "persist:agentglass", "UPPER", "review-pr-540"]) {
      const p = partitionFor(BASE, bad);
      expect(p, bad).not.toBe(BASE);
      expect(MAIN_ALLOWS.test(p), `${bad} → ${p}`).toBe(true);
    }
  });

  test("no partition stem means no partition", () => {
    // The browser view only draws inside the desktop shell; in a plain browser
    // the bridge is absent and the stem is "". Deriving `-work` from nothing
    // would invent a partition name out of thin air.
    expect(partitionFor("", "work")).toBe("");
  });
});

describe("naming a profile", () => {
  test("the id comes from the name, and stays out of the way of the ones taken", () => {
    expect(mintProfileId("Work", [])).toBe("work");
    expect(mintProfileId("Work", ["work"])).toBe("work2");
    expect(mintProfileId("Work", ["work", "work2"])).toBe("work3");
  });

  test("a name with nothing usable in it still gets an id", () => {
    expect(mintProfileId("🙂🙂", [])).toBe("profile");
    expect(mintProfileId("", ["profile"])).toBe("profile2");
  });

  test("two profiles cannot share a name", () => {
    const one = addProfile([], "Work");
    expect("error" in one).toBe(false);
    if ("error" in one) return;
    // Case-insensitively: "work" and "Work" in one menu is a mistake, not a
    // choice, and the cookie jars behind them would be different.
    expect(addProfile(one.profiles, "work")).toEqual({ error: "that name is taken" });
  });

  test("nothing can be called Default", () => {
    // The default is not in the list, so a second one would look identical and
    // behave differently.
    expect(addProfile([], DEFAULT_PROFILE.name)).toEqual({ error: "that name is taken" });
  });

  test("an empty name is refused rather than silently named", () => {
    expect(addProfile([], "   ")).toEqual({ error: "give it a name" });
  });

  test("the menu has a ceiling", () => {
    let list = addProfile([], "p1");
    for (let i = 2; i <= MAX_PROFILES; i++) {
      if ("error" in list) throw new Error("should have fitted");
      list = addProfile(list.profiles, `p${i}`);
    }
    if ("error" in list) throw new Error("should have fitted");
    expect(list.profiles.length).toBe(MAX_PROFILES);
    expect(addProfile(list.profiles, "one more")).toEqual({ error: `${MAX_PROFILES} profiles is the limit` });
  });

  test("forgetting one leaves the others alone", () => {
    const a = addProfile([], "Work");
    if ("error" in a) throw new Error("no");
    const b = addProfile(a.profiles, "Client");
    if ("error" in b) throw new Error("no");
    expect(removeProfile(b.profiles, a.profile.id).map((p) => p.name)).toEqual(["Client"]);
  });

  test("a tab whose profile was forgotten is still named, by its id", () => {
    // The tab keeps its partition and stays signed in; the menu simply has
    // nothing prettier to call it. Showing "Default" there would be a lie about
    // which cookies the page is using.
    expect(profileName([], "work")).toBe("work");
    expect(profileName([], "")).toBe("Default");
  });
});

describe("the list, across restarts", () => {
  const store = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
  };

  test("what was saved comes back", () => {
    const s = store();
    saveProfiles(s, [{ id: "work", name: "Work" }]);
    expect(loadProfiles(s)).toEqual([{ id: "work", name: "Work" }]);
  });

  test("nothing saved yet is not an error", () => {
    expect(loadProfiles(store())).toEqual([]);
    // No storage at all: a browser with it disabled, or a render on a server.
    expect(loadProfiles(null)).toEqual([]);
  });

  test("a corrupted entry is dropped, not thrown", () => {
    // This runs while the panel is mounting. A bad line here must not be the
    // reason the browser does not draw.
    const s = store();
    s.setItem("agx_browser_profiles", JSON.stringify([
      { id: "work", name: "Work" },
      { id: "../escape", name: "Bad" },
      { id: "work", name: "Duplicate" },
      { name: "No id" },
      "not an object",
    ]));
    expect(loadProfiles(s)).toEqual([{ id: "work", name: "Work" }]);
  });

  test("outright garbage reads as no profiles", () => {
    const s = store();
    s.setItem("agx_browser_profiles", "{not json");
    expect(loadProfiles(s)).toEqual([]);
  });

  test("saving into a store that refuses does not throw", () => {
    // Private mode, or a full quota. Losing the list is bad; taking the panel
    // down with it is worse.
    const angry = { getItem: () => null, setItem: () => { throw new Error("QuotaExceeded"); } };
    expect(() => saveProfiles(angry, [{ id: "work", name: "Work" }])).not.toThrow();
  });
});

describe("the colour a profile is marked with", () => {
  test("the same id always gets the same hue", () => {
    expect(profileHue("work")).toBe(profileHue("work"));
  });

  test("it stays out of the band this app uses for success", () => {
    // A green dot beside a tab reads as "fine", and a profile is not a status.
    for (const id of ["work", "client", "test", "a", "zz9", "profile2", "qa"]) {
      const h = profileHue(id);
      expect(h >= 90 && h <= 150, `${id} → ${h}`).toBe(false);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });
});

/*
 * And a lock across the two processes.
 *
 * The renderer decides which partition a tab asks for; the main process decides
 * which it will allow. They are in different files, in different processes,
 * written in different languages' worth of style — and if they drift the
 * failure is silent in the worst direction. Narrow the main side and profiles
 * stop opening at all (a guest that refuses to attach shows a blank rectangle);
 * widen it and the renderer can name the app's own session, which is where the
 * API token's storage lives.
 *
 * So the pattern is read out of the main process rather than trusted. It lives
 * in electron/guest-guard.js — moved there out of main.js so it could be called
 * as well as read; web/test/browser-guest-guard.test.ts does the calling.
 */
describe("the renderer and the main process agree", () => {
  const main = readFileSync(join(import.meta.dir, "..", "..", "electron", "main.js"), "utf8");
  const guard = readFileSync(join(import.meta.dir, "..", "..", "electron", "guest-guard.js"), "utf8");

  test("the main process still validates the partition with the pattern this assumes", () => {
    expect(guard).toContain(MAIN_ALLOWS.source);
  });

  test("the main process does not accept a partition outside the browser family", () => {
    // The check itself, not just the pattern: an `isBrowserPartition` that is
    // defined and never called would pass the assertion above.
    expect(guard).toContain("!isBrowserPartition(webPreferences.partition)");
  });

  test("the app's own session is not inside the family", () => {
    // The one string this must never match. `persist:agentglass` holds the
    // renderer's storage, and a guest attached there would be a page the app did
    // not write reading the app's own origin.
    expect(MAIN_ALLOWS.test("persist:agentglass")).toBe(false);
    expect(MAIN_ALLOWS.test("")).toBe(false);
    expect(MAIN_ALLOWS.test("persist:agentglass-browser-")).toBe(false);
    expect(MAIN_ALLOWS.test("persist:agentglass-browser-A")).toBe(false);
  });
});

/*
 * Forgetting a site, everywhere it was kept.
 *
 * A hole opened by profiles themselves, and worth naming as such: "Forget
 * cookies" in Settings swept one partition, which was every partition there
 * was. The moment a second profile could exist, that button became a privacy
 * control that reports a number, looks finished, and leaves the login it was
 * asked to remove sitting in another jar.
 */
describe("which partitions a sweep has to cover", () => {
  test("the default is included even when nobody listed it", () => {
    // The caller builds this from the profile menu, and the default profile is
    // not in that menu — so a list that trusted the caller would clear the
    // profiles and leave the identity most browsing happens in untouched.
    expect(partitionsFor(BASE, [])).toEqual([BASE]);
    expect(partitionsFor(BASE, ["work"])).toEqual([BASE, `${BASE}-work`]);
  });

  test("it is always first, so a partial failure fails on the common case", () => {
    expect(partitionsFor(BASE, ["work", "client"])[0]).toBe(BASE);
  });

  test("a repeated or empty id does not sweep the same jar twice", () => {
    expect(partitionsFor(BASE, ["work", "work", ""])).toEqual([BASE, `${BASE}-work`]);
  });

  test("an id outside the family cannot widen the sweep", () => {
    /* Skipped rather than collapsed. This list comes from the profile menu, so
       a value that is not a minted id is a hand-edited file — and a sweep is
       the one place where widening on a bad value costs somebody data. */
    expect(partitionsFor(BASE, ["../../app"])).toEqual([BASE]);
    expect(partitionsFor(BASE, ["review-pr-540"])).toEqual([BASE]);
  });

  test("no stem means nothing to sweep", () => {
    // Outside the desktop shell there is no browser and no partition to name.
    expect(partitionsFor("", ["work"])).toEqual([]);
  });

  test("every partition it produces is one the main process accepts", () => {
    for (const p of partitionsFor(BASE, ["work", "client2", "qa"])) {
      expect(MAIN_ALLOWS.test(p), p).toBe(true);
    }
  });
});

describe("the sweep in the main process", () => {
  const main = readFileSync(join(import.meta.dir, "..", "..", "electron", "main.js"), "utf8");

  test("it walks a list of partitions rather than one session", () => {
    expect(main).toContain("for (const partition of partitions)");
  });

  test("it validates every partition the renderer names", () => {
    // Unvalidated, this would be a renderer bug that can delete from the app's
    // own storage — the one place cookies must never be removed from by a page.
    expect(main).toContain("req.partitions.filter(isBrowserPartition)");
  });

  test("it sweeps the default whether or not it was asked to", () => {
    expect(main).toContain("[...new Set([BROWSER_PARTITION, ...asked])]");
  });
});

/*
 * AN IDENTITY WE CANNOT READ NEVER GETS THE PERSON'S COOKIES.
 *
 * `partitionFor` fell through to the base partition for anything that was not
 * a minted id, and the base partition is the default profile — the person's
 * own session. A tab asking for `review-pr-540`, the name the skill's own
 * example uses, attached there: labelled with the profile it asked for,
 * carrying the session of the one it did not. Nothing failed, and `tabs`
 * reported the isolated identity the whole time.
 */
describe("a partition for a name that is not an id", () => {
  test("is its own jar, never the shared one", () => {
    for (const asked of ["review-pr-540", "pol-proj9175", "agent_1", "Agent One"]) {
      const p = partitionFor("persist:agx", asked);
      expect(p, asked).not.toBe("persist:agx");
      expect(p.startsWith("persist:agx-"), asked).toBe(true);
    }
  });

  test("still gives the default profile the base partition, which is what keeps logins working", () => {
    expect(partitionFor("persist:agx", "")).toBe("persist:agx");
  });

  test("and two different names do not collide on one jar", () => {
    expect(partitionFor("persist:agx", "review-pr-540"))
      .not.toBe(partitionFor("persist:agx", "review-pr-541"));
  });
});
