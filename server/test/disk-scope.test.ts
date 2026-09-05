// The boundary on searching the machine.
//
// This is the one place in the app that reads outside the open project on
// purpose, so it is the one place where a regression is a hole rather than a
// bug — and, like the file browser's boundary, it would not show up in any
// screenshot: the tab would look exactly the same while answering with things
// it should never have opened.
//
// HOME is moved for the whole file, so the "machine" being searched is a
// temporary directory rather than the developer's own — a suite that walks the
// real home directory is both slow and rude.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diskAllows, diskFind, diskPlaces, diskRoots, diskWalk } from "../src/disk.ts";
import { fileText, fileTree } from "../src/files.ts";

const HOME0 = process.env.HOME;
const ROOT0 = process.env.AGENTGLASS_ROOT;
const OFF0 = process.env.AGENTGLASS_DISK_DISABLED;
const ROOTS0 = process.env.AGENTGLASS_DISK_ROOTS;

let home: string;
let outside: string;
let docs: string;
let project: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "agx-home-"));
  docs = join(home, "Documents", "projects", "PoL ORBIT-1042");
  mkdirSync(docs, { recursive: true });
  writeFileSync(join(docs, "evidence.md"), "# what the fix proves\n");
  mkdirSync(join(home, ".ssh"), { recursive: true });
  writeFileSync(join(home, ".ssh", "id_ed25519"), "PRIVATE KEY\n");

  outside = mkdtempSync(join(tmpdir(), "agx-elsewhere-"));
  writeFileSync(join(outside, "secret.txt"), "not yours\n");
  symlinkSync(outside, join(home, "shortcut"));

  // Scoped to a project, like a cockpit somebody actually opened: unscoped is
  // the whole machine by design (config.ts), and a boundary only means
  // something on the instance that has one.
  project = join(home, "code", "orbit");
  mkdirSync(project, { recursive: true });
  process.env.AGENTGLASS_ROOT = project;
  process.env.HOME = home;
  delete process.env.AGENTGLASS_DISK_DISABLED;
  delete process.env.AGENTGLASS_DISK_ROOTS;
});

