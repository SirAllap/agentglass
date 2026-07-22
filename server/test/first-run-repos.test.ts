// On a fresh install the project picker offered "Whole machine" and nothing
// else, however many repos were on disk. Not a bug in discovery: every source
// of roots describes a machine that has already been used (a cwd inside a repo,
// projects with transcripts, their parents, repos seen in telemetry, configured
// directories), and on first run all five are empty. So the first screen a new
// user sees could only work after they had already used the thing.
//
// The fix is a short list of conventional code homes, which is a guess — and a
// guess that walks somewhere surprising is worse than no guess. These pin what
// it will and will not look at.
import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstRunRoots } from "../src/gitwork.ts";

let home = "";
const realHome = process.env.HOME;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agx-home-")); process.env.HOME = home; });
afterEach(() => { process.env.HOME = realHome; rmSync(home, { recursive: true, force: true }); });

const make = (...dirs: string[]) => { for (const d of dirs) mkdirSync(join(home, d), { recursive: true }); };

describe("where to look on a machine that has never been used", () => {
  test("the conventional code homes, when they exist", () => {
    make("code", "src", "projects");
    expect(firstRunRoots().map((r) => r.replace(home + "/", ""))).toEqual(["code", "src", "projects"]);
  });

  test("nothing is invented for a home that has none of them", () => {
    // Better to offer nothing than to walk somewhere surprising: the empty
    // state names `repoDirs`, which is the answer for an unconventional layout.
    make("Music", "Downloads", "Desktop");
    expect(firstRunRoots()).toEqual([]);
  });

  test("a file named like a code home is not a code home", () => {
    Bun.write(join(home, "code"), "not a directory");
    expect(firstRunRoots()).toEqual([]);
  });

  test("the nested one is found where macOS puts it", () => {
    make("Documents/GitHub");
    expect(firstRunRoots()).toEqual([join(home, "Documents/GitHub")]);
  });

  test("the list stays short", () => {
    // This is a guess, and every entry is a directory tree somebody's install
    // will walk on boot. Growing it is a decision, not a reflex — the escape
    // hatch for an unusual layout is `repoDirs`, which costs nothing to nobody.
    make("code", "src", "projects", "dev", "repos", "workspace", "Developer", "Documents/GitHub");
    expect(firstRunRoots().length).toBeLessThanOrEqual(8);
  });
});
