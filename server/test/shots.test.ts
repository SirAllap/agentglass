/*
 * Writing a file to disk from a string the renderer supplied.
 *
 * That sentence is the whole reason these tests exist. The one thing this must
 * not do is write whatever it was given, under a name it was also given: the
 * data comes from a page's screenshot and the name from a URL, and neither is
 * something to trust with a path.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { saveShot, __setShotDir } from "../src/shots.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-shots-"));
let here = "";

/** A real one-pixel PNG, so the magic-number check is exercised rather than
 *  worked around. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");
const url = (b: Buffer = PNG) => `data:image/png;base64,${b.toString("base64")}`;

beforeEach(() => {
  here = join(dir, Math.random().toString(36).slice(2));
  __setShotDir(here);
});
afterAll(() => { __setShotDir(null); rmSync(dir, { recursive: true, force: true }); });

describe("writing one", () => {
  it("puts the bytes on disk and says where", () => {
    const r = saveShot(url(), "page-markup");
    expect(r.ok).toBe(true);
    expect(r.path).toContain("page-markup");
    expect(readFileSync(r.path!)).toEqual(PNG);
  });

  it("makes the directory if it is not there yet", () => {
    expect(existsSync(here)).toBe(false);
    expect(saveShot(url(), "x").ok).toBe(true);
    expect(existsSync(here)).toBe(true);
  });

  it("never lets the name become a path", () => {
    // The name comes from a URL. If it could carry a slash it could carry
    // "../../.ssh/authorized_keys".
    const r = saveShot(url(), "../../escape");
    expect(r.ok).toBe(true);
    expect(dirname(r.path!)).toBe(here);
    expect(r.path).not.toContain("..");
  });

  it("survives a name that is nothing but punctuation", () => {
    const r = saveShot(url(), "///...///");
    expect(r.ok).toBe(true);
    expect(r.path).toContain("shot");
  });

  it("does not collide when two land in the same moment", () => {
    const a = saveShot(url(), "same", 1_000);
    const b = saveShot(url(), "same", 1_001);
    expect(a.path).not.toBe(b.path);
  });
});

describe("what it refuses", () => {
  it("anything that is not a PNG data URL", () => {
    expect(saveShot("data:image/jpeg;base64,AAAA", "x").error).toContain("only PNG");
    expect(saveShot("https://evil.test/x.png", "x").error).toContain("only PNG");
    expect(saveShot(null, "x").error).toContain("no image");
    expect(saveShot(123, "x").ok).toBe(false);
  });

  it("a PNG header with something else behind it", () => {
    // The prefix is the caller's claim; the magic number is the fact.
    const r = saveShot(`data:image/png;base64,${Buffer.from("#!/bin/sh\nrm -rf /\n").toString("base64")}`, "x");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not a PNG");
  });

  it("an empty image", () => {
    expect(saveShot("data:image/png;base64,", "x").error).toContain("empty");
  });

  it("one too big to be a screenshot", () => {
    const huge = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]);
    const r = saveShot(url(huge), "x");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("too big");
  });
});

describe("not accumulating", () => {
  it("sweeps yesterday's on the way past", () => {
    const old = saveShot(url(), "old");
    expect(old.ok).toBe(true);
    // Two days back.
    const then = Date.now() / 1000 - 2 * 24 * 3600;
    utimesSync(old.path!, then, then);
    saveShot(url(), "new");
    const left = readdirSync(here);
    expect(left.some((f) => f.startsWith("new"))).toBe(true);
    expect(left.some((f) => f.startsWith("old"))).toBe(false);
  });

  it("keeps one from an hour ago", () => {
    const recent = saveShot(url(), "recent");
    const then = Date.now() / 1000 - 3600;
    utimesSync(recent.path!, then, then);
    saveShot(url(), "another");
    expect(readdirSync(here).some((f) => f.startsWith("recent"))).toBe(true);
  });

  it("is not upset by a file it cannot stat", () => {
    saveShot(url(), "a");
    writeFileSync(join(here, "junk"), "");
    expect(saveShot(url(), "b").ok).toBe(true);
  });
});
