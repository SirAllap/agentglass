/*
 * docs/INSTALL.md lists what the release jobs actually build.
 *
 * The table had Linux and macOS while desktop-binaries.yml built a Windows
 * installer and android-apk.yml an APK too — two artefacts on every release
 * that the install page did not mention. And the macOS cell said "Apple
 * Silicon and Intel" without the file names, when the two .dmg files differ
 * only by the arch in the name. Read against the workflows and the
 * electron-builder config, so a renamed artefact fails here rather than in a
 * reader's download directory.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;
const doc = readFileSync(join(ROOT, "docs", "INSTALL.md"), "utf8");
const desktop = readFileSync(join(ROOT, ".github", "workflows", "desktop-binaries.yml"), "utf8");
const android = readFileSync(join(ROOT, ".github", "workflows", "android-apk.yml"), "utf8");
const pkg = JSON.parse(readFileSync(join(ROOT, "electron", "package.json"), "utf8"));

/** The quickstart table's rows, first column each. */
const table = doc.slice(doc.indexOf("| Platform |"), doc.indexOf("\n\n", doc.indexOf("| Platform |")));
const rows = table.split("\n").slice(2).map((l) => l.split("|")[1]!.trim());

describe("the platform table", () => {
  test("has a row for every leg desktop-binaries.yml builds, and for the APK", () => {
    expect(desktop).toContain("--linux AppImage deb");
    expect(desktop).toContain("--mac dmg --arm64");
    expect(desktop).toContain("--mac dmg --x64");
    expect(desktop).toContain("--win nsis");
    expect(android).toContain("agentglass-${GITHUB_REF_NAME:-dev}.apk");
    expect(rows.some((r) => /^Linux/.test(r))).toBe(true);
    expect(rows.some((r) => /^macOS.*arm64/.test(r))).toBe(true);
    expect(rows.some((r) => /^macOS.*x64/.test(r))).toBe(true);
    expect(rows.some((r) => /^Windows/.test(r))).toBe(true);
    expect(rows.some((r) => /^Android/.test(r))).toBe(true);
  });

  test("names the assets the way electron-builder and the APK job name them", () => {
    expect(pkg.build.artifactName).toBe("agentglass_${version}_${arch}.${ext}");
    // ${arch} is `x86_64` for an AppImage, `amd64` for a .deb, `arm64`/`x64`
    // for a .dmg and `x64` for the nsis .exe — measured on a published release.
    for (const asset of [
      "agentglass_<version>_x86_64.AppImage",
      "agentglass_<version>_amd64.deb",
      "agentglass_<version>_arm64.dmg",
      "agentglass_<version>_x64.dmg",
      "agentglass_<version>_x64.exe",
      "agentglass-v<version>.apk",
    ]) expect(table).toContain(`\`${asset}\``);
  });

  test("does not promise the in-app updater where it is switched off", () => {
    const win = table.split("\n").find((l) => l.startsWith("| Windows"))!;
    const mac = table.split("\n").filter((l) => l.startsWith("| macOS"));
    expect(win).toMatch(/updater is off/);
    for (const m of mac) expect(m).toMatch(/\.dmg/);
  });
});
