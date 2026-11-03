/*
 * A checkout whose node_modules is not there yet.
 *
 * The failure this pins is measured, not imagined: a worktree cut from this repo
 * had `node_modules` as a symlink to the main checkout's and no
 * `web/node_modules`, and `cd web && bunx tsc --noEmit` answered
 * `TS2688: Cannot find type definition file for 'vite/client'`. Nothing about
 * that line says "the environment", so it is read as a type error in the change
 * and costs an hour of reading code that is fine.
 *
 * Two halves, and both are what the rest of the app leans on: the sentence in
 * front of a worker's first prompt, and the same sentence from the command
 * `make typecheck` runs first — driven against the real script, because the
 * thing being asserted is that a check which could not run does not exit 0.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeModulesGap, withDepsLine } from "../src/checkoutDeps.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const DEPSCHECK = join(REPO, "scripts", "depscheck.ts");

const trash: string[] = [];
afterEach(() => { for (const d of trash.splice(0)) rmSync(d, { recursive: true, force: true }); });

/**
 * A checkout shaped like this one: a root that installs and workspaces under it.
 * A workspace declares a dependency unless `dependent` says otherwise, because
 * bun installs nothing beside a workspace that has none.
 */
function checkout(workspaces: string[], installed: string[], dependent: (w: string) => boolean = () => true): string {
  const dir = mkdtempSync(join(tmpdir(), "agx-deps-test-"));
  trash.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "orbit", private: true, workspaces }));
  for (const w of workspaces) {
    mkdirSync(join(dir, w), { recursive: true });
    writeFileSync(join(dir, w, "package.json"), JSON.stringify({ name: `orbit-${w}`, ...(dependent(w) ? { dependencies: { "orbit-shared": "1.0.0" } } : {}) }));
  }
  for (const d of installed) mkdirSync(join(dir, d, "node_modules"), { recursive: true });
  return dir;
}

const depscheck = (dir: string) =>
  spawnSync("bun", [DEPSCHECK, dir], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });

describe("a checkout that cannot run its own checks", () => {
  test("the root linked and the workspaces not is still missing: a typecheck here is the environment", () => {
    const dir = checkout(["server", "web"], ["", "server"]);
    const gap = nodeModulesGap(dir);
    expect(gap?.missing).toEqual(["web"]);
    expect(gap?.line).toStartWith("environment: node_modules missing (web/node_modules)");
    expect(gap?.line).toContain(`bun install\` in ${dir}`);
  });

  test("no install at all names the root, not three directories", () => {
    const gap = nodeModulesGap(checkout(["server", "web"], []));
    expect(gap?.missing).toEqual(["", "server", "web"]);
    expect(gap?.line).toContain("environment: node_modules missing (node_modules, server/node_modules, web/node_modules)");
  });

  test("a complete install says nothing", () => {
    expect(nodeModulesGap(checkout(["server", "web"], ["", "server", "web"]))).toBeNull();
  });

  test("a workspace with no dependency of its own is healthy without an install there: bun puts nothing there", () => {
    // Measured with a real `bun install`: a (no dependency) and b (depends on a)
    // get node_modules at the root and under b, never under a. Asking for a's
    // would report a healthy tree as missing and refuse `make check` on it.
    expect(nodeModulesGap(checkout(["a", "b"], ["", "b"], (w) => w === "b"))).toBeNull();
  });

  test("a link to a directory counts as an install; a link to nothing does not", () => {
    const dir = checkout([], []);
    const target = join(dir, "elsewhere");
    mkdirSync(target);
    symlinkSync(target, join(dir, "node_modules"));
    expect(nodeModulesGap(dir)).toBeNull();
    rmSync(join(dir, "node_modules"));
    symlinkSync(join(dir, "gone"), join(dir, "node_modules"));
    expect(nodeModulesGap(dir)?.missing).toEqual([""]);
  });

  test("a scratch directory, and a workspace this commit does not carry, are not gateways", () => {
    const scratch = mkdtempSync(join(tmpdir(), "agx-deps-test-"));
    trash.push(scratch);
    expect(nodeModulesGap(scratch)).toBeNull();
    // `mobile` is named by the package.json and absent on disk: nothing to
    // install there is nothing this checkout is missing.
    const named = checkout([], [""]);
    writeFileSync(join(named, "package.json"), JSON.stringify({ name: "orbit", workspaces: ["mobile"] }));
    expect(nodeModulesGap(named)).toBeNull();
  });

  test("the worker's first prompt line carries the sentence once, ahead of what it was asked", () => {
    const gap = nodeModulesGap(checkout(["web"], [""]));
    const once = withDepsLine("run the tests", gap);
    expect(once).toStartWith("environment: node_modules missing (web/node_modules)");
    expect(once).toEndWith("\n\nrun the tests");
    // The second turn re-reads the first turn's prompt file, which already has it.
    expect(withDepsLine(once, gap)).toBe(once);
    // Nothing to hand over, nothing to prepend to, and no gap: the prompt is untouched.
    expect(withDepsLine("   ", gap)).toBe("   ");
    expect(withDepsLine("run the tests", null)).toBe("run the tests");
  });
});

describe("the command the make targets run first", () => {
  test("`deps` is phony: a file or directory with that name must not make the gate vanish", async () => {
    // Without it, make reads such an entry as the target's output and answers
    // "up to date", so `typecheck`, `check` and `ci` lose the gate silently.
    const makefile = await Bun.file(new URL("../../Makefile", import.meta.url)).text();
    const line = makefile.split("\n").find((l) => l.startsWith(".PHONY:")) ?? "";
    expect(line.split(/\s+/)).toContain("deps");
  });

  test("a missing install is exit 2 with the sentence, never a silent pass", () => {
    const r = depscheck(checkout(["web"], [""]));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("environment: node_modules missing (web/node_modules)");
  });

  test("a complete install is exit 0 and says nothing", () => {
    const r = depscheck(checkout(["web"], ["", "web"]));
    expect(r.status).toBe(0);
    expect(`${r.stdout}${r.stderr}`.trim()).toBe("");
  });

  test("run with no argument from a checkout under a path with a space, it still answers 2", () => {
    // `new URL(..).pathname` percent-encodes: the script's own repo read
    // "<dir>%20…/package.json", which it took for "not a checkout" and answered
    // 0, so the gate vanished on any such path.
    const holder = mkdtempSync(join(tmpdir(), "agx-deps-space-"));
    trash.push(holder);
    const dir = join(holder, "sp ace");
    mkdirSync(join(dir, "scripts"), { recursive: true });
    mkdirSync(join(dir, "server", "src"), { recursive: true });
    mkdirSync(join(dir, "web"), { recursive: true });
    copyFileSync(DEPSCHECK, join(dir, "scripts", "depscheck.ts"));
    copyFileSync(join(REPO, "server", "src", "checkoutDeps.ts"), join(dir, "server", "src", "checkoutDeps.ts"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "orbit", private: true, workspaces: ["web"] }));
    writeFileSync(join(dir, "web", "package.json"), JSON.stringify({ name: "orbit-web", dependencies: { "orbit-shared": "1.0.0" } }));
    const r = spawnSync("bun", [join(dir, "scripts", "depscheck.ts")], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(`environment: node_modules missing (node_modules, web/node_modules) — run \`bun install\` in ${dir}`);
  });
});
