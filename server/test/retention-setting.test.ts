/*
 * How long history is kept, chosen in Settings.
 *
 * The environment variable wins, then what the person chose, then 8. A change
 * is live at once (the prune sweep reads the binding) and survives a restart
 * because it is in config.json. Under a scratch XDG_CONFIG_HOME, which
 * config.ts insists on from a test.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REAL_XDG = process.env.XDG_CONFIG_HOME;
const REAL_ENV = process.env.AGENTGLASS_RETENTION_DAYS;
const HOME = join(tmpdir(), `agx-retention-${process.pid}`);
process.env.XDG_CONFIG_HOME = HOME;
delete process.env.AGENTGLASS_RETENTION_DAYS;
mkdirSync(join(HOME, "agentglass"), { recursive: true });

const R = await import("../src/retention.ts");
const { classOf } = await import("../../shared/settingClass.ts");

afterAll(() => {
  // RETENTION_DAYS is module state the files after this one read: hand it back at the default.
  R.setRetentionDays(8);
  rmSync(HOME, { recursive: true, force: true });
  if (REAL_XDG === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = REAL_XDG;
  if (REAL_ENV !== undefined) process.env.AGENTGLASS_RETENTION_DAYS = REAL_ENV;
});

describe("retention", () => {
  test("nobody chose: a week and a day", () => {
    expect(R.RETENTION_DAYS).toBe(8);
    expect(R.RETENTION_FROM_ENV).toBe(false);
  });

  test("a choice is live at once and written to config.json", () => {
    expect(R.setRetentionDays(90)).toEqual({ ok: true });
    expect(R.RETENTION_DAYS).toBe(90);
    expect(JSON.parse(readFileSync(join(HOME, "agentglass", "config.json"), "utf8")).retentionDays).toBe(90);
  });

  test("zero keeps everything, and anything that is not a whole number of days is refused unchanged", () => {
    expect(R.setRetentionDays(0).ok).toBe(true);
    expect(R.RETENTION_DAYS).toBe(0);
    for (const bad of [-1, 1.5, 4000, Number.NaN]) expect(R.setRetentionDays(bad).ok).toBe(false);
    expect(R.RETENTION_DAYS).toBe(0);
  });

  test("an agent never shortens it: the class is the person's alone", () => {
    expect(classOf("privacy.retentionDays")?.class).toBe("personOnly");
  });

  test("the environment variable wins, and says so instead of pretending to save", () => {
    const r = Bun.spawnSync({
      cmd: ["bun", "-e", "const r = await import('./src/retention.ts'); console.log(JSON.stringify({ days: r.RETENTION_DAYS, env: r.RETENTION_FROM_ENV, set: r.setRetentionDays(5) }))"],
      cwd: join(import.meta.dir, ".."), env: { ...process.env, XDG_CONFIG_HOME: HOME, AGENTGLASS_RETENTION_DAYS: "3" },
    });
    const out = JSON.parse(r.stdout.toString()) as { days: number; env: boolean; set: { ok: boolean; error?: string } };
    expect(out.days).toBe(3);
    expect(out.env).toBe(true);
    expect(out.set.ok).toBe(false);
    expect(out.set.error).toContain("AGENTGLASS_RETENTION_DAYS");
  });
});
