/*
 * compareRefs — the difference between two refs.
 *
 * The fixture is a small history where main and a feature branch diverge:
 * one commit on each side. The contract:
 *   - ahead = commits base has that other lacks;
 *   - behind = commits other has that base lacks;
 *   - diff = the three-dot diff (other...base) — your side's changes.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identify } from "./gitIdentity.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-compare-")));
process.env.AGENTGLASS_ROOT = dir;
const { compareRefs } = await import("../src/gitwork.ts");

let repo = "";
const git = (...args: string[]) =>
  Bun.spawnSync(["git", "-c", "user.email=t@e.st", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...args], { cwd: repo });

function commit(file: string, msg: string): void {
  writeFileSync(join(repo, file), msg + "\n");
  git("add", "-A");
  git("commit", "-qm", msg);
}

function build(): void {
  repo = join(dir, `r-${Math.random().toString(36).slice(2)}`);
  Bun.spawnSync(["mkdir", "-p", repo]);
  git("init", "-q", "-b", "main", ".");
  identify(repo);
  commit("base.txt", "base");
  git("checkout", "-qb", "feature");
  commit("feature.txt", "feature work");
  git("checkout", "-q", "main");
  commit("main.txt", "main work");
}

describe("compareRefs", () => {
  beforeEach(build);

  // Six git calls in a row used to block the server's only thread for their sum.
  it("leaves the loop free while git runs", async () => {
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 1);
    const r = await compareRefs(repo, "main", "feature");
    clearInterval(timer);
    expect(r.ok).toBe(true);
    expect(ticks).toBeGreaterThan(0);
  });

  it("counts ahead/behind between two diverged branches", async () => {
    const r = await compareRefs(repo, "main", "feature");
    expect(r.ok).toBe(true);
    // main is one commit ahead (main work), one behind (feature work).
    expect(r.ahead!.map((c) => c.subject)).toEqual(["main work"]);
    expect(r.behind!.map((c) => c.subject)).toEqual(["feature work"]);
  });

  it("flips with the refs", async () => {
    const r = await compareRefs(repo, "feature", "main");
    expect(r.ahead!.map((c) => c.subject)).toEqual(["feature work"]);
    expect(r.behind!.map((c) => c.subject)).toEqual(["main work"]);
  });

  it("diff is the three-dot diff: only your side's changes", async () => {
    const r = await compareRefs(repo, "main", "feature");
    expect(r.ok).toBe(true);
    // other...base = feature...main = changes on main since they diverged.
    expect(r.diff!.map((f) => f.file_path)).toEqual([join(repo, "main.txt")]);
  });

  it("identical refs are empty everywhere", async () => {
    const r = await compareRefs(repo, "main", "main");
    expect(r.ok).toBe(true);
    expect(r.ahead).toEqual([]);
    expect(r.behind).toEqual([]);
    expect(r.diff).toEqual([]);
  });

  it("refuses garbage refs", async () => {
    const r = await compareRefs(repo, "main", "no-such-ref-zzz");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("no-such-ref-zzz is not a commit");
  });
});
