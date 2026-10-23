import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBookmarks, readBookmarks, toggleBookmark, toggledText } from "../src/bookmarks.ts";

// GTK's bookmarks file: one `uri label` per line, shared with every GTK file manager.
const SAMPLE = [
  "file:///home/ann/Documents Documents",
  "file:///home/ann/My%20Projects",
  "sftp://ann@10.0.0.7/home/ann Workstation",
  "smb://nas.local/share",
  "# not a bookmark",
  "",
  "file:///home/ann/Documents again",
  "relative/path nope",
].join("\n");

describe("parseBookmarks", () => {
  test("local lines carry a path, remote ones a label, junk and repeats are dropped", () => {
    const b = parseBookmarks(SAMPLE);
    expect(b.map((x) => x.label)).toEqual(["Documents", "My Projects", "Workstation", "nas.local"]);
    expect(b[1]!.path).toBe("/home/ann/My Projects");
    expect(b[2]!.path).toBeUndefined();
    expect(b[2]!.uri).toBe("sftp://ann@10.0.0.7/home/ann");
  });
  test("the root is not a place to pin", () => { expect(parseBookmarks("file:///")).toEqual([]); });
});

describe("toggledText", () => {
  test("adds a folder with its name, URL-encoded, and keeps every other line", () => {
    const t = toggledText("# keep me\nsftp://h/x Box\n", "/home/ann/My Projects");
    expect(t).toBe("# keep me\nsftp://h/x Box\nfile:///home/ann/My%20Projects My Projects\n");
  });
  test("removes it again, whatever label it had", () => {
    expect(toggledText("file:///a/b Mine\nsftp://h/x Box\n", "/a/b")).toBe("sftp://h/x Box\n");
  });
});

describe("toggleBookmark on a real file", () => {
  const dir = mkdtempSync(join(tmpdir(), "agx-bm-"));
  const was = process.env.XDG_CONFIG_HOME;
  beforeAll(() => { process.env.XDG_CONFIG_HOME = dir; });
  afterAll(() => { if (was === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = was; rmSync(dir, { recursive: true, force: true }); });
  test("creates the file, pins, then unpins", () => {
    expect(readBookmarks()).toEqual([]);
    const a = toggleBookmark("/srv/acme");
    expect(a.ok && a.bookmarks!.map((x) => x.path)).toEqual(["/srv/acme"]);
    expect(readFileSync(join(dir, "gtk-3.0", "bookmarks"), "utf8")).toBe("file:///srv/acme acme\n");
    const b = toggleBookmark("/srv/acme");
    expect(b.ok && b.bookmarks).toEqual([]);
  });
  test("refuses what is not an absolute folder", () => {
    for (const bad of ["rel", "/", "/a\nb", 5, undefined]) expect(toggleBookmark(bad).ok).toBe(false);
  });
  test("a file somebody else wrote keeps its comment lines through a toggle", () => {
    mkdirSync(join(dir, "gtk-3.0"), { recursive: true });
    writeFileSync(join(dir, "gtk-3.0", "bookmarks"), "# mine\nfile:///x/y Y\n");
    toggleBookmark("/x/z");
    expect(readFileSync(join(dir, "gtk-3.0", "bookmarks"), "utf8")).toBe("# mine\nfile:///x/y Y\nfile:///x/z z\n");
  });
});
