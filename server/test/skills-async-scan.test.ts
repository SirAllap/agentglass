// The catalogue scan read ~8000 directory entries with sync calls, so a cold
// disk froze the whole server for seconds (154 stalls in one log, max 4 s).
// It is async now, at most a few reads in flight, and callers that arrive while
// a scan runs wait for that scan instead of starting their own.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-skillscan-"));
const CODE = join(dir, "code");
process.env.AGENTGLASS_DB = join(dir, "skills.db");
process.env.AGENTGLASS_ROOT = dir;
process.env.XDG_CONFIG_HOME = dir;
process.env.AGENTGLASS_CODE_DIR = CODE;
mkdirSync(join(CODE, "orbit", ".claude", "skills", "alpha"), { recursive: true });
writeFileSync(join(CODE, "orbit", ".claude", "skills", "alpha", "SKILL.md"), "---\nname: alpha\ndescription: first\n---\n");

describe("mapLimit", () => {
  test("never runs more than `limit` at once and keeps input order", async () => {
    const { mapLimit } = await import("../src/skills.ts");
    let live = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3, 0], 2, async (n) => {
      live++;
      peak = Math.max(peak, live);
      await Bun.sleep(n);
      live--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30, 0]);
    expect(peak).toBe(2);
  });
});

describe("getSkills", () => {
  test("callers that overlap share one scan", async () => {
    const { getSkills, resetSkillsCache } = await import("../src/skills.ts");
    resetSkillsCache();
    const [a, b] = await Promise.all([getSkills(), getSkills()]);
    expect(a).toBe(b);
  });

  test("the tree it scans follows AGENTGLASS_CODE_DIR as it is now, not as it was at the first import", async () => {
    // Two test files point this module at different trees, and the one that imports it first used to win for
    // the rest of the process: the order the runner lists files in decided which of them passed.
    const { getSkills, resetSkillsCache } = await import("../src/skills.ts");
    const other = join(dir, "code-two");
    mkdirSync(join(other, "moon", ".claude", "skills", "beta"), { recursive: true });
    writeFileSync(join(other, "moon", ".claude", "skills", "beta", "SKILL.md"), "---\nname: beta\ndescription: second\n---\n");
    resetSkillsCache();
    expect((await getSkills()).some((s) => s.name === "alpha")).toBe(true);
    process.env.AGENTGLASS_CODE_DIR = other;
    try {
      const names = (await getSkills()).map((s) => s.name);
      expect(names).toContain("beta");
      expect(names).not.toContain("alpha");
    } finally {
      process.env.AGENTGLASS_CODE_DIR = CODE;
      resetSkillsCache();
    }
  });

  test("skills.ts has no synchronous filesystem call left", async () => {
    const src = (await Bun.file(join(import.meta.dir, "../src/skills.ts")).text())
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(src).not.toMatch(/\b(readdirSync|readFileSync|statSync|existsSync)\b/);
  });
});
