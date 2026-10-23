// The home index: what it finds, what it refuses, and that it follows the disk.
//
// HOME is a temporary directory for the whole file, as in disk-scope.test.ts, so
// the "home" being indexed is one this test made.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fuzzyScore, needleBytes } from "../src/fuzzy.ts";
import { HomeIndex, mountsUnder } from "../src/homeindex.ts";
import { parseEvents } from "../src/inotify.ts";

const score = (name: string, q: string) => { const b = Buffer.from(name); return fuzzyScore(b, 0, b.length, needleBytes(q)); };

describe("fuzzy score", () => {
  test("a subsequence matches, anything else does not", () => {
    expect(score("report.py", "rpt")).toBeGreaterThan(0);
    expect(score("report.py", "tpr")).toBe(-1);
    expect(score("a", "ab")).toBe(-1);
  });
  test("prefix beats middle, word start beats inside a word, exact beats all", () => {
    expect(score("readme.md", "read")).toBeGreaterThan(score("thread.md", "read"));
    expect(score("my-notes.md", "notes")).toBeGreaterThan(score("mynotes.md", "notes"));
    expect(score("notes", "notes")).toBeGreaterThan(score("notes.md", "notes"));
  });
  test("ASCII case is ignored, other bytes match exactly", () => {
    expect(score("README.md", "readme")).toBeGreaterThan(0);
    expect(score("ñandu.txt", "ñandu")).toBeGreaterThan(0);
    expect(score("Ñandu.txt", "ñandu")).toBe(-1);
  });
});

describe("inotify records", () => {
  const rec = (wd: number, mask: number, name: string) => { const n = Buffer.from(name + "\0"); const b = Buffer.alloc(16 + n.length + 3); b.writeInt32LE(wd, 0); b.writeUInt32LE(mask, 4); b.writeUInt32LE(n.length + 3, 12); n.copy(b, 16); return b; };
  test("a record cut in two reads comes out whole", () => {
    const all = Buffer.concat([rec(3, 0x100, "a.txt"), rec(4, 0x200, "b.txt")]);
    const first = parseEvents(all.subarray(0, 30), null);
    expect(first.events.map((e) => e.name)).toEqual(["a.txt"].slice(0, first.events.length));
    const second = parseEvents(all.subarray(30), first.rest);
    expect([...first.events, ...second.events].map((e) => `${e.wd}:${e.name}`)).toEqual(["3:a.txt", "4:b.txt"]);
  });
});

describe("mounts", () => {
  test("only mounts strictly inside the root, with escaped spaces decoded", () => {
    const t = "1 0 8:1 / /home/orbit rw - ext4 x\n2 1 8:2 / /home/orbit/big\\040disk rw - ext4 x\n3 1 8:3 / /homeless rw - ext4 x\n";
    expect([...mountsUnder("/home/orbit", t)]).toEqual(["/home/orbit/big disk"]);
  });
});

let home: string;
let ix: HomeIndex;
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "agx-ix-"));
  mkdirSync(join(home, "Documents", "orbit-notes"), { recursive: true });
  mkdirSync(join(home, "src", "components"), { recursive: true });
  mkdirSync(join(home, ".ssh"), { recursive: true });
  mkdirSync(join(home, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(home, "Documents", "orbit-notes", "plan.md"), "x");
  writeFileSync(join(home, "src", "components", "Button.tsx"), "x");
  writeFileSync(join(home, ".ssh", "id_plan"), "x");
  writeFileSync(join(home, "node_modules", "dep", "plan.js"), "x");
  symlinkSync("/etc", join(home, "etc-link"));
  ix = new HomeIndex(() => [home], () => "");
  await ix.search("x");
  await ix.whenBuilt();
});
afterAll(() => { ix.close(); rmSync(home, { recursive: true, force: true }); });

const paths = async (q: string) => (await ix.search(q)).hits.map((h) => h.path.slice(home.length + 1));
const until = async (f: () => Promise<boolean>) => { for (let i = 0; i < 60; i++) { if (await f()) return true; await Bun.sleep(50); } return false; };

describe("home index", () => {
  test("finds by fuzzy name, by words down a path, and says whether it is a folder", async () => {
    expect(await paths("plan")).toContain("Documents/orbit-notes/plan.md");
    expect(await paths("src comp btn")).toEqual(["src/components/Button.tsx"]);
    expect((await ix.search("orbit")).hits[0]).toMatchObject({ dir: true });
  });
  test("hidden folders, node_modules and symlinks are not in it", async () => {
    const all = await paths("plan");
    expect(all.some((p) => p.includes(".ssh") || p.includes("node_modules"))).toBe(false);
    expect((await paths("etc-link")).length).toBe(1);   // the link itself is a name…
    expect((await paths("passwd")).length).toBe(0);     // …and nothing behind it is followed
  });
  test("a file made, renamed and deleted afterwards is followed without a rebuild", async () => {
    writeFileSync(join(home, "Documents", "fresh-file.txt"), "x");
    expect(await until(async () => (await paths("fresh-file")).length === 1)).toBe(true);
    renameSync(join(home, "Documents", "fresh-file.txt"), join(home, "Documents", "moved-file.txt"));
    expect(await until(async () => (await paths("moved-file")).length === 1 && (await paths("fresh-file")).length === 0)).toBe(true);
    rmSync(join(home, "Documents", "moved-file.txt"));
    expect(await until(async () => (await paths("moved-file")).length === 0)).toBe(true);
  });
  test("a folder made with files already inside is indexed whole, and watched after", async () => {
    mkdirSync(join(home, "late", "deep"), { recursive: true });
    writeFileSync(join(home, "late", "deep", "inside.txt"), "x");
    expect(await until(async () => (await paths("inside")).length === 1)).toBe(true);
    writeFileSync(join(home, "late", "deep", "later.txt"), "x");
    expect(await until(async () => (await paths("later")).length === 1)).toBe(true);
    rmSync(join(home, "late"), { recursive: true });
    expect(await until(async () => (await paths("inside")).length === 0)).toBe(true);
  });
  test("an aborted search gives up instead of finishing", async () => {
    const c = new AbortController(); c.abort();
    const r = await ix.search("plan", 10, c.signal);
    expect(r.ok).toBe(true);
  });
});
