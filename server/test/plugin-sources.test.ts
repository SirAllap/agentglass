/*
 * The URL rules and the containment walk plugins.ts hands the copied tree
 * to before trusting any of it.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pluginGitUrlError, catalogueUrlError, pluginRefError, walkPluginDir, contentHash,
  MAX_FILES,
} from "../src/plugin-sources.ts";

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

  test("a symlink that stays inside the plugin directory is fine", () => {
    const d = dir();
    writeFileSync(join(d, "real.txt"), "hi");
    symlinkSync(join(d, "real.txt"), join(d, "link.txt"));
    const r = walkPluginDir(d);
    expect(r.ok).toBe(true);
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
});
