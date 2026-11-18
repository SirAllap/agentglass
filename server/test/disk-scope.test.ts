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
import { basename, join } from "node:path";
import { diskAllows, diskFind, diskGrep, diskPlaces, diskRoots, diskWalk } from "../src/disk.ts";
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

describe("searching inside files", () => {
  // `-I` is "skip binary files" to grep and "no file names" to ripgrep: with it
  // every hit came back without its path and the parser dropped all of them.
  test("finds text that is in a file, with its path and line", async () => {
    writeFileSync(join(docs, "notes.txt"), "first\nthe lantern is lit\n");
    const r = await diskGrep(docs, "lantern");
    expect(r.ok).toBe(true);
    expect(r.hits.map((h) => [basename(h.rel), h.line])).toEqual([["notes.txt", 2]]);
  });
});

// Two stalls of 9.7 s and 19.9 s were measured with the server's only thread
// waiting on ripgrep: the search was a blocking spawn.
const source = await Bun.file(new URL("../src/disk.ts", import.meta.url)).text();
describe("a search does not hold the server", () => {
  const at = source.indexOf("export async function diskGrep(");
  const body = source.slice(at, source.indexOf("\n}\n", at));

  test("it runs beside the loop: a timer ticks while it waits", async () => {
    writeFileSync(join(docs, "ticks.txt"), "the lantern again\n");
    // What runs, not a clock: a search that blocked the thread would hand back an already-answered promise, one that waits on the spawned process cannot answer within a microtask.
    const pending = diskGrep(docs, "lantern");
    let answered = false;
    void pending.then(() => { answered = true; });
    await Promise.resolve();
    expect(answered, "the search answered at once: it did not wait on a process").toBe(false);
    const r = await pending;
    expect(r.ok).toBe(true);
    expect(at).toBeGreaterThan(-1);
    expect(body).not.toContain("spawnSync");
  });

  test("a second search ends the first, and both answer", async () => {
    const [a, b] = await Promise.all([diskGrep(docs, "lantern"), diskGrep(docs, "lantern")]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(b.hits.length).toBeGreaterThan(0);
    expect(body).toContain("grepRunning?.kill();");
  });
});

describe("what the machine search may touch", () => {
  test("home, and what is under it", async () => {
    expect(diskRoots()).toEqual([home]);
    expect(diskAllows(home)).toBe(true);
    expect(diskAllows(docs)).toBe(true);
    expect(diskAllows(join(docs, "evidence.md"))).toBe(true);
  });

  test("nothing above home", async () => {
    expect(diskAllows("/etc")).toBe(false);
    expect(diskAllows("/etc/shadow")).toBe(false);
    expect(diskAllows(outside)).toBe(false);
    expect(diskAllows(join(home, ".."))).toBe(false);
  });

  test("nothing hidden — the dot is the rule, not a list of names", async () => {
    expect(diskAllows(join(home, ".ssh"))).toBe(false);
    expect(diskAllows(join(home, ".ssh", "id_ed25519"))).toBe(false);
    expect(diskAllows(join(home, ".config", "agentglass", "token"))).toBe(false);
  });

  test("a symlink out of home is followed BEFORE it is judged", async () => {
    // The thing that makes this worth a test: `shortcut` is spelled like a
    // folder in your own home directory, and resolve() alone says yes.
    expect(diskAllows(join(home, "shortcut"))).toBe(false);
    expect(diskAllows(join(home, "shortcut", "secret.txt"))).toBe(false);
  });

  test("a sibling whose name merely starts with home's is not inside it", async () => {
    expect(diskAllows(`${home}-evil/x.txt`)).toBe(false);
  });

  test("an operator can name another root, and only they can", async () => {
    process.env.AGENTGLASS_DISK_ROOTS = outside;
    try {
      expect(diskAllows(join(outside, "secret.txt"))).toBe(true);
      expect(diskAllows("/etc/shadow")).toBe(false);
    } finally { delete process.env.AGENTGLASS_DISK_ROOTS; }
  });

  test("a root reached through a symlink (e.g. macOS /var -> /private/var) is allowed", async () => {
    const linkedRoot = join(home, "linked-mount");
    symlinkSync(outside, linkedRoot);
    process.env.AGENTGLASS_DISK_ROOTS = linkedRoot;
    try {
      expect(diskAllows(linkedRoot)).toBe(true);
      expect(diskAllows(join(linkedRoot, "secret.txt"))).toBe(true);
      expect(diskAllows(join(outside, "secret.txt"))).toBe(true);
    } finally {
      delete process.env.AGENTGLASS_DISK_ROOTS;
      rmSync(linkedRoot, { force: true });
    }
  });

  test("the switch turns all of it off", async () => {
    process.env.AGENTGLASS_DISK_DISABLED = "1";
    try {
      expect(diskAllows(docs)).toBe(false);
      expect(diskRoots()).toEqual([]);
      expect((await diskFind(home, "evidence")).ok).toBe(false);
      expect(diskPlaces().ok).toBe(false);
      // And the checkout browser must not become a way back in.
      expect((await fileTree(docs, "")).ok).toBe(false);
    } finally { delete process.env.AGENTGLASS_DISK_DISABLED; }
  });
});

const diskSource = await Bun.file(new URL("../src/disk.ts", import.meta.url)).text();

describe("what the machine search answers", () => {
  test("a document nobody committed, found by a piece of its path", async () => {
    const r = await diskFind(home, "ORBIT-1042");
    expect(r.ok).toBe(true);
    expect(r.files).toContain("Documents/projects/PoL ORBIT-1042/evidence.md");
    expect(r.dirs).toContain("Documents/projects/PoL ORBIT-1042");
  });

  test("one letter is not a search", async () => {
    const r = await diskFind(home, "e");
    expect(r.ok).toBe(true);
    expect(r.files).toEqual([]);
  });

  test("hidden files are not among the answers", async () => {
    const r = await diskFind(home, "id_ed25519");
    expect(r.ok).toBe(true);
    expect(r.files).toEqual([]);
    expect(r.dirs).toEqual([]);
  });

  test("a query found only in the root's own name matches nothing under it", async () => {
    // fd matches the absolute path, so `-H` under a root called `agx-home-Hk2j9x`
    // (one mkdtemp name in 62 starts that way) listed every file in it, and a
    // query for the folder's own name did the same on every run. The root is
    // not part of what is being searched.
    const own = basename(home);
    for (const q of [own, own.toUpperCase(), tmpdir().slice(1), `${basename(home).slice(0, 5)}-`]) {
      const r = await diskFind(home, q);
      expect(r.ok).toBe(true);
      expect(r.files, q).toEqual([]);
      expect(r.dirs, q).toEqual([]);
    }
    // ...and a name below the root that happens to contain regex syntax is
    // still a plain string.
    writeFileSync(join(docs, "a+b (1).md"), "x\n");
    expect((await diskFind(home, "a+b (1)")).files).toContain("Documents/projects/PoL ORBIT-1042/a+b (1).md");
    expect((await diskFind(home, "a.b")).files).toEqual([]);
  });

  test("a query spelled like an fd option is a pattern, not an option", async () => {
    // Measured before the fix: `--search-path=/etc` as the bare last word made
    // fd list /etc, and every line survived `keep()` because joining an
    // absolute path onto the root lands under the root. Now it is a string
    // to look for, and nothing here is called that.
    for (const q of ["--search-path=/etc", "--max-results=100000", "-H"]) {
      const r = await diskFind(home, q);
      expect(r.ok).toBe(true);
      expect(r.files).toEqual([]);
      expect(r.dirs).toEqual([]);
    }
    // And a name that happens to start with a dash is still findable.
    writeFileSync(join(docs, "-draft-notes.md"), "leading dash\n");
    expect((await diskFind(home, "-draft-notes")).files).toContain("Documents/projects/PoL ORBIT-1042/-draft-notes.md");
  });

  test("the fd-less fallback answers the same question", async () => {
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

  // Same class as the content search that froze the installed app for 20 s at
  // a time: this one was a blocking fd with a 10 s limit on the only thread.
  test("the search runs beside the loop: a timer ticks while fd walks", async () => {
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 1);
    const r = await diskFind(home, "ORBIT-1042");
    clearInterval(timer);
    expect(r.ok).toBe(true);
    expect(r.files).toContain("Documents/projects/PoL ORBIT-1042/evidence.md");
    if (r.via === "fd") expect(ticks).toBeGreaterThan(0);
    const at = diskSource.indexOf("export async function diskFind(");
    expect(at).toBeGreaterThan(-1);
    const code = diskSource.slice(at, diskSource.indexOf("\n}\n", at)).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    expect(code).not.toContain("spawnSync");
    expect(code).toContain("latest: `disk-find:${root}`");
  });

  test("a folder outside home is refused as a place to search from", async () => {
    const r = await diskFind(outside, "secret");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("outside");
  });
});

describe("reading what it found", () => {
  test("the viewer can open a document that is in no checkout", async () => {
    const r = await fileText(docs, join(docs, "evidence.md"));
    expect(r.ok).toBe(true);
    expect(r.text).toContain("what the fix proves");
  });

  test("and cannot be walked out of the place it was pointed at", async () => {
    expect((await fileText(docs, "../../../.ssh/id_ed25519")).ok).toBe(false);
    expect((await fileTree(home, ".ssh")).ok).toBe(false);
    expect((await fileTree(home, "shortcut")).ok).toBe(false);
    expect((await fileText(home, "shortcut/secret.txt")).ok).toBe(false);
  });
});
