/*
 * No native module may be imported at the top of a file the router reaches.
 *
 * This is the bug that shipped a blank app twice over. `expo-notifications`
 * was imported at module scope; Expo Go on Android does not carry it, so the
 * import threw — and because that file is reached from the host store, which
 * is reached from the tab layout, expo-router failed to build a route and the
 * app rendered nothing at all. Not "notifications are off": nothing.
 *
 * The web QA harness cannot catch it, and that is the point of this file: the
 * harness swaps these modules for stand-ins, so on that platform the import
 * always succeeds. The rule has to be checked in the source.
 *
 * A module that MIGHT not be there is required lazily, inside a function,
 * behind a try — so a phone that cannot do the thing still gets every screen.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Modules that are absent or throw in some builds we care about — Expo Go on
 *  Android being the one this project develops against. */
const RISKY = ["expo-notifications"];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "node_modules" || entry === "web-shims") continue;
      out.push(...sources(path));
    } else if (/\.tsx?$/.test(entry) && !/\.test\./.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

const root = join(import.meta.dir, "..");
const files = [...sources(join(root, "app")), ...sources(join(root, "src"))];

describe("what may be imported at the top of a file", () => {
  test("nothing that can be missing from a build", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const risky of RISKY) {
        // A static import — `import … from "x"` — as opposed to a `require`
        // inside a function, which is the shape that survives.
        if (new RegExp(`^\\s*import[^\\n]*["']${risky}["']`, "m").test(source)) {
          offenders.push(`${file.slice(root.length + 1)} imports ${risky} at module scope`);
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  test("and the one that is required lazily still says when it cannot", () => {
    // Degrading has to be visible. A switch that silently does nothing is
    // worse than one that says the build has not got the module.
    const notify = readFileSync(join(root, "src", "notifications", "notify.ts"), "utf8");
    expect(notify).toContain("notificationsSupported");
    expect(notify).toMatch(/require\("expo-notifications"\)/);
    const settings = readFileSync(join(root, "app", "(tabs)", "settings.tsx"), "utf8");
    expect(settings).toContain("notificationsSupported");
  });
});
