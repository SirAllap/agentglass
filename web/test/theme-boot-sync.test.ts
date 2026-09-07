/*
 * Theme output reaches processes outside the browser. Restoring a saved value,
 * following an OS change, or loading the app in a harness is not consent to
 * repaint those processes; only a fresh picker action crosses that boundary.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("passive theme changes stay in the browser", () => {
  const main = src("../src/main.tsx");
  const themes = src("../src/lib/themes.ts");

  test("boot restores the saved theme without a machine broadcast", () => {
    expect(main).toMatch(/applyTheme\(\s*initialTheme\(\)\s*\)/);
    expect(main).not.toMatch(/applyTheme\(\s*initialTheme\(\),\s*\{\s*sync:/);
  });

  test("OS scheme changes repaint the document without broadcasting", () => {
    const watcher = themes.slice(themes.indexOf("export function watchSystemTheme"), themes.indexOf("export function initialTheme"));
    expect(watcher).toContain("applyTheme(");
    expect(watcher).not.toContain("sync:");
  });

  test("an automated browser cannot cross the sync boundary", () => {
    const sync = themes.slice(themes.indexOf("function syncTheme"), themes.indexOf("/* System / Dark / Light"));
    expect(sync).toMatch(/if \(navigator\.webdriver\) return/);
    expect(sync.indexOf("navigator.webdriver")).toBeLessThan(sync.indexOf("whenServerUp"));
  });

  test("an explicit picker action still synchronizes the chosen palette", () => {
    expect(themes).toMatch(/export function pickTheme[\s\S]*?applyTheme\(id, \{ sync: true \}\)/);
  });
});

describe("the theme sync authenticates like every other request", () => {
  const themes = src("../src/lib/themes.ts");

  test("syncTheme sends the token, not a bare content-type", () => {
    // /theme/sync is behind the same token gate as every route. A raw fetch
    // without authHeaders 401s on any box with remote access on, and the sync
    // is dropped silently — which is how tmux/nvim went days stale.
    expect(themes).toMatch(/import \{[^}]*\bauthHeaders\b[^}]*\} from "\.\/api\.ts"/);
    expect(themes).toMatch(/fetch\(`\$\{SERVER\}\/theme\/sync`,[\s\S]*?headers:\s*authHeaders\(/);
  });
});
