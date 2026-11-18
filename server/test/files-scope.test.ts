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
    const r = await fileTree(repo, "");
    expect(r.ok).toBe(true);
    expect(r.entries.map((e) => e.name).sort()).toEqual(["README.md", "src"]);
    // Directories first is the order a tree is scanned in.
    expect(r.entries[0]!.dir).toBe(true);
  });

  test("a subdirectory is reached by its relative path", async () => {
    const { fileTree } = await files();
    const r = await fileTree(repo, "src");
    expect(r.ok).toBe(true);
    expect(r.entries.map((e) => e.rel)).toEqual(["src/a.ts"]);
  });

  test("`..` does not climb out", async () => {
    const { fileTree } = await files();
    expect((await fileTree(repo, "../..")).ok).toBe(false);
    expect((await fileTree(repo, "src/../../..")).ok).toBe(false);
    expect((await fileTree(repo, "../outside")).ok).toBe(false);
  });

  test("an absolute rel is still resolved against the root, not obeyed", async () => {
    const { fileTree } = await files();
    // resolve(root, "/etc") is "/etc" — which is exactly why the check is on the
    // RESULT rather than on the string that was sent.
    expect((await fileTree(repo, "/etc")).ok).toBe(false);
  });

  test("a NUL in the path is refused rather than truncated by the syscall", async () => {
    const { fileTree } = await files();
    expect((await fileTree(repo, "src\0/../../..")).ok).toBe(false);
  });

  test("a root outside the workspace is refused whatever it is", async () => {
    const { fileTree } = await files();
    const r = await fileTree(outside, "");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("outside");
  });

  test("a sibling whose name merely starts with the root's is not inside it", async () => {
    // "/a/bc" is not in "/a/b", and a startsWith test says it is.
    const { fileTree } = await files();
    mkdirSync(`${repo}-evil`, { recursive: true });
    writeFileSync(join(`${repo}-evil`, "x.txt"), "x\n");
    try {
      const r = await fileTree(repo, "../repo-evil");
      expect(r.ok).toBe(false);
    } finally {
      rmSync(`${repo}-evil`, { recursive: true, force: true });
    }
  });

  test("nothing, or something that is not a directory, is refused", async () => {
    const { fileTree } = await files();
    expect((await fileTree("", "")).ok).toBe(false);
    expect((await fileTree(join(repo, "README.md"), "")).ok).toBe(false);
    expect((await fileTree(join(repo, "nope"), "")).ok).toBe(false);
  });

  test(".git is machinery, not content", async () => {
    const { fileTree } = await files();
    mkdirSync(join(repo, ".git", "objects"), { recursive: true });
    try {
      expect((await fileTree(repo, "")).entries.some((e) => e.name === ".git")).toBe(false);
    } finally {
      rmSync(join(repo, ".git"), { recursive: true, force: true });
    }
  });

  test("a broken symlink is skipped, not a thrown listing", async () => {
    const { fileTree } = await files();
    symlinkSync(join(box, "gone"), join(repo, "dangling"));
    try {
      const r = await fileTree(repo, "");
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
    expect((await findFiles(outside, "secret")).ok).toBe(false);
    expect((await grepFiles(outside, "not yours")).ok).toBe(false);
  });

  test("one letter is not a content search", async () => {
    // Same floor the in-review search uses: every file matches "a".
    const { grepFiles } = await files();
    const r = await grepFiles(repo, "a");
    expect(r.ok).toBe(true);
    expect(r.hits).toEqual([]);
  });
});

// The machine-wide twin of this search froze the installed app for 20 s at a
// time: a blocking spawn on the server's one thread. This one had the same
// shape with a 15 s limit.
const filesSource = await Bun.file(new URL("../src/files.ts", import.meta.url)).text();

describe("a content search does not hold the server", () => {
  test("runs beside the loop: a timer ticks while it searches, and the hit is the same", async () => {
    const { grepFiles } = await files();
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 1);
    const r = await grepFiles(repo, "export const");
    clearInterval(timer);
    expect(r.ok).toBe(true);
    if (r.via === "rg") {
      expect(r.hits.map((h) => [h.rel, h.line, h.text])).toEqual([["src/a.ts", 1, "export const a = 1;"]]);
      expect(ticks).toBeGreaterThan(0);
    }
  });

  test("has no blocking spawn left, and a newer search of the checkout ends the older", async () => {
    const at = filesSource.indexOf("export async function grepFiles(");
    expect(at).toBeGreaterThan(-1);
    const code = filesSource.slice(at, filesSource.indexOf("\n}\n", at)).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    expect(code).not.toContain("spawnSync");
    expect(code.split("latest: grepKey").length - 1).toBe(3);
  });
});
