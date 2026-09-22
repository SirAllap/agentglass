/*
 * The URL rules and the containment walk plugins.ts hands the copied tree
 * to before trusting any of it.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  pluginGitUrlError, catalogueUrlError, pluginRefError, walkPluginDir, contentHash, hashPath, linkText,
  MAX_FILES,
} from "../src/plugin-sources.ts";

const SOURCES = await Bun.file(new URL("../src/plugin-sources.ts", import.meta.url)).text();

describe("pluginGitUrlError", () => {
  test("a plain https URL with no credentials is fine", () => {
    expect(pluginGitUrlError("https://example.com/someone/plugin.git")).toBeNull();
  });

  test("an ssh URL is fine", () => {
    expect(pluginGitUrlError("ssh://git@example.com/someone/plugin.git")).toBeNull();
  });

  test("scp-like git@host:path is fine", () => {
    expect(pluginGitUrlError("git@example.com:someone/plugin.git")).toBeNull();
  });

  test("https with a username or password is refused", () => {
    expect(pluginGitUrlError("https://user:pass@example.com/p.git")).toContain("credentials");
    expect(pluginGitUrlError("https://token@example.com/p.git")).toContain("credentials");
  });

  test("plain http is refused, not silently accepted", () => {
    expect(pluginGitUrlError("http://example.com/p.git")).not.toBeNull();
  });

  test("a leading dash is refused before it ever reaches git", () => {
    expect(pluginGitUrlError("--upload-pack=x")).not.toBeNull();
  });
});

describe("catalogueUrlError", () => {
  test("https with no credentials is fine", () => {
    expect(catalogueUrlError("https://example.com/catalogue.json")).toBeNull();
  });
  test("ssh is not a catalogue transport", () => {
    expect(catalogueUrlError("ssh://example.com/catalogue.json")).not.toBeNull();
  });
  test("credentials in the URL are refused", () => {
    expect(catalogueUrlError("https://u:p@example.com/catalogue.json")).not.toBeNull();
  });
});

describe("pluginRefError", () => {
  test("omitted is fine", () => {
    expect(pluginRefError(null)).toBeNull();
    expect(pluginRefError(undefined)).toBeNull();
  });
  test("an ordinary tag or branch is fine", () => {
    expect(pluginRefError("v1.0.0")).toBeNull();
  });
  test("a ref that looks like a flag is refused", () => {
    expect(pluginRefError("--upload-pack=x")).not.toBeNull();
  });
});

describe("walkPluginDir", () => {
  function dir(): string {
    return mkdtempSync(join(tmpdir(), "agx-walk-"));
  }

  test("an ordinary small tree walks fine", () => {
    const d = dir();
    writeFileSync(join(d, "a.txt"), "hello");
    mkdirSync(join(d, "sub"));
    writeFileSync(join(d, "sub", "b.txt"), "world");
    const r = walkPluginDir(d);
    expect(r.ok).toBe(true);
    expect(r.files.sort()).toEqual(["a.txt", "sub/b.txt"]);
  });

  test(".git is skipped entirely", () => {
    const d = dir();
    mkdirSync(join(d, ".git"));
    writeFileSync(join(d, ".git", "HEAD"), "ref: refs/heads/main");
    writeFileSync(join(d, "a.txt"), "hello");
    const r = walkPluginDir(d);
    expect(r.ok).toBe(true);
    expect(r.files).toEqual(["a.txt"]);
  });

  test("a symlink that escapes the plugin directory is refused", () => {
    const d = dir();
    const outside = mkdtempSync(join(tmpdir(), "agx-outside-"));
    writeFileSync(join(outside, "secret"), "not yours");
    symlinkSync(join(outside, "secret"), join(d, "link"));
    const r = walkPluginDir(d);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("outside");
  });

  test("a symlink that stays inside the plugin directory is fine, and is one of its entries", () => {
    const d = dir();
    writeFileSync(join(d, "real.txt"), "hi");
    symlinkSync("real.txt", join(d, "link.txt"));
    const r = walkPluginDir(d);
    expect(r.ok).toBe(true);
    expect(r.files.sort()).toEqual(["link.txt", "real.txt"]);
  });

  /*
   * The walk runs on a staging folder and the plugin is then copied
   * somewhere else, so a link is judged by what it says, not only by where
   * it lands today. An absolute one names the staging folder and dangles in
   * the copy; one that climbs out and back in by the folder's own name finds
   * a different folder once the plugin is installed under another.
   */
  test("a link to an absolute path is refused, even one that lands inside", () => {
    const d = dir();
    writeFileSync(join(d, "real.txt"), "hi");
    symlinkSync(join(d, "real.txt"), join(d, "link.txt"));
    const r = walkPluginDir(d);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("link.txt");
  });

  test("a link that climbs out and back in by the folder's name is refused", () => {
    const d = dir();
    writeFileSync(join(d, "real.txt"), "hi");
    symlinkSync(join("..", basename(d), "real.txt"), join(d, "link.txt"));
    const r = walkPluginDir(d);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("outside");
  });

  test("more than the file cap is refused", () => {
    const d = dir();
    for (let i = 0; i <= MAX_FILES; i++) writeFileSync(join(d, `f${i}`), "x");
    const r = walkPluginDir(d);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("files");
  });
});

