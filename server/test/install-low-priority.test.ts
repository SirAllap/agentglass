/*
 * An install build must not take the machine away from the window it replaces.
 *
 * Measured: a running app froze while RAM was at 91% and swap at 9.4G, as an
 * install build started. The build is minutes of vite, bun --compile and
 * electron-builder; the window needs the CPU and the disk while all of it runs,
 * and the person is still looking at the old app.
 *
 * Asserted from source because there is no way to run an install in a test —
 * that is the whole point of the script. The packaging command is the one place
 * every heavy child comes from, so the check is that it goes through nice and
 * ionice there, that each is conditional on the tool existing, and that the
 * restart at the end is not wrapped (a window launched at nice 10 and idle IO
 * would be the same problem with a longer tail).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const MAKE = readFileSync(join(ROOT, "Makefile"), "utf8");
const INSTALL = readFileSync(join(ROOT, "electron", "install-local.sh"), "utf8");
const SELF = readFileSync(join(ROOT, "electron", "self-update.sh"), "utf8");

/** Comment lines are prose; only the rest can execute. */
const code = (s: string) => s.split("\n").filter((l) => !/^\s*#/.test(l));

/** The tab-indented recipe of one Makefile target. */
function recipe(target: string): string[] {
  const lines = MAKE.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^${target}:`).test(l));
  expect(start).toBeGreaterThan(-1);
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("\t")) break;
    out.push(line);
  }
  return out;
}

/** The one line that packages the app: web vite build + server compile (both
 *  inside build.mjs) and electron-builder. The stamp check is a hash of the
 *  tree, not a build, and is deliberately not here. */
const packaging = () => code(INSTALL).filter((l) => /\bbunx electron-builder --dir\b/.test(l));
const helper = () => code(INSTALL).filter((l) => /low_priority|nice -n|ionice -c3|command -v (nice|ionice)/.test(l));

/** The wrapper's own lines, from any file, with recipe indentation, the
 *  continuation backslash, make's `$$@` escaping and a trailing `;` normalised
 *  away — all three copies are meant to read the same. */
function wrapperLines(text: string): string[] {
  return code(text)
    .filter((l) => /command -v (nice|ionice)|nice -n 10|ionice -c3/.test(l))
    .map((l) => l.trim().replace(/\\$/, "").replace(/\$\$@/g, "$@").replace(/;\s*$/, "").trim())
    .filter((l) => l.startsWith("if command -v"));
}

describe("desktop-install leaves the running window its CPU and disk", () => {
  test("desktop-install calls the installer, which is where the build lives", () => {
    // The target is a one-line delegation; the wrap has to be in the script or
    // it would also wrap stop_app/start_app, and the reopened window would
    // inherit idle IO and niceness for as long as it runs.
    expect(recipe("desktop-install").join("\n")).toContain("electron/install-local.sh");
  });

  test("both build commands run through the low-priority wrapper", () => {
    const lines = packaging();
    expect(lines.length).toBe(1);
    // web vite + `bun build --compile` are inside build.mjs; electron-builder
    // is the next command. Both are children of this line.
    expect(lines[0]).toMatch(/low_priority node build\.mjs/);
    expect(lines[0]).toMatch(/low_priority bunx electron-builder/);
  });

  test("the wrapper is nice -n 10 and ionice -c3, each only where the tool exists", () => {
    const h = helper().join("\n");
    expect(h).toContain("command -v nice");
    expect(h).toContain("nice -n 10");
    expect(h).toContain("command -v ionice");
    expect(h).toContain("ionice -c3");
    // A missing tool must fall through to the plain command rather than fail
    // the install: both are `if command -v …; then set -- …; fi`.
    expect(h).toMatch(/if command -v nice[^\n]*then set -- nice -n 10/);
    expect(h).toMatch(/if command -v ionice[^\n]*then set -- ionice -c3/);
  });

  test("the restart at the end is not low-priority", () => {
    const restart = code(INSTALL).filter((l) => /\bstart_app\b/.test(l));
    expect(restart.length).toBeGreaterThan(0);
    for (const line of restart) {
      expect(line).not.toContain("low_priority");
      expect(line).not.toContain("nice");
      expect(line).not.toContain("ionice");
    }
  });
});

describe("the other two update paths run at the same priority", () => {
  // `make desktop-update` is what a developer runs; it is not the installer, so
  // nothing wraps it for them.
  test("desktop-update installs dependencies through the wrapper", () => {
    const r = recipe("desktop-update");
    expect(r.join("\n")).toContain("low_priority bun install");
    // A second, unwrapped install beside it would be the whole bug back.
    expect(r.filter((l) => /^\s*bun install\b/.test(l))).toEqual([]);
    expect(r.join("\n")).toMatch(/command -v nice/);
  });

  // self-update.sh is spawned by the server with the app's own environment and
  // no terminal: it is the path nobody watches while it runs.
  test("self-update.sh installs the clone's dependencies through the wrapper", () => {
    const installs = code(SELF).filter((l) => /\bbun install\b/.test(l));
    expect(installs.length).toBe(2);
    for (const line of installs) expect(line).toMatch(/low_priority bun install /);
    expect(wrapperLines(SELF).length).toBe(2);
  });

  // Three copies of 5 lines. A change to one that skips the others is how the
  // wrap quietly stops being the same policy everywhere.
  test("all three copies of the wrapper are the same", () => {
    const installed = wrapperLines(INSTALL);
    expect(installed.length).toBe(2);
    expect(wrapperLines(SELF)).toEqual(installed);
    expect(wrapperLines(MAKE)).toEqual(installed);
  });
});
