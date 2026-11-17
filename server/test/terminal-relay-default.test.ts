/*
 * The terminal relay is on unless the person turned it off.
 *
 * It was on only for whoever stored true. Measured in isolation (packaged
 * binary, main server SIGSTOPped 4 s), keystrokes through the relay kept
 * echoing at p95 88 ms while the old door echoed none, so everyone gets it.
 * An install that never chose has no key at all and must read as on; a
 * stored false must stay off. When the relay cannot start, terminals still go
 * through the old door: terminal-relay.test.ts ("no ticket is minted while
 * the relay is down") covers that.
 *
 * Under a scratch XDG_CONFIG_HOME: config.ts refuses to touch a real one from a test.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REAL_XDG = process.env.XDG_CONFIG_HOME;
const HOME = join(tmpdir(), `agx-relay-default-${process.pid}`);
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

// config.ts reads once per resolved path, so each case gets a home of its own.
function home(name: string, body?: object): void {
  const dir = join(HOME, name);
  mkdirSync(join(dir, "agentglass"), { recursive: true });
  if (body) writeFileSync(join(dir, "agentglass", "config.json"), JSON.stringify(body));
  process.env.XDG_CONFIG_HOME = dir;
}

test("no config file, and a config without the key: the relay is on", () => {
  home("none");
  expect(cfg.terminalRelaySetting()).toBe(true);
  home("nokey", { lanternNudge: false });
  expect(cfg.terminalRelaySetting()).toBe(true);
});

test("an explicit false wins, and writing it back on turns it on again", () => {
  home("off", { terminalRelay: false });
  expect(cfg.terminalRelaySetting()).toBe(false);
  expect(cfg.writeTerminalRelay(true).ok).toBe(true);
  expect(cfg.terminalRelaySetting()).toBe(true);
  expect(cfg.writeTerminalRelay(false).ok).toBe(true);
  expect(cfg.terminalRelaySetting()).toBe(false);
});
