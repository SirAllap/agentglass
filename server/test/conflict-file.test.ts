/*
 * The whole conflicted file, not the conflicts on their own.
 *
 * The parser always produced the text between the blocks — `splitConflicts`
 * has returned `{segments, blocks}` from the day it was written — and the
 * endpoint threw the text away. So the screen showed two competing fragments
 * with nothing around them, which is the complaint that killed the first
 * version of this feature: you cannot judge two versions of a line without the
 * code they sit in.
 *
 * What these tests pin, beyond "the text comes back":
 *
 *   - the line numbers are the file's REAL ones, markers included, because
 *     that is what nvim shows when the panel jumps you to a conflict, and a
 *     second numbering that disagrees with the editor is worse than none;
 *   - the stamp changes when the file changes, and a resolve carrying a stale
 *     one is refused — the count check alone misses a rewrite that keeps the
 *     number of conflicts the same.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-cfile-")));
process.env.AGENTGLASS_ROOT = dir;
const { conflictFile, resolveBlocks, contentStamp } = await import("../src/gitwork.ts");

let repo = "";
const git = (...args: string[]) =>
  Bun.spawnSync(["git", "-c", "user.email=t@e.st", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...args], { cwd: repo });

/**
 * A file whose conflicts are surrounded by code, and separated by more of it —
 * the shape the fragment view could not show.
 */
const FILE = [
  "import { readFileSync } from 'node:fs';",       // 1
  "",                                               // 2
  "export function load(path: string) {",           // 3
  "<<<<<<< HEAD",                                   // 4
  "  const raw = readFileSync(path, 'utf8');",      // 5
  "  return JSON.parse(raw);",                      // 6
  "=======",                                        // 7
  "  return JSON.parse(readFileSync(path));",       // 8
  ">>>>>>> feat",                                   // 9
  "}",                                              // 10
  "",                                               // 11
  "export const VERSION = 2;",                      // 12
  "<<<<<<< HEAD",                                   // 13
  "export const RETRIES = 3;",                      // 14
  "=======",                                        // 15
  "export const RETRIES = 5;",                      // 16
  ">>>>>>> feat",                                   // 17
  "",                                               // 18
].join("\n");

beforeEach(() => {
  repo = join(dir, `r-${Math.random().toString(36).slice(2)}`);
  Bun.spawnSync(["mkdir", "-p", repo]);
  git("init", "-q", "-b", "main", ".");
  writeFileSync(join(repo, "load.ts"), "seed\n");
  git("add", "-A"); git("commit", "-qm", "seed");
  writeFileSync(join(repo, "load.ts"), FILE);
});
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe("the file comes back whole", () => {
  it("keeps the code around the conflicts, not just the conflicts", () => {
    const r = conflictFile(repo, "load.ts");
    expect(r.ok).toBe(true);
    const text = r.segments.filter((s) => s.kind === "text").flatMap((s) => (s as { lines: string[] }).lines);
    expect(text).toContain("export function load(path: string) {");
    expect(text).toContain("export const VERSION = 2;");
  });

  it("alternates text and conflict in the order they appear", () => {
    const r = conflictFile(repo, "load.ts");
    expect(r.segments.map((s) => s.kind)).toEqual(["text", "conflict", "text", "conflict", "text"]);
  });

  it("finds both conflicts and numbers them from zero", () => {
    const r = conflictFile(repo, "load.ts");
    expect(r.blocks.map((b) => b.index)).toEqual([0, 1]);
    expect(r.blocks[1]!.ours).toEqual(["export const RETRIES = 3;"]);
    expect(r.blocks[1]!.theirs).toEqual(["export const RETRIES = 5;"]);
  });

  it("counts the lines, so a caller can decide to window it", () => {
    expect(conflictFile(repo, "load.ts").lines).toBe(18);
  });
});

