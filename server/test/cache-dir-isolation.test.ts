// An isolated run sets XDG_CACHE_HOME (or AGENTGLASS_CACHE_DIR) and must never
// read or write under the real home. Every cache reader goes through one helper.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentglassCacheDir } from "../src/cachedir.ts";

describe("agentglassCacheDir", () => {
  test("AGENTGLASS_CACHE_DIR names the directory itself", () => {
    expect(agentglassCacheDir({ AGENTGLASS_CACHE_DIR: "/x/c", XDG_CACHE_HOME: "/y" })).toBe("/x/c");
  });
  test("XDG_CACHE_HOME gets an agentglass folder", () => {
    expect(agentglassCacheDir({ XDG_CACHE_HOME: "/y" })).toBe("/y/agentglass");
  });
  test("with neither set it falls back to ~/.cache/agentglass", () => {
    expect(agentglassCacheDir({})).toMatch(/\/\.cache\/agentglass$/);
  });
});

describe("isolated run", () => {
  test("a child with XDG_CACHE_HOME set touches nothing under its fake home", () => {
    const home = mkdtempSync(join(tmpdir(), "agx-cacheiso-home-"));
    const cache = mkdtempSync(join(tmpdir(), "agx-cacheiso-cache-"));
    const code = `
      const { agentglassCacheDir } = await import(${JSON.stringify(join(import.meta.dir, "../src/cachedir.ts"))});
      const shots = await import(${JSON.stringify(join(import.meta.dir, "../src/shots.ts"))});
      console.log(JSON.stringify({ dir: agentglassCacheDir(), has: typeof shots }));
    `;
    const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: home, XDG_CACHE_HOME: cache };
    const r = Bun.spawnSync([process.execPath, "-e", code], { env });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout.toString().trim()).dir).toBe(join(cache, "agentglass"));
    expect(existsSync(join(home, ".cache"))).toBe(false);
    expect(readdirSync(home)).toEqual([]);
  });

  test("no server module spells ~/.cache for agentglass outside the helper", () => {
    for (const f of ["prs", "tasks", "shots", "selfupdate"]) {
      const src = readFileSync(join(import.meta.dir, "../src", `${f}.ts`), "utf8");
      expect(src, f).not.toMatch(/"\.cache"/);
      expect(src, f).toContain("agentglassCacheDir()");
    }
  });
});
