/*
 * Finding the cookie stores, which is not a glob.
 *
 * The discovery half has one job that can be quietly wrong: `profiles.ini` is
 * the only thing that knows where a Firefox profile is, and the shapes it takes
 * on a real machine are the ones this pins — a relative path, an absolute one,
 * a directory name with a space and brackets in it, and profiles that have no
 * cookie store at all. All four are on the machine this was written against.
 */
import { describe, expect, test } from "bun:test";
import { LINUX_SOURCES, parseProfilesIni } from "../src/cookiesources.ts";

describe("profiles.ini", () => {
  test("relative paths hang off the profile directory", () => {
    const out = parseProfilesIni(
      ["[Profile0]", "Name=default-release", "IsRelative=1", "Path=abc.default-release", ""].join("\n"),
      "/home/dev/.mozilla/firefox",
    );
    expect(out).toEqual([{ name: "default-release", dir: "/home/dev/.mozilla/firefox/abc.default-release" }]);
  });

  test("an absolute path is left alone", () => {
    const out = parseProfilesIni(
      ["[Profile0]", "IsRelative=0", "Path=/mnt/data/ff/profile", ""].join("\n"), "/home/dev/.mozilla/firefox");
    expect(out[0]!.dir).toBe("/mnt/data/ff/profile");
  });

  test("a directory name with a space and brackets survives", () => {
    // Zen's flatpak profile on this machine is literally `isclddxo.Default (release)`.
    const out = parseProfilesIni(
      ["[Profile0]", "Name=Default (release)", "IsRelative=1", "Path=isclddxo.Default (release)"].join("\n"), "/base");
    expect(out[0]!.dir).toBe("/base/isclddxo.Default (release)");
  });

  test("several profiles, and the non-profile sections ignored", () => {
    const out = parseProfilesIni([
      "[Install4F96D1932A9F858E]", "Default=abc.default-release", "Locked=1",
      "[Profile1]", "Name=old", "IsRelative=1", "Path=old.default",
      "[Profile0]", "Name=new", "IsRelative=1", "Path=abc.default-release",
      "[General]", "StartWithLastProfile=1",
    ].join("\n"), "/base");
    expect(out.map((p) => p.name)).toEqual(["old", "new"]);
  });

  test("junk does not throw, it just finds nothing", () => {
    expect(parseProfilesIni("", "/base")).toEqual([]);
    expect(parseProfilesIni("not an ini at all", "/base")).toEqual([]);
    // A section with no Path is not a profile: this machine has directories
    // under ~/.mozilla/firefox that hold no cookie store at all.
    expect(parseProfilesIni("[Profile0]\nName=broken", "/base")).toEqual([]);
  });
});

describe("where it looks", () => {
  test("each browser lists its native, snap and flatpak layouts", () => {
    const ff = LINUX_SOURCES.find((s) => s.id === "firefox")!;
    expect(ff.dirs.some((d) => d.startsWith(".mozilla"))).toBe(true);
    expect(ff.dirs.some((d) => d.startsWith("snap/"))).toBe(true);
    expect(ff.dirs.some((d) => d.startsWith(".var/app/"))).toBe(true);
    // Chromium-family stores are found and probed, never decrypted.
    expect(LINUX_SOURCES.filter((s) => s.kind === "chromium").map((s) => s.id).sort())
      .toEqual(["brave", "chrome", "chromium"]);
  });
});