describe("the line numbers are the file's own", () => {
  it("starts the first run of text at line 1", () => {
    const first = conflictFile(repo, "load.ts").segments[0] as { from: number; lines: string[] };
    expect(first.from).toBe(1);
    expect(first.lines).toHaveLength(3);
  });

  it("puts each conflict where the marker really is", () => {
    const [a, b] = conflictFile(repo, "load.ts").blocks;
    expect(a!.line).toBe(4);
    expect(b!.line).toBe(13);
  });

  it("numbers each side's first line and the closing marker", () => {
    const [a] = conflictFile(repo, "load.ts").blocks;
    expect(a!.ourLine).toBe(5);
    expect(a!.theirLine).toBe(8);
    expect(a!.endLine).toBe(9);
  });

  it("resumes the numbering after a conflict, not from zero", () => {
    // The run between the two conflicts is lines 10..12 of the real file. Get
    // this wrong and every jump-to-editor below the first conflict is off.
    const mid = conflictFile(repo, "load.ts").segments[2] as { from: number; lines: string[] };
    expect(mid.from).toBe(10);
    expect(mid.lines).toEqual(["}", "", "export const VERSION = 2;"]);
  });

  it("agrees with the file on disk, line for line", () => {
    // The strongest form of the claim: read the file, and every located line
    // must be at the number it was given.
    const disk = readFileSync(join(repo, "load.ts"), "utf8").split("\n");
    const r = conflictFile(repo, "load.ts");
    for (const s of r.segments) {
      if (s.kind !== "text") continue;
      s.lines.forEach((l, i) => expect(disk[s.from + i - 1]).toBe(l));
    }
    for (const b of r.blocks) {
      expect(disk[b.line - 1]).toStartWith("<<<<<<<");
      expect(disk[b.endLine! - 1]).toStartWith(">>>>>>>");
      expect(disk[b.ourLine! - 1]).toBe(b.ours[0]!);
      expect(disk[b.theirLine! - 1]).toBe(b.theirs[0]!);
    }
  });

  it("handles a conflict that starts on line 1, with no text before it", () => {
    writeFileSync(join(repo, "load.ts"), ["<<<<<<< HEAD", "a", "=======", "b", ">>>>>>> feat", "tail"].join("\n"));
    const r = conflictFile(repo, "load.ts");
    expect(r.segments.map((s) => s.kind)).toEqual(["conflict", "text"]);
    expect(r.blocks[0]!.line).toBe(1);
    expect((r.segments[1] as { from: number }).from).toBe(6);
  });

  it("locates a diff3 conflict past its base section", () => {
    // With merge.conflictStyle=diff3 there is a third section, and forgetting
    // it puts every line below the marker off by its length.
    writeFileSync(join(repo, "load.ts"), [
      "head", "<<<<<<< HEAD", "ours", "||||||| base", "was", "this", "=======", "theirs", ">>>>>>> feat", "tail",
    ].join("\n"));
    const b = conflictFile(repo, "load.ts").blocks[0]!;
    expect(b.base).toEqual(["was", "this"]);
    expect(b.ourLine).toBe(3);
    expect(b.theirLine).toBe(8);
    expect(b.endLine).toBe(9);
  });
});

describe("the stamp", () => {
  it("is the same for the same bytes and different for different ones", () => {
    expect(contentStamp("abc")).toBe(contentStamp("abc"));
    expect(contentStamp("abc")).not.toBe(contentStamp("abd"));
  });

  it("refuses a resolve made against a parse that no longer exists", () => {
    // The case the count check cannot see: something rewrote the file and left
    // the same NUMBER of conflicts. Applying the old choices then resolves the
    // wrong block with the wrong side, and reports success.
    const stale = conflictFile(repo, "load.ts").stamp;
    writeFileSync(join(repo, "load.ts"), FILE.replace("RETRIES = 3", "RETRIES = 4"));
    const r = resolveBlocks(repo, "load.ts", ["ours", "ours"], stale);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("changed since you opened it");
  });

  it("lets a resolve through when the file is untouched", () => {
    const { stamp } = conflictFile(repo, "load.ts");
    expect(resolveBlocks(repo, "load.ts", ["ours", "theirs"], stamp).ok).toBe(true);
    const out = readFileSync(join(repo, "load.ts"), "utf8");
    expect(out).toContain("const raw = readFileSync(path, 'utf8');");
    expect(out).toContain("export const RETRIES = 5;");
    expect(out).not.toContain("<<<<<<<");
  });

  it("still works for a caller that sends no stamp", () => {
    // conflictBlocks() and its callers predate this and are not being changed.
    expect(resolveBlocks(repo, "load.ts", ["ours", "ours"]).ok).toBe(true);
  });
});

/**
 * The answer that is neither side.
 *
 * Four fixed choices cover the conflicts where one branch is simply right.
 * They do not cover the ordinary one: two people changed the same function for
 * different reasons and the resolution is a third thing. Without this the file
 * had to leave the app for an editor, which is most of the reason the resolver
 * went unused.
 */