afterAll(() => {
  if (HOME0 === undefined) delete process.env.HOME; else process.env.HOME = HOME0;
  if (ROOT0 === undefined) delete process.env.AGENTGLASS_ROOT; else process.env.AGENTGLASS_ROOT = ROOT0;
  if (OFF0 === undefined) delete process.env.AGENTGLASS_DISK_DISABLED; else process.env.AGENTGLASS_DISK_DISABLED = OFF0;
  if (ROOTS0 === undefined) delete process.env.AGENTGLASS_DISK_ROOTS; else process.env.AGENTGLASS_DISK_ROOTS = ROOTS0;
  rmSync(home, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("what the machine search may touch", () => {
  test("home, and what is under it", () => {
    expect(diskRoots()).toEqual([home]);
    expect(diskAllows(home)).toBe(true);
    expect(diskAllows(docs)).toBe(true);
    expect(diskAllows(join(docs, "evidence.md"))).toBe(true);
  });

  test("nothing above home", () => {
    expect(diskAllows("/etc")).toBe(false);
    expect(diskAllows("/etc/shadow")).toBe(false);
    expect(diskAllows(outside)).toBe(false);
    expect(diskAllows(join(home, ".."))).toBe(false);
  });

  test("nothing hidden — the dot is the rule, not a list of names", () => {
    expect(diskAllows(join(home, ".ssh"))).toBe(false);
    expect(diskAllows(join(home, ".ssh", "id_ed25519"))).toBe(false);
    expect(diskAllows(join(home, ".config", "agentglass", "token"))).toBe(false);
  });

  test("a symlink out of home is followed BEFORE it is judged", () => {
    // The thing that makes this worth a test: `shortcut` is spelled like a
    // folder in your own home directory, and resolve() alone says yes.
    expect(diskAllows(join(home, "shortcut"))).toBe(false);
    expect(diskAllows(join(home, "shortcut", "secret.txt"))).toBe(false);
  });

  test("a sibling whose name merely starts with home's is not inside it", () => {
    expect(diskAllows(`${home}-evil/x.txt`)).toBe(false);
  });

  test("an operator can name another root, and only they can", () => {
    process.env.AGENTGLASS_DISK_ROOTS = outside;
    try {
      expect(diskAllows(join(outside, "secret.txt"))).toBe(true);
      expect(diskAllows("/etc/shadow")).toBe(false);
    } finally { delete process.env.AGENTGLASS_DISK_ROOTS; }
  });

  test("the switch turns all of it off", () => {
    process.env.AGENTGLASS_DISK_DISABLED = "1";
    try {
      expect(diskAllows(docs)).toBe(false);
      expect(diskRoots()).toEqual([]);
      expect(diskFind(home, "evidence").ok).toBe(false);
      expect(diskPlaces().ok).toBe(false);
      // And the checkout browser must not become a way back in.
      expect(fileTree(docs, "").ok).toBe(false);
    } finally { delete process.env.AGENTGLASS_DISK_DISABLED; }
  });
});

describe("what the machine search answers", () => {
  test("a document nobody committed, found by a piece of its path", () => {
    const r = diskFind(home, "ORBIT-1042");
    expect(r.ok).toBe(true);
    expect(r.files).toContain("Documents/projects/PoL ORBIT-1042/evidence.md");
    expect(r.dirs).toContain("Documents/projects/PoL ORBIT-1042");
  });

  test("one letter is not a search", () => {
    const r = diskFind(home, "e");
    expect(r.ok).toBe(true);
    expect(r.files).toEqual([]);
  });

  test("hidden files are not among the answers", () => {
    const r = diskFind(home, "id_ed25519");
    expect(r.ok).toBe(true);
    expect(r.files).toEqual([]);
    expect(r.dirs).toEqual([]);
  });

  test("a query spelled like an fd option is a pattern, not an option", () => {
    // Measured before the fix: `--search-path=/etc` as the bare last word made
    // fd list /etc, and every line survived `keep()` because joining an
    // absolute path onto the root lands under the root. Now it is a string
    // to look for, and nothing here is called that.
    for (const q of ["--search-path=/etc", "--max-results=100000", "-H"]) {
      const r = diskFind(home, q);
      expect(r.ok).toBe(true);
      expect(r.files).toEqual([]);
      expect(r.dirs).toEqual([]);
    }
    // And a name that happens to start with a dash is still findable.
    writeFileSync(join(docs, "-draft-notes.md"), "leading dash\n");
    expect(diskFind(home, "-draft-notes").files).toContain("Documents/projects/PoL ORBIT-1042/-draft-notes.md");
  });

  test("the fd-less fallback answers the same question", () => {
    // Nothing reaches it on a machine with `fd` installed, which is exactly how
    // a fallback rots: the day it is needed is the day nobody has run it.
    const r = diskWalk(home, "ORBIT-1042");
    expect(r.ok).toBe(true);
    expect(r.via).toBe("walk");
    expect(r.files).toContain("Documents/projects/PoL ORBIT-1042/evidence.md");
    expect(r.dirs).toContain("Documents/projects/PoL ORBIT-1042");
    // And it does not wander into the places the other one is kept out of.
    expect(diskWalk(home, "id_ed25519").files).toEqual([]);
    expect(diskWalk(home, "secret.txt").files).toEqual([]);
  });

  test("a folder outside home is refused as a place to search from", () => {
    const r = diskFind(outside, "secret");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("outside");
  });
});

describe("reading what it found", () => {
  test("the viewer can open a document that is in no checkout", () => {
    const r = fileText(docs, join(docs, "evidence.md"));
    expect(r.ok).toBe(true);
    expect(r.text).toContain("what the fix proves");
  });

  test("and cannot be walked out of the place it was pointed at", () => {
    expect(fileText(docs, "../../../.ssh/id_ed25519").ok).toBe(false);
    expect(fileTree(home, ".ssh").ok).toBe(false);
    expect(fileTree(home, "shortcut").ok).toBe(false);
    expect(fileText(home, "shortcut/secret.txt").ok).toBe(false);
  });
});
