/*
 * Not a suite — the subject of one. `isolation.test.ts` runs this file in a
 * child `bun test`, because a refusal fails the run it happens in, and that
 * has to be a run other than the one asserting it.
 *
 * Every reach below is at a path that does not exist, under a directory name
 * that no install uses, so a broken guard lets it through and still touches
 * nothing of anybody's: a stat that finds nothing, a read that fails, a
 * database opened without `create`, and `true`.
 */
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const REAL = process.env.AGX_TEST_REAL_HOME!;
const probe = join(REAL, ".config", "agentglass-isolation-probe-absent", "agentglass.db");

const threw = (f: () => unknown): string => {
  try { f(); return ""; } catch (e) { return String((e as Error).message); }
};

test("every reach at a real agentglass path is refused where it happens", () => {
  const home = Bun.spawnSync(["sh", "-c", "printf %s \"$HOME\""], { env: { PATH: process.env.PATH ?? "" } });
  const report = {
    exists: threw(() => existsSync(probe)),
    read: threw(() => readFileSync(probe)),
    db: threw(() => new Database(probe, { readonly: true, create: false })),
    spawn: threw(() => Bun.spawnSync(["true"], { env: { PATH: process.env.PATH ?? "", HOME: REAL } })),
    filledHome: home.stdout.toString(),
    home: process.env.HOME,
    homedir: homedir(),
    // Made here so the parent can see tmpsweep still ran in a run that refused.
    scratch: mkdtempSync(join(tmpdir(), "agx-isolation-sweep-")),
    agentglassVars: Object.keys(process.env).filter((k) => k.startsWith("AGENTGLASS_")).join(","),
  };
  writeFileSync(process.env.ISOLATION_REPORT!, JSON.stringify(report));
  expect(report.exists).not.toBe("");
});
