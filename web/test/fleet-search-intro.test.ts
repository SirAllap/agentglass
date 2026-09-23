/*
 * What the fleet search says it searches, before anything is typed.
 *
 * The empty state read "Search every event ever captured — 12k+ prompts,
 * commands and outputs." Three claims, three wrong:
 *
 *   "12k+"          a literal in the source, not a count of anything;
 *   "ever captured" the full-text rows are pruned with the events at
 *                   AGENTGLASS_RETENTION_DAYS (8 by default), so a search for
 *                   something from last month finds nothing and says so as if
 *                   it had never happened;
 *   "outputs"       a tool's output is not in the index — ftsText() in
 *                   server/src/db.ts takes the command, the path, the prompt,
 *                   the message, the agent's closing reply and the error.
 *
 * So the line is computed from the retention the server reports, and names
 * only what the index holds.
 */
import { describe, expect, test } from "bun:test";
import { fleetSearchIntro, readRetentionDays, __forgetRetentionDays } from "../src/components/SearchModal.tsx";

const src = await Bun.file(new URL("../src/components/SearchModal.tsx", import.meta.url)).text();

describe("fleetSearchIntro", () => {
  test("a pruning server: the window is said, not 'ever'", () => {
    const s = fleetSearchIntro(8);
    expect(s).toContain("last 8 days");
    expect(s).not.toMatch(/ever/i);
  });

  test("one day is singular", () => {
    expect(fleetSearchIntro(1)).toContain("last day");
  });

  test("retention off: nothing is pruned, so everything is true", () => {
    expect(fleetSearchIntro(0)).toMatch(/every/i);
  });

  test("stats not loaded yet: no window is claimed either way", () => {
    const s = fleetSearchIntro(undefined);
    expect(s).not.toMatch(/every|last \d/i);
  });

  test("never a count, and never tool outputs", () => {
    for (const d of [undefined, 0, 1, 8]) {
      const s = fleetSearchIntro(d);
      expect(s).not.toMatch(/\d+k\+/);
      expect(s).not.toMatch(/outputs/i);
    }
  });
});

describe("the screen uses it", () => {
  test("no invented count or 'outputs' left in the fleet copy", () => {
    const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    expect(code).not.toMatch(/\d+k\+/);
    expect(code).not.toContain("ever captured");
    expect(code).not.toMatch(/prompts, commands, outputs/);
    expect(code).toContain("fleetSearchIntro(days)");
  });
});

/*
 * The window came only from the Dashboard's /stats poll, which runs while the
 * Dashboard is showing. Opened from any other view, the search named no
 * window until the Dashboard had been visited once. The server's retention is
 * a constant, so the search reads it once for itself when it was not handed
 * one.
 */
describe("the window does not wait for the Dashboard", () => {
  test("read once from the server when the search was not handed one", async () => {
    __forgetRetentionDays();
    let asked = 0;
    const read = async () => { asked++; return { retentionDays: 8 }; };
    expect(await readRetentionDays(read)).toBe(8);
    expect(await readRetentionDays(read)).toBe(8);
    expect(asked, "a constant is read once").toBe(1);
  });

  test("a failed read claims no window, and the next open asks again", async () => {
    __forgetRetentionDays();
    expect(await readRetentionDays(async () => { throw new Error("offline"); })).toBeUndefined();
    expect(await readRetentionDays(async () => ({ retentionDays: 3 }))).toBe(3);
  });

  test("the screen asks for it whenever it was opened without one", () => {
    const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    expect(code).toMatch(/retentionDays === undefined\) void readRetentionDays\(\)/);
    expect(code).toContain("const days = retentionDays ?? readDays;");
  });
});
