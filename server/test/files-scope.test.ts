// The boundary on the file browser.
//
// This is the part that matters. `fileTree` reads a directory off a path the
// client sent, so the only thing standing between "browse my checkout" and "a
// file server for the whole machine" is the resolution below. A regression here
// is not a broken feature, it is a hole — and it would not show up in any
// screenshot, because the panel would look exactly the same.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT0 = process.env.AGENTGLASS_ROOT;
let box: string;   // the "workspace"
let repo: string;  // a checkout inside it
let outside: string;

beforeAll(() => {
  box = mkdtempSync(join(tmpdir(), "agx-files-"));
  repo = join(box, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(repo, "README.md"), "# hi\n");
  outside = mkdtempSync(join(tmpdir(), "agx-outside-"));
  writeFileSync(join(outside, "secret.txt"), "not yours\n");
  process.env.AGENTGLASS_ROOT = box;
});

afterAll(() => {
  if (ROOT0 === undefined) delete process.env.AGENTGLASS_ROOT; else process.env.AGENTGLASS_ROOT = ROOT0;
  rmSync(box, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

/** Imported lazily: config.ts caches the scope on first read, and the env has
 *  to be set before that happens. */
const files = async () => await import("../src/files.ts");

describe("fileTree stays inside the checkout", () => {
  test("lists what is actually there", async () => {
    const { fileTree } = await files();
    const r = fileTree(repo, "");
    expect(r.ok).toBe(true);
    expect(r.entries.map((e) => e.name).sort()).toEqual(["README.md", "src"]);
    // Directories first is the order a tree is scanned in.
    expect(r.entries[0]!.dir).toBe(true);
  });

  test("a subdirectory is reached by its relative path", async () => {
    const { fileTree } = await files();
    const r = fileTree(repo, "src");
    expect(r.ok).toBe(true);
    expect(r.entries.map((e) => e.rel)).toEqual(["src/a.ts"]);
  });

  test("`..` does not climb out", async () => {
    const { fileTree } = await files();
    expect(fileTree(repo, "../..").ok).toBe(false);
    expect(fileTree(repo, "src/../../..").ok).toBe(false);
    expect(fileTree(repo, "../outside").ok).toBe(false);
  });

  test("an absolute rel is still resolved against the root, not obeyed", async () => {
    const { fileTree } = await files();
    // resolve(root, "/etc") is "/etc" — which is exactly why the check is on the
    // RESULT rather than on the string that was sent.
    expect(fileTree(repo, "/etc").ok).toBe(false);
  });

  test("a NUL in the path is refused rather than truncated by the syscall", async () => {
    const { fileTree } = await files();
    expect(fileTree(repo, "src\0/../../..").ok).toBe(false);
  });

  test("a root outside the workspace is refused whatever it is", async () => {
    const { fileTree } = await files();
    const r = fileTree(outside, "");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("outside");
  });

  test("a sibling whose name merely starts with the root's is not inside it", async () => {
    // "/a/bc" is not in "/a/b", and a startsWith test says it is.
    const { fileTree } = await files();
    mkdirSync(`${repo}-evil`, { recursive: true });
    writeFileSync(join(`${repo}-evil`, "x.txt"), "x\n");
    try {
      const r = fileTree(repo, "../repo-evil");
      expect(r.ok).toBe(false);
    } finally {
      rmSync(`${repo}-evil`, { recursive: true, force: true });
    }
  });

  test("nothing, or something that is not a directory, is refused", async () => {
    const { fileTree } = await files();
    expect(fileTree("", "").ok).toBe(false);
    expect(fileTree(join(repo, "README.md"), "").ok).toBe(false);
    expect(fileTree(join(repo, "nope"), "").ok).toBe(false);
  });

  test(".git is machinery, not content", async () => {
    const { fileTree } = await files();
    mkdirSync(join(repo, ".git", "objects"), { recursive: true });
    try {
      expect(fileTree(repo, "").entries.some((e) => e.name === ".git")).toBe(false);
    } finally {
      rmSync(join(repo, ".git"), { recursive: true, force: true });
    }
  });

  test("a broken symlink is skipped, not a thrown listing", async () => {
    const { fileTree } = await files();
    symlinkSync(join(box, "gone"), join(repo, "dangling"));
    try {
      const r = fileTree(repo, "");
      expect(r.ok).toBe(true);
      expect(r.entries.some((e) => e.name === "dangling")).toBe(false);
    } finally {
      rmSync(join(repo, "dangling"), { force: true });
    }
  });
});

describe("search is held to the same boundary", () => {
  test("find and grep both refuse a root outside the workspace", async () => {
    const { findFiles, grepFiles } = await files();
    expect(findFiles(outside, "secret").ok).toBe(false);
    expect(grepFiles(outside, "not yours").ok).toBe(false);
  });

  test("one letter is not a content search", async () => {
    // Same floor the in-review search uses: every file matches "a".
    const { grepFiles } = await files();
    const r = grepFiles(repo, "a");
    expect(r.ok).toBe(true);
    expect(r.hits).toEqual([]);
  });
});
