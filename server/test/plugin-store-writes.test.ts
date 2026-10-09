// Every write of plugins.json used to ignore its result. `read()` takes the
// store fresh from disk each time, so a save that failed left the running
// state (a process started, a process stopped) out of step with the file the
// next start reads: a plugin running under an approval that was never saved,
// or gone from a switch that comes back on. Blocking the temp name
// (`<file>.<pid>.tmp`, a directory in its place) makes `writeAtomic` fail the
// way a full or read-only disk does.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MANIFEST_NAME, __resetPlugins, disablePlugin, enablePlugin, installPlugin, listPlugins,
  masterEnabled, pluginInstallDir, pluginsPath, removePlugin, setMaster, setPluginUnboxedConsent,
} from "../src/plugins.ts";
import { __resetSandboxProbe } from "../src/plugin-sandbox.ts";

const manifest = {
  name: "orbit-watcher", publisher: "acme", description: "watches the gate", entrypoint: "sleep 5", scope: "read",
};

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "agx-plugin-writes-src-"));
  writeFileSync(join(dir, MANIFEST_NAME), JSON.stringify(manifest));
  writeFileSync(join(dir, "run.sh"), "#!/bin/bash\nsleep 5\n");
  chmodSync(join(dir, "run.sh"), 0o755);
  return dir;
}

async function blocked<T>(fn: () => Promise<T>): Promise<T> {
  // Named after `writeAtomic`'s temp file; the guards below go red if it is renamed.
  const tmp = `${pluginsPath()}.${process.pid}.tmp`;
  mkdirSync(tmp);
  try { return await fn(); } finally { rmSync(tmp, { recursive: true, force: true }); }
}

const onDisk = (): { master: boolean; plugins: { enabled: boolean; approvedFingerprint: string | null; allowUnboxed?: boolean }[] } =>
  JSON.parse(readFileSync(pluginsPath(), "utf8"));
const running = (): boolean => listPlugins().find((p) => p.name === "orbit-watcher")!.running;

const saved = { bwrap: process.env.AGENTGLASS_BWRAP, unboxed: process.env.AGENTGLASS_PLUGINS_UNBOXED, xdg: process.env.XDG_CONFIG_HOME, node: process.env.NODE_ENV };
const restore = (k: string, v: string | undefined): void => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
afterAll(() => {
  restore("AGENTGLASS_BWRAP", saved.bwrap); restore("AGENTGLASS_PLUGINS_UNBOXED", saved.unboxed);
  restore("XDG_CONFIG_HOME", saved.xdg); restore("NODE_ENV", saved.node);
  __resetSandboxProbe();
});

beforeEach(async () => {
  process.env.NODE_ENV = "test";
  process.env.AGENTGLASS_BWRAP = "/nonexistent/bwrap";
  process.env.AGENTGLASS_PLUGINS_UNBOXED = "1"; // so a started plugin is `running` without a box
  __resetSandboxProbe();
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "agx-plugin-writes-"));
  await __resetPlugins();
  expect((await installPlugin(fixture())).ok).toBe(true);
});
afterEach(async () => { await __resetPlugins(); });

describe("a switch-on that cannot be saved starts nothing", () => {
  test("enable: not running, not approved on disk, and a retry works", async () => {
    const r = await blocked(() => enablePlugin("orbit-watcher"));
    expect(r.ok, "ok, with the approval only in memory").toBe(false);
    if (!r.ok) expect(r.error).not.toContain(tmpdir());
    expect(running(), "a process started under an approval that was never saved").toBe(false);
    expect(onDisk().plugins[0]!.approvedFingerprint).toBeNull();
    expect((await enablePlugin("orbit-watcher")).ok).toBe(true);
    expect(running()).toBe(true);
  });

  test("master on: refused, and the file still says off", async () => {
    await setMaster(false);
    await expect(blocked(() => setMaster(true))).rejects.toThrow("could not save");
    expect(masterEnabled()).toBe(false);
    await setMaster(true);
    expect(masterEnabled()).toBe(true);
  });

  test("consent granted: refused, nothing started, nothing granted on disk", async () => {
    await enablePlugin("orbit-watcher");
    delete process.env.AGENTGLASS_PLUGINS_UNBOXED;
    await disablePlugin("orbit-watcher");
    await enablePlugin("orbit-watcher");
    expect(running()).toBe(false);
    const r = await blocked(() => setPluginUnboxedConsent("orbit-watcher", true));
    expect(r.ok, "consent answered ok with only memory holding it").toBe(false);
    expect(running()).toBe(false);
    expect(onDisk().plugins[0]!.allowUnboxed).toBeFalsy();
  });
});

describe("a switch-off that cannot be saved still stops, and says it was not saved", () => {
  test("disable", async () => {
    await enablePlugin("orbit-watcher");
    expect(running()).toBe(true);
    await expect(blocked(() => disablePlugin("orbit-watcher"))).rejects.toThrow("could not save");
    expect(running(), "left running under a switch the person turned off").toBe(false);
    expect(onDisk().plugins[0]!.enabled, "the file is the part that is still on").toBe(true);
  });

  test("master off", async () => {
    await enablePlugin("orbit-watcher");
    await expect(blocked(() => setMaster(false))).rejects.toThrow("could not save");
    expect(running()).toBe(false);
    expect(onDisk().master).toBe(true);
  });

  test("consent revoked", async () => {
    delete process.env.AGENTGLASS_PLUGINS_UNBOXED;
    await setPluginUnboxedConsent("orbit-watcher", true);
    await enablePlugin("orbit-watcher");
    expect(running()).toBe(true);
    const r = await blocked(() => setPluginUnboxedConsent("orbit-watcher", false));
    expect(r.ok).toBe(false);
    expect(running()).toBe(false);
  });
});

describe("a remove that cannot be saved leaves the plugin whole for a retry", () => {
  test("record and folder both stay, the throw says so, the retry removes both", async () => {
    const dir = pluginInstallDir("orbit-watcher");
    await expect(blocked(() => removePlugin("orbit-watcher"))).rejects.toThrow("could not save");
    expect(listPlugins().map((p) => p.name), "the record went with nothing saved").toEqual(["orbit-watcher"]);
    expect(existsSync(dir), "the folder went while the record stayed").toBe(true);
    expect(await removePlugin("orbit-watcher")).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });
});

describe("the routes say it in one fixed sentence", () => {
  test("none of the three hands the exception's text to the caller", async () => {
    const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    for (const where of ["plugins/master", "plugins/disable", "plugins/remove"]) {
      const at = src.indexOf(`failed("${where}"`);
      expect(at, `${where} answers through failed()`).toBeGreaterThan(0);
      expect(src.slice(at, src.indexOf("\n", at)), "the sentence is not the exception's").not.toMatch(/e\.message|String\(e\)/);
    }
  });
});
