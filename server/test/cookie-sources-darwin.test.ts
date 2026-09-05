/*
 * Where a Mac keeps its browsers' cookies.
 *
 * Every browser the picker knows keeps its profiles under
 * `~/Library/Application Support/<vendor>` on a Mac. The picker used to look
 * only for the Linux dot-directories, so on a Mac it found nothing and offered
 * an empty list with no word about why.
 *
 * A Mac's home is laid out under a scratch directory on this Linux box and
 * `findProfiles` is pointed at it with the platform stated — the same walk,
 * the same on-disk shapes (profiles.ini; `Default` and `Profile N`), different
 * roots. Nothing here touches the developer's real browsers: the home is ours.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findProfiles, sourcesFor, MAC_SOURCES, LINUX_SOURCES } from "../src/cookiesources.ts";

const HOME = join(tmpdir(), `agx-mac-home-${process.pid}`);
afterAll(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* fine */ } });

const AS = join(HOME, "Library", "Application Support");
function file(path: string, content = "not a real database, just a file with the right name") {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

// Chrome: Default and a second profile, plus a directory that is not a profile.
file(join(AS, "Google", "Chrome", "Default", "Cookies"));
file(join(AS, "Google", "Chrome", "Profile 1", "Cookies"));
file(join(AS, "Google", "Chrome", "Local State"), "{}");
// Brave: one profile.
file(join(AS, "BraveSoftware", "Brave-Browser", "Default", "Cookies"));
// Firefox: profiles.ini names the one profile, which has a store; a second
// entry names a directory with none, and must not be listed.
file(join(AS, "Firefox", "profiles.ini"), [
  "[Profile0]", "Name=default-release", "IsRelative=1", "Path=Profiles/abcd1234.default-release", "",
  "[Profile1]", "Name=empty", "IsRelative=1", "Path=Profiles/zzzz0000.empty", "",
].join("\n"));
file(join(AS, "Firefox", "Profiles", "abcd1234.default-release", "cookies.sqlite"));
mkdirSync(join(AS, "Firefox", "Profiles", "zzzz0000.empty"), { recursive: true });
// And the Linux layout, present in the same home, which a Mac must NOT search.
file(join(HOME, ".config", "google-chrome", "Default", "Cookies"));

describe("on a Mac", () => {
  const found = findProfiles("darwin", HOME);
  const ids = found.map((f) => f.id).sort();

  test("finds Chrome's profiles under Library/Application Support/Google/Chrome", () => {
    expect(ids).toContain("chrome:Default");
    expect(ids).toContain("chrome:Profile 1");
    const def = found.find((f) => f.id === "chrome:Default")!;
    expect(def.db).toBe(join(AS, "Google", "Chrome", "Default", "Cookies"));
    expect(def.keyring).toBe("chrome");
    expect(def.label).toBe("Google Chrome — Default");
  });

  test("finds Brave and Firefox in their own vendor directories", () => {
    expect(ids).toContain("brave:Default");
    expect(ids).toContain("firefox:abcd1234.default-release");
    const ff = found.find((f) => f.source === "firefox")!;
    expect(ff.kind).toBe("firefox");
    expect(ff.label).toBe("Firefox — default-release");
  });

  test("a Firefox profile with no store is not listed, and Chrome's Local State is not a profile", () => {
    expect(ids.some((i) => i.includes("zzzz0000"))).toBe(false);
    expect(ids.some((i) => i.includes("Local State"))).toBe(false);
  });

  test("does not look in the Linux dot-directories — each entry is found once, under its Mac root", () => {
    expect(found.filter((f) => f.id === "chrome:Default")).toHaveLength(1);
    expect(found.every((f) => f.db.startsWith(AS))).toBe(true);
  });

  test("the same ids as Linux, so a remembered profile id means the same store on either machine", () => {
    expect(MAC_SOURCES.map((s) => s.id)).toEqual(LINUX_SOURCES.map((s) => s.id));
    for (const m of MAC_SOURCES) {
      const l = LINUX_SOURCES.find((s) => s.id === m.id)!;
      expect(m.kind).toBe(l.kind);
      expect(m.keyring).toBe(l.keyring);
      for (const d of m.dirs) expect(d.startsWith("Library/Application Support/")).toBe(true);
    }
  });
});

describe("which list a platform searches", () => {
  test("darwin the Mac list, linux the Linux list, win32 nothing, any other Unix the Linux list", () => {
    expect(sourcesFor("darwin")).toBe(MAC_SOURCES);
    expect(sourcesFor("linux")).toBe(LINUX_SOURCES);
    expect(sourcesFor("win32")).toEqual([]);
    expect(sourcesFor("freebsd")).toBe(LINUX_SOURCES);
  });

  test("on Linux the same home yields only the dot-directory store", () => {
    const linux = findProfiles("linux", HOME).map((f) => f.id);
    expect(linux).toEqual(["chrome:Default"]);
  });
});
