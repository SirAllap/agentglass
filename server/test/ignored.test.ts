import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markIgnored } from "../src/ignored.ts";

/**
 * Against a real repository, because the whole point of asking git is that
 * .gitignore has nested files, negations and per-directory rules that any
 * reimplementation would get subtly wrong.
 */
let repo: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "agx-ignored-"));
  const git = (...args: string[]) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(repo, ".gitignore"), "dist/\n*.log\n!keep.log\n");
  mkdirSync(join(repo, "dist"), { recursive: true });
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "app.ts"), "export {}\n");
  writeFileSync(join(repo, "dist", "bundle.js"), "// built\n");
  writeFileSync(join(repo, "noise.log"), "junk\n");
  writeFileSync(join(repo, "keep.log"), "kept\n");
});

afterAll(() => { try { rmSync(repo, { recursive: true, force: true }); } catch { /* fine */ } });

describe("markIgnored", () => {
  it("marks ignored paths and leaves tracked ones alone", () => {
    const m = markIgnored([
      join(repo, "src", "app.ts"),
      join(repo, "dist", "bundle.js"),
      join(repo, "noise.log"),
    ]);
    expect(m.get(join(repo, "src", "app.ts"))).toBe(false);
    expect(m.get(join(repo, "dist", "bundle.js"))).toBe(true);
    expect(m.get(join(repo, "noise.log"))).toBe(true);
  });

  it("honours a negation, which is why git is asked rather than a glob", () => {
    const m = markIgnored([join(repo, "keep.log")]);
    expect(m.get(join(repo, "keep.log"))).toBe(false);
  });

  it("reports a path outside any repo as not ignored", () => {
    // "We don't know" must never hide something from the review list.
    const m = markIgnored(["/definitely/not/a/repo/file.ts"]);
    expect(m.get("/definitely/not/a/repo/file.ts")).toBe(false);
  });

  it("answers for every path it was given", () => {
    const paths = [join(repo, "src", "app.ts"), join(repo, "dist", "bundle.js"), "/nowhere/x.ts"];
    const m = markIgnored(paths);
    for (const p of paths) expect(m.has(p)).toBe(true);
  });
});
