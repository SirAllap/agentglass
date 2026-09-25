/*
 * A path printed in the terminal becomes a link to the finder — but only a
 * path, only when it is there, and never a URL or half of a name with a space
 * in it. The detector is pure; "is it there" is the engine's answer, so the
 * test hands `linkTargets` a lookup of its own.
 */
import { describe, expect, test } from "bun:test";
import { pathCandidates, resolvePrinted } from "../src/lib/termPaths.ts";
import { linkTargets } from "../src/lib/termPathLinks.ts";

const texts = (line: string) => pathCandidates(line).map((c) => c.text);

describe("what looks like a path", () => {
  test("home, absolute, and dot-relative, with or without a trailing slash", () => {
    expect(texts("wrote ~/x/y/ and /abs/file.png and ./out/a.txt and ../up/b.txt")).toEqual([
      "~/x/y/", "/abs/file.png", "./out/a.txt", "../up/b.txt",
    ]);
    expect(texts("~/x/y")).toEqual(["~/x/y"]);
  });

  test("a bare relative path needs a slash in it", () => {
    expect(texts("see out/a.png now")).toEqual(["out/a.png"]);
    expect(texts("see a.png now")).toEqual([]);
  });

  test("the offsets point at the path, not at what is around it", () => {
    const line = "done: (~/x/y/a.png).";
    const [c] = pathCandidates(line);
    expect(line.slice(c!.start, c!.end)).toBe("~/x/y/a.png");
  });

  test("a sentence's full stop is not part of the path", () => {
    expect(texts("saved to ~/x/y/a.png.")).toEqual(["~/x/y/a.png"]);
  });

  test("a folder followed by a note in brackets is still the folder", () => {
    expect(texts("~/Documents/projects/acme/ORBIT-1042-demo/ (armA/01-shot.png)"))
      .toEqual(["~/Documents/projects/acme/ORBIT-1042-demo/", "armA/01-shot.png"]);
  });

  test("a path with spaces is NOT linked unless it is quoted", () => {
    // Unquoted, `~/My` is half of a name and linking it goes to the wrong folder.
    expect(texts("open ~/My Docs/plan.png please")).not.toContain("~/My");
    expect(texts("open ~/My Docs/plan.png please").some((t) => t.includes("~/My"))).toBe(false);
    expect(texts(`open "~/My Docs/plan.png" please`)).toEqual(["~/My Docs/plan.png"]);
    expect(texts("open '/abs/My Docs/plan.png' please")).toEqual(["/abs/My Docs/plan.png"]);
  });

  test("URLs are not paths", () => {
    expect(texts("go to https://example.com/a/b and http://localhost:4000/x/y")).toEqual([]);
    expect(texts("clone git@example.com:acme/orbit.git")).toEqual([]);
    expect(texts('curl "https://example.com/a/b"')).toEqual([]);
  });

  test("a path in the middle of a word is not a path", () => {
    expect(texts("key=~/x/y")).toEqual(["~/x/y"]);   // an assignment is a boundary
    expect(texts("src/a.ts:12:3: error")).toEqual(["src/a.ts"]);   // a place in a file is the file
    expect(texts("nothing~/here")).toEqual([]);
  });
});

describe("where a printed path points", () => {
  test("home, absolute, and relative to where the shell began", () => {
    expect(resolvePrinted("~/x/y/", "/home/me", "/home/me/code/orbit")).toBe("/home/me/x/y");
    expect(resolvePrinted("/abs/f.png", "/home/me", "/w")).toBe("/abs/f.png");
    expect(resolvePrinted("out/a.png", "/home/me", "/w/orbit")).toBe("/w/orbit/out/a.png");
    expect(resolvePrinted("../up/b.txt", "/home/me", "/w/orbit")).toBe("/w/up/b.txt");
  });

  test("no home or no folder means no answer rather than a wrong one", () => {
    expect(resolvePrinted("~/x", "", "/w")).toBeNull();
    expect(resolvePrinted("out/a.png", "/home/me", "")).toBeNull();
  });
});

describe("only what exists is linked", () => {
  const there = new Map<string, "dir" | "file">([["/home/me/x/y", "dir"], ["/abs/file.png", "file"]]);
  const lookup = async (abs: string) => there.get(abs) ?? null;

  test("a folder and a file that exist come back with their kind", async () => {
    const out = await linkTargets("~/x/y/ and /abs/file.png", "/home/me", "/w", lookup);
    expect(out.map((o) => [o.abs, o.kind])).toEqual([["/home/me/x/y", "dir"], ["/abs/file.png", "file"]]);
  });

  test("a path that does not exist is not linked", async () => {
    const out = await linkTargets("~/x/y/ and /abs/missing.png and and/or", "/home/me", "/w", lookup);
    expect(out.map((o) => o.abs)).toEqual(["/home/me/x/y"]);
  });

  test("a URL is never looked up at all", async () => {
    const asked: string[] = [];
    await linkTargets("https://example.com/a/b", "/home/me", "/w", async (a) => { asked.push(a); return "file"; });
    expect(asked).toEqual([]);
  });
});
