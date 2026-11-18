/*
 * The new doors stay inside the caller's project and inside a rate: a confined caller reads only its own repos,
 * the detail cache has a ceiling, a worker leaves a deviation note only for its own project, and notes are capped.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prDoorRepos, prDoorLimit, PR_DOOR_PER_MINUTE } from "../src/prDoor.ts";
import { capDetailCache, __detailSize, __seedDetail } from "../src/prs.ts";
import { deviationLimit, deviationScopeRefusal, DEVIATION_PER_MINUTE } from "../src/flow.ts";

const repoWith = (remote: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "doors-")));
  spawnSync("git", ["init", "-q", dir]);
  spawnSync("git", ["-C", dir, "remote", "add", "origin", remote]);
  return dir;
};

describe("pr door scope", () => {
  test("a confined caller reads its own repo only; with no own project it reads none", async () => {
    const own = repoWith("https://github.com/acme/orbit.git");
    expect([...(await prDoorRepos(true, own))]).toEqual(["acme/orbit"]);
    expect((await prDoorRepos(true, undefined)).size).toBe(0);
  });
  test("a caller is limited per minute", () => {
    const k = `t-${Math.random()}`;
    for (let i = 0; i < PR_DOOR_PER_MINUTE; i++) expect(prDoorLimit.hit(k)).toBe(true);
    expect(prDoorLimit.hit(k)).toBe(false);
  });
  test("the detail cache has a ceiling", () => {
    for (let i = 0; i < 8; i++) __seedDetail(`zz/cap#${i}`, { number: i } as any);
    capDetailCache(3);
    expect(__detailSize()).toBeLessThanOrEqual(3);
  });
});

describe("flow deviation scope", () => {
  test("a worker or seat is refused another project's root, and one with no known root too", () => {
    expect(deviationScopeRefusal(true, "/p/a", "/p/b")).toContain("own project");
    expect(deviationScopeRefusal(true, undefined, "/p/b")).toContain("own project");
    expect(deviationScopeRefusal(true, "/p/a", "/p/a")).toBeNull();
    expect(deviationScopeRefusal(false, undefined, "/p/b")).toBeNull();
  });
  test("notes are limited per caller per minute", () => {
    const k = `t-${Math.random()}`;
    for (let i = 0; i < DEVIATION_PER_MINUTE; i++) expect(deviationLimit.hit(k)).toBe(true);
    expect(deviationLimit.hit(k)).toBe(false);
  });
});
