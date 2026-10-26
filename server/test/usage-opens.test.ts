/*
 * The local "what gets opened" count: ids are the window's own short names, a
 * batch adds, the file survives a restart, and nothing else gets into it.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetOpens, readOpens, recordOpens } from "../src/usageopens.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-usage-opens-"));
const prev = process.env.AGENTGLASS_STATE_DIR;
process.env.AGENTGLASS_STATE_DIR = dir;
const FILE = join(dir, "usage-opens.json");
const day = (iso: string) => new Date(`${iso}T12:00:00Z`);

beforeEach(() => { rmSync(FILE, { force: true }); __resetOpens(); });
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  if (prev === undefined) delete process.env.AGENTGLASS_STATE_DIR; else process.env.AGENTGLASS_STATE_DIR = prev;
});

describe("counting", () => {
  test("a batch adds to the id, and the last date moves to the day of the batch", () => {
    expect(recordOpens({ "view:git": 2, "settings:about": 1 }, day("2026-10-20"))).toEqual({ ok: true, recorded: 3 });
    recordOpens({ "view:git": 3 }, day("2026-10-22"));
    const out = readOpens(day("2026-10-22"));
    expect(out.since).toBe("2026-10-20");
    expect(out.opens).toEqual([
      { id: "view:git", count: 5, last: "2026-10-22" },
      { id: "settings:about", count: 1, last: "2026-10-20" },
    ]);
  });

  test("most opened first, then the most recent, then the name", () => {
    recordOpens({ "panel:stats": 1, "panel:help": 1, "view:term": 4 }, day("2026-10-20"));
    recordOpens({ "panel:stats": 1 }, day("2026-10-21"));
    expect(readOpens().opens.map((r) => r.id)).toEqual(["view:term", "panel:stats", "panel:help"]);
  });

  test("it survives a restart: the file is read again, and one a hand broke starts a new count", () => {
    recordOpens({ "view:docker": 7 }, day("2026-10-20"));
    __resetOpens();
    expect(readOpens().opens).toEqual([{ id: "view:docker", count: 7, last: "2026-10-20" }]);
    writeFileSync(FILE, "{not json");
    __resetOpens();
    expect(readOpens().opens).toEqual([]);
  });

  test("the file is the whole record, and it holds counts and dates only", () => {
    recordOpens({ "view:git": 1 }, day("2026-10-20"));
    expect(JSON.parse(readFileSync(FILE, "utf8"))).toEqual({ since: "2026-10-20", rows: { "view:git": { count: 1, last: "2026-10-20" } } });
  });
});

describe("what is refused, whole", () => {
  test.each([
    ["an id with a path in it", { "/home/ana/code": 1 }],
    ["an id with a space", { "view git": 1 }],
    ["an id that is too long", { ["a".repeat(65)]: 1 }],
    ["a count of zero", { "view:git": 0 }],
    ["a fraction", { "view:git": 1.5 }],
    ["a count as text", { "view:git": "3" }],
    ["a count past a batch", { "view:git": 1001 }],
    ["a list", ["view:git"]],
    ["nothing at all", null],
  ])("%s", (_name, batch) => {
    expect(recordOpens(batch, day("2026-10-20")).ok).toBe(false);
    expect(readOpens().opens).toEqual([]);
    expect(existsSync(FILE)).toBe(false);
  });

  test("one bad id in a batch keeps the good ones out too", () => {
    expect(recordOpens({ "view:git": 1, "bad id": 1 }).ok).toBe(false);
    expect(readOpens().opens).toEqual([]);
  });

  test("the table has a ceiling on distinct ids", () => {
    const many = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`panel:p${i}`, 1]));
    expect(recordOpens(many).ok).toBe(true);
    expect(recordOpens({ "panel:one-more": 1 }).ok).toBe(false);
    expect(recordOpens({ "panel:p0": 1 }).ok).toBe(true);
  });
});
