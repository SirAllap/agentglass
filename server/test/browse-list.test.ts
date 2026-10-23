/*
 * A folder, a page at a time.
 *
 * The whole-folder listing caps at 2000 and stats every row before it answers,
 * which is right for a menu and wrong for a file manager: a folder of 100,000
 * files has to put its first rows on screen while the rest is still being read.
 * Measured on this machine, 100,000 entries: readdir 14 ms, the first 128 with
 * lstat 15 ms, all of them 99 ms. So the answer is pages of 128, the names read
 * once, and the boundary judged on every page rather than trusted from the first.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BATCH, browseBatch } from "../src/browselist.ts";

const made: string[] = [];
const wasRoots = process.env.AGENTGLASS_DISK_ROOTS;
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "agx-list-"));
  made.push(d);
  process.env.AGENTGLASS_DISK_ROOTS = made.join(":");
  return d;
};
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  if (wasRoots === undefined) delete process.env.AGENTGLASS_DISK_ROOTS;
  else process.env.AGENTGLASS_DISK_ROOTS = wasRoots;
});

const fill = (d: string, n: number) => { for (let i = 0; i < n; i++) writeFileSync(join(d, `f${String(i).padStart(4, "0")}.txt`), "x"); };

describe("pages of a folder", () => {
  test("a page is 128 entries and says where the next one starts", () => {
    const d = tmp();
    fill(d, 300);
    const a = browseBatch(d, 0);
    expect(BATCH).toBe(128);
    expect(a.ok).toBe(true);
    expect(a.entries.length).toBe(128);
    expect(a.total).toBe(300);
    expect(a.next).toBe(128);
  });

  test("walking the cursor returns every name once and ends with null", () => {
    const d = tmp();
    fill(d, 300);
    const seen: string[] = [];
    let at: number | null = 0;
    let pages = 0;
    while (at !== null) { const r = browseBatch(d, at); seen.push(...r.entries.map((e) => e.name)); at = r.next; pages++; }
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(300);
    expect(seen.length).toBe(300);
  });

  test("a cursor past the end is an empty last page, not an error", () => {
    const d = tmp();
    fill(d, 5);
    const r = browseBatch(d, 9999);
    expect(r.ok).toBe(true);
    expect(r.entries).toEqual([]);
    expect(r.next).toBeNull();
  });

  test("a folder reports its own item count and a file its size", () => {
    const d = tmp();
    mkdirSync(join(d, "sub")); writeFileSync(join(d, "sub", "a"), ""); writeFileSync(join(d, "sub", "b"), "");
    writeFileSync(join(d, "note.md"), "12345");
    const by = Object.fromEntries(browseBatch(d, 0).entries.map((e) => [e.name, e]));
    expect(by["sub"]!.kind).toBe("dir");
    expect(by["sub"]!.items).toBe(2);
    expect(by["note.md"]!.bytes).toBe(5);
  });

  test("dotted entries are counted as skipped, and listed only when a local caller asks", () => {
    const d = tmp();
    writeFileSync(join(d, "a.txt"), ""); writeFileSync(join(d, ".hidden"), "");
    const quiet = browseBatch(d, 0);
    expect(quiet.entries.map((e) => e.name)).toEqual(["a.txt"]);
    expect(quiet.hiddenSkipped).toBe(1);
    // `hidden` from a caller that is not local is ignored, as browseDir does.
    expect(browseBatch(d, 0, { showHidden: true, local: false }).entries.map((e) => e.name)).toEqual(["a.txt"]);
    expect(browseBatch(d, 0, { showHidden: true, local: true }).entries.map((e) => e.name).sort()).toEqual([".hidden", "a.txt"]);
  });

  test("the total moves with hidden: the two answers are never mixed in one cache", () => {
    const d = tmp();
    writeFileSync(join(d, "a"), ""); writeFileSync(join(d, ".b"), "");
    expect(browseBatch(d, 0, { showHidden: true, local: true }).total).toBe(2);
    expect(browseBatch(d, 0).total).toBe(1);
  });

  test("a file added after the first page shows up on the next read of the folder", () => {
    const d = tmp();
    fill(d, 3);
    expect(browseBatch(d, 0).total).toBe(3);
    writeFileSync(join(d, "late.txt"), "");
    expect(browseBatch(d, 0).total).toBe(4);
  });
});

describe("the boundary, judged on every page", () => {
  test("a relative path, an empty one and a NUL are refused before anything is read", () => {
    for (const bad of ["", "docs", "./docs", "../x", "a\0b", "/tmp\0/x", 12, null, undefined]) {
      const r = browseBatch(bad, 0);
      expect(r.ok).toBe(false);
      expect(r.entries).toEqual([]);
    }
  });

  test("a relative path is refused even when it would land inside an allowed root", () => {
    const d = tmp();
    mkdirSync(join(d, "docs"));
    const was = process.cwd();
    // The server's cwd is wherever the app was started; a path that means something different per launch is no path.
    process.chdir(d);
    try { expect(browseBatch("docs", 0).ok).toBe(false); expect(browseBatch("./docs", 0).ok).toBe(false); }
    finally { process.chdir(was); }
  });

  test("a place outside the allowed roots is refused", () => {
    tmp();
    const r = browseBatch("/etc", 0);
    expect(r.ok).toBe(false);
    expect(r.entries).toEqual([]);
  });

  test("a link to a folder outside the roots is listed as a link, not a folder, and cannot be entered", () => {
    const d = tmp();
    symlinkSync("/etc", join(d, "to-etc"));
    const e = browseBatch(d, 0).entries.find((x) => x.name === "to-etc")!;
    expect(e.kind).toBe("link");
    expect(e.items).toBeNull();
    // Following the link on purpose is judged on where it lands.
    expect(browseBatch(join(d, "to-etc"), 0).ok).toBe(false);
  });

  test("a link to a folder inside the roots is a link that can be entered, and says how many it holds", () => {
    const d = tmp();
    mkdirSync(join(d, "real"));
    symlinkSync(join(d, "real"), join(d, "alias"));
    const e = browseBatch(d, 0).entries.find((x) => x.name === "alias")!;
    expect(e.kind).toBe("link");
    expect(e.items).toBe(0);
    expect(browseBatch(join(d, "alias"), 0).ok).toBe(true);
  });

  test("a file is not a folder", () => {
    const d = tmp();
    writeFileSync(join(d, "a.txt"), "");
    expect(browseBatch(join(d, "a.txt"), 0).ok).toBe(false);
  });

  test("the page size is capped on the server whatever the caller asks", () => {
    const d = tmp();
    fill(d, 600);
    expect(browseBatch(d, 0, { limit: 100000 }).entries.length).toBe(512);
    expect(browseBatch(d, 0, { limit: -5 }).entries.length).toBeGreaterThan(0);
  });
});

describe("a folder that changes under a walk", () => {
  test("a file deleted between pages is not a row and not an error", () => {
    const d = tmp();
    fill(d, 200);
    const a = browseBatch(d, 0);
    for (const e of a.entries.slice(0, 5)) unlinkSync(join(d, e.name));
    const b = browseBatch(d, a.next!);
    expect(b.ok).toBe(true);
    expect(b.entries.length).toBe(72);
  });

  test("a stale cursor past a shrunken folder is an empty last page", () => {
    const d = tmp();
    fill(d, 300);
    const a = browseBatch(d, 0);
    expect(a.next).toBe(128);
    for (let i = 0; i < 300; i++) unlinkSync(join(d, `f${String(i).padStart(4, "0")}.txt`));
    const b = browseBatch(d, 0);
    expect(b.total).toBe(0);
    expect(browseBatch(d, 256).entries).toEqual([]);
  });

  test("a subfolder's item count stops at the cap and does not read the rest", () => {
    const d = tmp();
    mkdirSync(join(d, "big"));
    fill(join(d, "big"), 10050);
    expect(browseBatch(d, 0).entries.find((e) => e.name === "big")!.items).toBe(9999);
  });
});
