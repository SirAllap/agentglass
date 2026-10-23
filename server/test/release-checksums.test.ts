/*
 * SHA256SUMS listed five of the six release files: the APK is attached by its
 * own workflow and the glob that builds the list was `*.dmg *.AppImage *.deb
 * *.exe`. Read against the workflows, so a glob that drops a platform fails
 * here and not in a reader's `sha256sum -c`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;
const wf = (n: string) => readFileSync(join(ROOT, ".github", "workflows", n), "utf8");
const desktop = wf("desktop-binaries.yml");
const android = wf("android-apk.yml");

describe("SHA256SUMS covers every release file", () => {
  test("the integrity job downloads and hashes the APK with the installers", () => {
    expect(desktop).toContain("--pattern '*.apk'");
    expect(desktop).toContain("files=(*.dmg *.AppImage *.deb *.exe *.apk)");
  });

  test("the APK job adds its own line when it lands after the list", () => {
    const step = android.slice(android.indexOf("- name: Add the APK to SHA256SUMS"));
    expect(step).toContain("--pattern SHA256SUMS");
    expect(step).toContain('sha256sum "$APK"');
    expect(step).toContain("--clobber");
  });
});
