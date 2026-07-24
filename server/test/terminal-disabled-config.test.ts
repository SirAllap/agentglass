// The terminal can be turned off from config.json, not only the environment
// (#190). A desktop launcher inherits no shell env, so AGENTGLASS_TERMINAL_
// DISABLED alone was unreachable for the people most likely to want the shell
// off — a packaged install or a shell-less deployment. The env var still wins
// when set, so an existing setup does not break.
//
// config.ts reads the file once at import, so each case imports a fresh copy
// with a cache-busting query, mirroring config-root.test.ts.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENV0 = process.env.AGENTGLASS_TERMINAL_DISABLED;
const XDG0 = process.env.XDG_CONFIG_HOME;
afterEach(() => {
  if (ENV0 === undefined) delete process.env.AGENTGLASS_TERMINAL_DISABLED;
  else process.env.AGENTGLASS_TERMINAL_DISABLED = ENV0;
  if (XDG0 === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = XDG0;
});

function loadWith(json: string) {
  const dir = mkdtempSync(join(tmpdir(), "agx-term-"));
  mkdirSync(join(dir, "agentglass"), { recursive: true });
  writeFileSync(join(dir, "agentglass", "config.json"), json);
  process.env.XDG_CONFIG_HOME = dir;
  return import(`../src/config.ts?u=${Math.random()}`);
}

describe("terminalDisabledSource", () => {
  it("is null (terminal on) with neither env nor config set", async () => {
    delete process.env.AGENTGLASS_TERMINAL_DISABLED;
    const cfg = await loadWith("{}");
    expect(cfg.terminalDisabledSource()).toBeNull();
  });

  it("reads terminalDisabled: true from config.json", async () => {
    delete process.env.AGENTGLASS_TERMINAL_DISABLED;
    const cfg = await loadWith('{"terminalDisabled": true}');
    expect(cfg.terminalDisabledSource()).toBe("config");
  });

  it("the env var overrides the file when it turns it off", async () => {
    process.env.AGENTGLASS_TERMINAL_DISABLED = "1";
    const cfg = await loadWith("{}");
    expect(cfg.terminalDisabledSource()).toBe("env");
  });

  it("the env var overrides the file when it turns it back on", async () => {
    // config says off, but a one-off `AGENTGLASS_TERMINAL_DISABLED=0` forces it on.
    process.env.AGENTGLASS_TERMINAL_DISABLED = "0";
    const cfg = await loadWith('{"terminalDisabled": true}');
    expect(cfg.terminalDisabledSource()).toBeNull();
  });
});
