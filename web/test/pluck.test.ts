/*
 * Pluck: the tokens on a screen, newest first, each once, with the wrap undone.
 */
import { describe, expect, test } from "bun:test";
import { pluckTokens, unwrapRows, PLUCK_KEYS } from "../src/lib/pluck.ts";
import { isPluckChord } from "../src/lib/termKeys.ts";

const R = (text: string, wrapped = false) => ({ text, wrapped });

describe("the wrap", () => {
  test("a continuation row is joined to its head, so a link broken across two rows is one link", () => {
    const rows = [R("see https://example.test/a/very/long/path/that/wr"), R("aps/here.html and more", true), R("next")];
    expect(unwrapRows(rows).map((l) => l.text)).toEqual(["see https://example.test/a/very/long/path/that/wraps/here.html and more", "next"]);
    expect(pluckTokens(rows).find((t) => t.kind === "url")?.text).toBe("https://example.test/a/very/long/path/that/wraps/here.html");
  });
});

describe("the tokens", () => {
  test("paths with lines, links, hashes, ids and refs — newest row first, each once, trailing punctuation dropped", () => {
    const rows = [
      R("$ git log --oneline"),
      R("9fd4bcbe fix(lantern): the chat is known by its own prompt"),
      R("  wrote server/src/lantern.ts:145 and ~/code/app/web/src/x.tsx."),
      R("  session 8b1d2f3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f on branch feat/orbit-1042"),
      R("  see https://example.test/pr/166), then server/src/lantern.ts:145 again"),
    ];
    const got = pluckTokens(rows);
    expect(got[0]).toMatchObject({ text: "https://example.test/pr/166", kind: "url", row: 4 });
    expect(got.map((t) => t.text)).toContain("server/src/lantern.ts:145");
    expect(got.filter((t) => t.text === "server/src/lantern.ts:145")).toHaveLength(1);
    expect(got.map((t) => t.text)).toContain("~/code/app/web/src/x.tsx");
    expect(got.find((t) => t.kind === "uuid")?.text).toBe("8b1d2f3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f");
    expect(got.find((t) => t.kind === "ref")?.text).toBe("feat/orbit-1042");
    expect(got.find((t) => t.kind === "hash")?.text).toBe("9fd4bcbe");
    expect(got.map((t) => t.text)).not.toContain("--oneline");
  });
  test("a number with dots is not a path, a word of letters is not a hash, and the list is capped to the keys there are", () => {
    const rows = [R("version 1.2.3/4 at 12:30:45"), R("deadbeef cafebabe abcdefg 1234567")];
    const got = pluckTokens(rows);
    expect(got.map((t) => t.text)).not.toContain("1.2.3/4");
    expect(got.map((t) => t.text)).not.toContain("1234567");
    expect(got.map((t) => t.text)).not.toContain("abcdefg");
    const many = Array.from({ length: 40 }, (_, i) => R(`/tmp/file-${i}.txt`));
    expect(pluckTokens(many).length).toBeLessThanOrEqual(PLUCK_KEYS.length);
  });
});

describe("the chord", () => {
  test("Ctrl+Shift+Space, or Cmd+Shift+Space — never a bare space, never Alt", () => {
    expect(isPluckChord({ key: " ", ctrlKey: true, shiftKey: true })).toBe(true);
    expect(isPluckChord({ key: " ", metaKey: true, shiftKey: true })).toBe(true);
    expect(isPluckChord({ key: " ", ctrlKey: true })).toBe(false);
    expect(isPluckChord({ key: " " })).toBe(false);
    expect(isPluckChord({ key: " ", ctrlKey: true, shiftKey: true, altKey: true })).toBe(false);
    expect(isPluckChord({ key: "p", ctrlKey: true, shiftKey: true })).toBe(false);
  });
});

describe("a card id", () => {
  test("ORBIT-1042 is offered as a card, once, even when a branch also carries it", () => {
    const rows = [R("working on ORBIT-1042 now"), R("branch feat/ORBIT-1042-launch ORBIT-1042")];
    const got = pluckTokens(rows);
    expect(got.filter((t) => t.text === "ORBIT-1042")).toHaveLength(1);
    expect(got.find((t) => t.text === "ORBIT-1042")?.kind).toBe("card");
  });
  test("UTF-8 and SHA-256 are not cards", () => {
    const got = pluckTokens([R("encoding UTF-8 and SHA-256 and CVE-2024")]);
    expect(got.filter((t) => t.kind === "card").map((t) => t.text)).toEqual([]);
  });
});

describe("the second half of owner/repo is not a path", () => {
  test("acme/orbit#1051 does not offer /orbit, while a rooted path after a space still is one", () => {
    const got = pluckTokens([R("ORBIT-1042 failed in acme/orbit#1051 at /srv/app/run.ts:9")]).filter((t) => t.kind === "path").map((t) => t.text);
    expect(got).toEqual(["/srv/app/run.ts:9"]);
  });
});