describe("contentHash", () => {
  test("deterministic regardless of the order files are listed in", () => {
    const d = mkdtempSync(join(tmpdir(), "agx-hash-"));
    writeFileSync(join(d, "a.txt"), "one");
    writeFileSync(join(d, "b.txt"), "two");
    const h1 = contentHash(d, ["a.txt", "b.txt"]);
    const h2 = contentHash(d, ["b.txt", "a.txt"]);
    expect(h1).toBe(h2);
  });

  test("changes when a file's bytes change", () => {
    const d = mkdtempSync(join(tmpdir(), "agx-hash-"));
    writeFileSync(join(d, "a.txt"), "one");
    const before = contentHash(d, ["a.txt"]);
    writeFileSync(join(d, "a.txt"), "changed");
    const after = contentHash(d, ["a.txt"]);
    expect(before).not.toBe(after);
  });

  /*
   * What runs is what the entrypoint names, and a link decides that as much
   * as a file does. Both scripts were in the tree from the first commit; an
   * update that only points the link at the other one used to hash the
   * same, keep its approval, and run something nobody had agreed to.
   */
  test("changes when a link inside the folder is pointed at another file", () => {
    const d = mkdtempSync(join(tmpdir(), "agx-hash-"));
    writeFileSync(join(d, "good.sh"), "echo good\n");
    writeFileSync(join(d, "evil.sh"), "echo evil\n");
    symlinkSync("good.sh", join(d, "run.sh"));
    const before = contentHash(d, walkPluginDir(d).files);
    rmSync(join(d, "run.sh"));
    symlinkSync("evil.sh", join(d, "run.sh"));
    expect(walkPluginDir(d).ok).toBe(true);
    expect(contentHash(d, walkPluginDir(d).files)).not.toBe(before);
  });

  test("a link is not a file that holds its target's name", () => {
    const d = mkdtempSync(join(tmpdir(), "agx-hash-"));
    writeFileSync(join(d, "good.sh"), "echo good\n");
    symlinkSync("good.sh", join(d, "run.sh"));
    const linked = contentHash(d, walkPluginDir(d).files);
    rmSync(join(d, "run.sh"));
    writeFileSync(join(d, "run.sh"), "good.sh");
    expect(contentHash(d, walkPluginDir(d).files)).not.toBe(linked);
  });

  /*
   * Names and bytes used to be run together with NULs between them, and a
   * NUL is a byte a file may hold: one file carrying the next entry inside
   * it hashed exactly like the two files it spelled out.
   */
  test("one file cannot pass for two", () => {
    const one = mkdtempSync(join(tmpdir(), "agx-hash-"));
    writeFileSync(join(one, "a.txt"), "x\0run.sh\0echo pwned\n");
    const two = mkdtempSync(join(tmpdir(), "agx-hash-"));
    writeFileSync(join(two, "a.txt"), "x");
    writeFileSync(join(two, "run.sh"), "echo pwned\n");
    expect(contentHash(one, ["a.txt"])).not.toBe(contentHash(two, ["a.txt", "run.sh"]));
  });
});

/*
 * The catalogue's hash is made on Linux, and a Windows install has to reach
 * the same value from the same commit. Windows spells a path inside the
 * plugin with `\\`, and Git for Windows writes a link's target with it too,
 * so both are read with `/` before they are hashed. There is no Windows in
 * this test run: the two rules are tested where they are decided, and the
 * walk and the hash are held to going through them.
 */
describe("a path and a link read the same on Windows", () => {
  test("a path inside the plugin is spelled with / whatever the separator", () => {
    expect(hashPath("lib\\deep\\b.py", "\\")).toBe("lib/deep/b.py");
    expect(hashPath("lib/deep/b.py", "/")).toBe("lib/deep/b.py");
  });

  test("a link's target reads with / on Windows, and as written anywhere else", () => {
    expect(linkText(Buffer.from("lib\\a.py"), "win32").toString()).toBe("lib/a.py");
    expect(linkText(Buffer.from("odd\\name"), "linux").toString()).toBe("odd\\name");
  });

  const body = (name: string): string => {
    const from = SOURCES.indexOf(`export function ${name}(`);
    expect(from, `${name} is still there`).toBeGreaterThan(-1);
    return SOURCES.slice(from, SOURCES.indexOf("\n}\n", from));
  };

  test("the walk names every entry through the first and the hash reads every link through the second", () => {
    expect(body("walkPluginDir")).toContain("hashPath(relative(root, child))");
    expect(body("walkPluginDir")).not.toMatch(/files\.push\(relative\(/);
    expect(body("contentHash")).toContain("linkText(readlinkSync(");
  });
});
