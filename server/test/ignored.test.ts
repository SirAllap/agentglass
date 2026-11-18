import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
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
  it("marks ignored paths and leaves tracked ones alone", async () => {
    const m = await markIgnored([
      join(repo, "src", "app.ts"),
      join(repo, "dist", "bundle.js"),
      join(repo, "noise.log"),
    ]);
    expect(m.get(join(repo, "src", "app.ts"))).toBe(false);
    expect(m.get(join(repo, "dist", "bundle.js"))).toBe(true);
    expect(m.get(join(repo, "noise.log"))).toBe(true);
  });

  it("honours a negation, which is why git is asked rather than a glob", async () => {
    const m = await markIgnored([join(repo, "keep.log")]);
    expect(m.get(join(repo, "keep.log"))).toBe(false);
  });

  it("reports a path outside any repo as not ignored", async () => {
    // "We don't know" must never hide something from the review list.
    const m = await markIgnored(["/definitely/not/a/repo/file.ts"]);
    expect(m.get("/definitely/not/a/repo/file.ts")).toBe(false);
  });

  it("answers for every path it was given", async () => {
    const paths = [join(repo, "src", "app.ts"), join(repo, "dist", "bundle.js"), "/nowhere/x.ts"];
    const m = await markIgnored(paths);
    for (const p of paths) expect(m.has(p)).toBe(true);
  });

  it("does not hold the event loop while git runs (was a spawnSync on the only thread)", async () => {
    // Fresh paths: the 15 s cache must not answer for them.
    const paths = Array.from({ length: 40 }, (_, i) => join(repo, "dist", `fresh-${i}.js`));
    let ticks = 0;
    const t = setInterval(() => { ticks++; }, 1);
    const m = await markIgnored(paths);
    clearInterval(t);
    expect(m.get(paths[0]!)).toBe(true);
    // A blocking spawn leaves the interval no chance to run until it returns.
    expect(ticks).toBeGreaterThan(0);
  });

  it("source holds no synchronous spawn", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "ignored.ts"), "utf8");
    expect(src).not.toMatch(/node:child_process|Bun\.spawnSync|[^.\w]spawnSync\(/);
  });
});
