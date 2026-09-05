/*
 * The check every terminal-html.ts-dependent file runs before importing it.
 *
 * Both branches, against a real filesystem rather than by reading the check's
 * source: an empty directory is what a fresh worktree's `src/terminal/` looks
 * like, and a directory holding both generated files is what it looks like
 * after `npm ci`. Using temp directories rather than `src/terminal/` itself
 * means this file cannot delete or clobber a real build somebody actually ran.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allPresent, announce, why } from "./generated-artifacts.ts";

describe("whether the generated bundle is there", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test("an empty directory is not built", () => {
    dir = mkdtempSync(join(tmpdir(), "agx-generated-empty-"));
    expect(allPresent(dir)).toBe(false);
  });

  test("both generated files present is built", () => {
    dir = mkdtempSync(join(tmpdir(), "agx-generated-full-"));
    writeFileSync(join(dir, "nerdfont.generated.ts"), "export const x = 1;\n");
    writeFileSync(join(dir, "engine.generated.ts"), "export const y = 1;\n");
    expect(allPresent(dir)).toBe(true);
  });

  test("one of the two missing is still not built", () => {
    // The failure this guards: an `||` where the check meant `&&` would call a
    // half-built directory ready and the next import would still throw.
    dir = mkdtempSync(join(tmpdir(), "agx-generated-half-"));
    writeFileSync(join(dir, "nerdfont.generated.ts"), "export const x = 1;\n");
    expect(allPresent(dir)).toBe(false);
  });

  test("a directory that does not exist at all is not built", () => {
    // Pointing the resolver at a path with nothing behind it — no mkdtemp, no
    // rename, just a name nothing ever created.
    expect(allPresent(join(tmpdir(), "agx-generated-never-created-93f7"))).toBe(false);
  });
});

describe("the line printed when a file skips", () => {
  test("names the two commands that fix it", () => {
    expect(why).toContain("make mobile-test");
    expect(why).toContain("npm ci");
  });

  const logged = (fn: () => void): unknown[][] => {
    const calls: unknown[][] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => calls.push(args);
    try {
      fn();
    } finally {
      console.log = original;
    }
    return calls;
  };

  test("announce() logs the reason, naming the file, when not built", () => {
    const calls = logged(() => announce("some-file.test.ts", false));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toContain("some-file.test.ts");
    expect(calls[0]?.[0]).toContain(why);
  });

  test("announce() is silent when built", () => {
    // The other branch: with the bundle present, a file's tests just run —
    // nothing about it needs announcing.
    expect(logged(() => announce("some-file.test.ts", true))).toHaveLength(0);
  });
});
