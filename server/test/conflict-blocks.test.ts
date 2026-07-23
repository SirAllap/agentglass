import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { conflictBlocks, resolveBlocks } from "../src/gitwork.ts";

/**
 * Resolving one conflict at a time.
 *
 * The bug this feature exists to prevent is subtle: with two unrelated
 * conflicts in a file, taking `ours` wholesale to settle the first also
 * discards whatever the other branch did in the second, and the result
 * compiles, commits and looks fine. So the tests that matter are the ones where
 * the choices differ per block.
 */
let dir = "";
const git = (...a: string[]) => spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });

const CONFLICTED = [
  "top of the file",
  "<<<<<<< HEAD",
  "our first change",
  "=======",
  "their first change",
  ">>>>>>> feature",
  "middle",
  "<<<<<<< HEAD",
  "our second change",
  "=======",
  "their second change",
  ">>>>>>> feature",
  "bottom",
].join("\n");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agx-conflict-"));
  // The write path is scope-guarded, so the repo has to be inside the open
  // project the way it is in real use.
  process.env.AGENTGLASS_ROOT = dir;
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  writeFileSync(join(dir, "a.txt"), "seed\n");
  git("add", "-A"); git("commit", "-qm", "seed");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (text: string) => writeFileSync(join(dir, "a.txt"), text);
const read = () => readFileSync(join(dir, "a.txt"), "utf8");

describe("conflict blocks", () => {
  it("finds every region with its sides and labels", () => {
    write(CONFLICTED);
    const r = conflictBlocks(dir, "a.txt");
    expect(r.ok).toBe(true);
    expect(r.blocks.length).toBe(2);
    expect(r.blocks[0]!.ours).toEqual(["our first change"]);
    expect(r.blocks[0]!.theirs).toEqual(["their first change"]);
    expect(r.blocks[0]!.ourLabel).toBe("HEAD");
    expect(r.blocks[0]!.theirLabel).toBe("feature");
    expect(r.blocks[0]!.line).toBe(2);
    expect(r.blocks[1]!.index).toBe(1);
  });

  it("keeps a different side per block — the whole point", () => {
    write(CONFLICTED);
    const r = resolveBlocks(dir, "a.txt", ["ours", "theirs"]);
    expect(r.ok).toBe(true);
    expect(read()).toBe([
      "top of the file", "our first change", "middle", "their second change", "bottom",
    ].join("\n"));
    // ...and staged, so `continue` can see it as settled.
    expect(git("diff", "--name-only", "--diff-filter=U").stdout.trim()).toBe("");
  });

  it("can keep both sides, in either order", () => {
    write(CONFLICTED);
    resolveBlocks(dir, "a.txt", ["both", "theirs-first"]);
    const out = read().split("\n");
    expect(out.slice(1, 3)).toEqual(["our first change", "their first change"]);
    expect(out.slice(4, 6)).toEqual(["their second change", "our second change"]);
  });

  it("reads the ancestor when diff3 recorded one", () => {
    write([
      "<<<<<<< HEAD", "mine", "||||||| merged common ancestors", "original", "=======", "yours", ">>>>>>> other",
    ].join("\n"));
    const b = conflictBlocks(dir, "a.txt").blocks[0]!;
    expect(b.base).toEqual(["original"]);
    expect(b.ours).toEqual(["mine"]);
    expect(b.theirs).toEqual(["yours"]);
  });

  it("refuses a stale parse rather than resolving the wrong block", () => {
    // The client saw two conflicts; by the time it acts the file has one. Off
    // by one here means choice 2 lands on block 1 and looks successful.
    write(CONFLICTED);
    const r = resolveBlocks(dir, "a.txt", ["ours"]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("2 conflicts");
    expect(read()).toBe(CONFLICTED); // untouched
  });

  it("leaves a file that merely contains the characters alone", () => {
    // A README quoting conflict markers is not a conflicted file, and an
    // unterminated block must not swallow the rest of the document.
    const doc = ["intro", "<<<<<<< HEAD", "an example nobody closed", "more prose"].join("\n");
    write(doc);
    const r = conflictBlocks(dir, "a.txt");
    expect(r.ok).toBe(true);
    expect(r.blocks.length).toBe(0);
    expect(resolveBlocks(dir, "a.txt", []).ok).toBe(false);
    expect(read()).toBe(doc);
  });

  it("rejects a path outside the repo", () => {
    expect(conflictBlocks(dir, "../../etc/passwd").ok).toBe(false);
    expect(resolveBlocks(dir, "../../etc/passwd", ["ours"]).ok).toBe(false);
  });

  it("rejects an unknown choice instead of writing something surprising", () => {
    write(CONFLICTED);
    expect(resolveBlocks(dir, "a.txt", ["ours", "delete-everything"]).ok).toBe(false);
    expect(read()).toBe(CONFLICTED);
  });

  it("says so for a binary file rather than rendering its bytes", () => {
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "sub", "b.bin"), Buffer.from([0x41, 0x00, 0x42]));
    const r = conflictBlocks(dir, "sub/b.bin");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("binary");
  });

  // The reassembly bug: an empty plain run at a file boundary or between two
  // adjacent conflicts used to be joined with "\n" and inject a blank line into
  // the staged file — a silent drift from what the user resolved.
  it("does not add a blank line for a conflict at the very start of the file", () => {
    write(["<<<<<<< HEAD", "mine", "=======", "yours", ">>>>>>> feature", "after"].join("\n"));
    expect(resolveBlocks(dir, "a.txt", ["ours"]).ok).toBe(true);
    expect(read()).toBe(["mine", "after"].join("\n")); // no leading blank
  });

  it("does not add a blank line for a conflict at the very end of the file", () => {
    write(["before", "<<<<<<< HEAD", "mine", "=======", "yours", ">>>>>>> feature"].join("\n"));
    expect(resolveBlocks(dir, "a.txt", ["theirs"]).ok).toBe(true);
    expect(read()).toBe(["before", "yours"].join("\n")); // no trailing blank
  });

  it("does not add a blank line between two adjacent conflicts", () => {
    write([
      "<<<<<<< HEAD", "a1", "=======", "b1", ">>>>>>> feature",
      "<<<<<<< HEAD", "a2", "=======", "b2", ">>>>>>> feature",
    ].join("\n"));
    expect(resolveBlocks(dir, "a.txt", ["ours", "theirs"]).ok).toBe(true);
    expect(read()).toBe(["a1", "b2"].join("\n")); // no blank at start or between
  });

  it("survives a real merge conflict end to end", () => {
    writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n");
    git("add", "-A"); git("commit", "-qm", "base");
    git("checkout", "-qb", "other");
    writeFileSync(join(dir, "a.txt"), "one\nTHEIRS\nthree\n");
    git("add", "-A"); git("commit", "-qm", "theirs");
    git("checkout", "-q", "main");
    writeFileSync(join(dir, "a.txt"), "one\nOURS\nthree\n");
    git("add", "-A"); git("commit", "-qm", "ours");
    git("merge", "other");

    const blocks = conflictBlocks(dir, "a.txt").blocks;
    expect(blocks.length).toBe(1);
    expect(blocks[0]!.ours).toEqual(["OURS"]);
    expect(blocks[0]!.theirs).toEqual(["THEIRS"]);
    expect(resolveBlocks(dir, "a.txt", ["both"]).ok).toBe(true);
    expect(read()).toBe("one\nOURS\nTHEIRS\nthree\n");
    expect(git("diff", "--name-only", "--diff-filter=U").stdout.trim()).toBe("");
  });
});