describe("writing a block by hand", () => {
  const read = () => readFileSync(join(repo, "load.ts"), "utf8");

  it("writes exactly the lines given, in place of the whole region", () => {
    const r = resolveBlocks(repo, "load.ts", [
      { edit: ["  const raw = readFileSync(path, 'utf8');", "  return JSON.parse(raw) as Config;"] },
      "theirs",
    ]);
    expect(r.ok).toBe(true);
    const out = read();
    expect(out).toContain("return JSON.parse(raw) as Config;");
    expect(out).toContain("export const RETRIES = 5;");
    expect(out).not.toContain("<<<<<<<");
    expect(out).not.toContain("=======");
  });

  it("mixes with the fixed sides, block by block", () => {
    expect(resolveBlocks(repo, "load.ts", ["ours", { edit: ["export const RETRIES = 4;"] }]).ok).toBe(true);
    expect(read()).toContain("export const RETRIES = 4;");
  });

  it("accepts an empty edit as deleting the region", () => {
    // "Neither side, and nothing in their place" is a real resolution — both
    // branches added a line the merge no longer needs.
    expect(resolveBlocks(repo, "load.ts", ["ours", { edit: [] }]).ok).toBe(true);
    const out = read();
    expect(out).not.toContain("RETRIES");
    expect(out).toContain("export const VERSION = 2;");
  });

  it("refuses an edit that would put conflict markers back in the file", () => {
    // The one that corrupts rather than annoys: git stages it as RESOLVED
    // while the file still reads as conflicted, so the next parse finds a
    // conflict git does not know about and the commit carries the markers.
    const r = resolveBlocks(repo, "load.ts", ["ours", { edit: ["<<<<<<< HEAD", "x"] }]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("conflict markers");
    expect(read()).toContain("<<<<<<<");  // nothing was written
  });

  it("refuses each of the three marker kinds, not only the first", () => {
    for (const marker of ["<<<<<<< x", "=======", ">>>>>>> y", "||||||| base"]) {
      expect(resolveBlocks(repo, "load.ts", ["ours", { edit: [marker] }]).ok).toBe(false);
    }
  });

  it("refuses a blob pretending to be lines", () => {
    // The reassembly joins with "\n", so an embedded newline would produce a
    // line count nobody chose — and quietly shift every number below it.
    const r = resolveBlocks(repo, "load.ts", ["ours", { edit: ["one\ntwo"] }]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("split into lines");
  });

  it("refuses a shape that is not a choice at all", () => {
    expect(resolveBlocks(repo, "load.ts", ["ours", { nope: 1 }]).ok).toBe(false);
    expect(resolveBlocks(repo, "load.ts", ["ours", null]).ok).toBe(false);
    expect(resolveBlocks(repo, "load.ts", ["ours", { edit: [1, 2] }]).ok).toBe(false);
  });

  it("caps how much one block may carry", () => {
    const r = resolveBlocks(repo, "load.ts", ["ours", { edit: Array.from({ length: 5001 }, () => "x") }]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("5000 lines");
  });

  it("stages the result, which is what marks the file resolved", () => {
    // Asserted as "it is in the index", not as "--diff-filter=U is empty":
    // this fixture writes markers without running a merge, so the unmerged
    // list is empty either way and that assertion would pass for a resolve
    // that never staged anything.
    resolveBlocks(repo, "load.ts", [{ edit: ["  return null;"] }, "ours"]);
    expect(git("diff", "--name-only", "--cached").stdout.toString().trim()).toBe("load.ts");
  });
});

describe("what it refuses", () => {
  it("says a binary file has to be resolved whole", () => {
    writeFileSync(join(repo, "load.ts"), Buffer.from([0x89, 0x50, 0x00, 0x4e, 0x47]));
    const r = conflictFile(repo, "load.ts");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("resolve it whole");
  });

  it("refuses a path outside the repository", () => {
    expect(conflictFile(repo, "../../../etc/passwd").ok).toBe(false);
  });

  it("reports a file with no conflicts as a file with no conflicts", () => {
    // Not an error: it is what you get the moment somebody else resolves it.
    writeFileSync(join(repo, "load.ts"), "all settled\n");
    const r = conflictFile(repo, "load.ts");
    expect(r.ok).toBe(true);
    expect(r.blocks).toEqual([]);
    expect(r.segments).toHaveLength(1);
  });
});
