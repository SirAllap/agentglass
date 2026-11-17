/*
 * TEST STEPS READ FROM A COMMIT BODY.
 *
 * `Test: run|look|do <text>` lines become steps; backticks mark the copyable
 * command. A merge row takes the steps of the commit it merged.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readTrunk, stepsOf } from "../src/manifest.ts";

test("stepsOf reads run, look and do lines and the backticked command", () => {
  const body = "Adds a thing.\n\nTest: run `make thing test`\nTest: look the badge turns green\nnot a step\nTest: do   press Save\nTest: jump nowhere";
  expect(stepsOf(body)).toEqual([
    { kind: "run", text: "make thing test", command: "make thing test" },
    { kind: "look", text: "the badge turns green", command: null },
    { kind: "do", text: "press Save", command: null },
  ]);
  expect(stepsOf(undefined)).toEqual([]);
});

test("stepsOf caps the steps per commit and clips each text", () => {
  const body = Array.from({ length: 10_000 }, (_, i) => `Test: look line ${i} ${"x".repeat(2_000)}`).join("\n");
  const steps = stepsOf(body);
  expect(steps.length).toBe(20);
  expect(steps.every((s) => s.text.length <= 300)).toBe(true);
  expect(steps[0]!.text.startsWith("line 0 ")).toBe(true);
});

test("readTrunk carries the body, and a merge takes its second parent's", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agx-manifest-steps-"));
  try {
    const g = (...a: string[]) => spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });
    g("init", "-q", "-b", "main");
    g("config", "user.email", "t@example.com"); g("config", "user.name", "T");
    writeFileSync(join(dir, "a"), "1"); g("add", "-A"); g("commit", "-qm", "base");
    g("checkout", "-qb", "feat");
    writeFileSync(join(dir, "b"), "2"); g("add", "-A");
    g("commit", "-qm", "ORBIT-1042 add thing", "-m", "Test: run `make orbit test`");
    g("checkout", "-q", "main");
    g("merge", "-q", "--no-ff", "feat", "-m", "Merge branch feat");
    const r = await readTrunk(dir, Date.now());
    const top = r.commits[0]!;
    expect(top.subject).toBe("ORBIT-1042 add thing");
    expect(stepsOf(top.body)).toEqual([{ kind: "run", text: "make orbit test", command: "make orbit test" }]);
    expect(r.commits[1]!.subject).toBe("base");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
