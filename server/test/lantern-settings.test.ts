/*
 * THE LANTERN REMINDER'S TWO KNOBS, on disk.
 *
 * Whether hooked sessions get asked what they are working on, and how often
 * one session may be asked again. Read the way every other setting in
 * config.json is read — hand-editable, checked on read, never coerced into
 * something plausible — and written through the same merge every settings
 * pane uses, so saving these cannot drop a tmux prefix somebody set.
 *
 * Under a scratch XDG_CONFIG_HOME: config.ts refuses to touch a real one from
 * a test, and this file would otherwise be writing the developer's settings.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REAL_XDG = process.env.XDG_CONFIG_HOME;
const HOME = join(tmpdir(), `agx-lantern-settings-${process.pid}`);
process.env.XDG_CONFIG_HOME = HOME;

let cfg: typeof import("../src/config.ts");
beforeAll(async () => {
  mkdirSync(join(HOME, "agentglass"), { recursive: true });
  cfg = await import("../src/config.ts");
});
afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  if (REAL_XDG === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = REAL_XDG;
});

const file = () => join(HOME, "agentglass", "config.json");

test("on by default, at twenty minutes — the board is a list of pane ids without it", () => {
  process.env.XDG_CONFIG_HOME = HOME;
  rmSync(file(), { force: true });
  expect(cfg.lanternNudge()).toBe(true);
  expect(cfg.lanternNudgeMinutes()).toBe(cfg.LANTERN_NUDGE_DEFAULT_MIN);
});

test("saving keeps every other key in the file", () => {
  process.env.XDG_CONFIG_HOME = HOME;
  writeFileSync(file(), JSON.stringify({ tmuxPrefix: "C-a", budgets: [] }, null, 2));
  const w = cfg.writeLanternSettings({ lanternNudge: false, lanternNudgeMinutes: 45 });
  expect(w).toMatchObject({ ok: true, persisted: true });
  const on = JSON.parse(readFileSync(file(), "utf8"));
  expect(on).toMatchObject({ tmuxPrefix: "C-a", budgets: [], lanternNudge: false, lanternNudgeMinutes: 45 });
  expect(cfg.lanternNudge()).toBe(false);
  expect(cfg.lanternNudgeMinutes()).toBe(45);
});

test("the interval is clamped, never trusted: a minute of nagging is not a setting", () => {
  process.env.XDG_CONFIG_HOME = HOME;
  expect(cfg.writeLanternSettings({ lanternNudgeMinutes: 1 }).ok).toBe(true);
  expect(cfg.lanternNudgeMinutes()).toBe(cfg.LANTERN_NUDGE_MIN_MIN);
  expect(cfg.writeLanternSettings({ lanternNudgeMinutes: 100_000 }).ok).toBe(true);
  expect(cfg.lanternNudgeMinutes()).toBe(cfg.LANTERN_NUDGE_MAX_MIN);
  expect(cfg.writeLanternSettings({ lanternNudgeMinutes: Number.NaN }).ok).toBe(false);
});

test("a hand-edited value that is not a number falls back rather than breaking the read", () => {
  process.env.XDG_CONFIG_HOME = HOME;
  writeFileSync(file(), JSON.stringify({ lanternNudge: "yes", lanternNudgeMinutes: "twenty" }, null, 2));
  cfg.writeLanternSettings({}); // a no-op write, to drop the cached read
  // `"yes"` is not `false`, and that is the only value that turns it off.
  expect(cfg.lanternNudge()).toBe(true);
  expect(cfg.lanternNudgeMinutes()).toBe(cfg.LANTERN_NUDGE_DEFAULT_MIN);
});
