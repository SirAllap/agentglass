// R1: a plugin declaring `sandbox` used to run unboxed the moment a host
// could not build the box — full OS-user privileges, behind a warning
// nobody had to read. Refuse to start it instead, unless a human granted
// this specific plugin consent (`allowUnboxed`, stored, revocable) or the
// machine-wide escape hatch is set. `AGENTGLASS_BWRAP` points at a path that
// makes `sandboxProbe()` fail deterministically, without needing a host that
// actually lacks bwrap.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installPlugin, enablePlugin, disablePlugin, listPlugins, __resetPlugins,
  setPluginUnboxedConsent, envAllowsUnboxed, setMaster, pluginsPath, MANIFEST_NAME,
} from "../src/plugins.ts";
import { __resetSandboxProbe } from "../src/plugin-sandbox.ts";

const manifest = {
  name: "watcher", publisher: "someone in the community",
  description: "watches the gate", entrypoint: "sleep 5", scope: "read",
};

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "agx-plugin-unboxed-"));
  writeFileSync(join(dir, MANIFEST_NAME), JSON.stringify(manifest));
  writeFileSync(join(dir, "run.sh"), "#!/bin/bash\nsleep 5\n");
  chmodSync(join(dir, "run.sh"), 0o755);
  return dir;
}

const savedBwrap = process.env.AGENTGLASS_BWRAP;
const savedUnboxed = process.env.AGENTGLASS_PLUGINS_UNBOXED;
const savedNodeEnv = process.env.NODE_ENV;
const savedXdgConfig = process.env.XDG_CONFIG_HOME;
afterAll(() => {
  if (savedBwrap === undefined) delete process.env.AGENTGLASS_BWRAP; else process.env.AGENTGLASS_BWRAP = savedBwrap;
  if (savedUnboxed === undefined) delete process.env.AGENTGLASS_PLUGINS_UNBOXED; else process.env.AGENTGLASS_PLUGINS_UNBOXED = savedUnboxed;
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedNodeEnv;
  if (savedXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedXdgConfig;
  __resetSandboxProbe();
});

beforeEach(async () => {
  process.env.NODE_ENV = "test";
  process.env.AGENTGLASS_BWRAP = "/nonexistent/bwrap"; // sandboxProbe() fails deterministically
  delete process.env.AGENTGLASS_PLUGINS_UNBOXED;
  __resetSandboxProbe();
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "agx-plugins-unboxed-"));
  await __resetPlugins();
});

afterEach(async () => {
  await __resetPlugins();
});

describe("a plugin whose box this host cannot build", () => {
  test("does not start with no consent at all", async () => {
    await installPlugin(fixture());
    const r = await enablePlugin("watcher");
    expect(r.ok).toBe(true); // enabling always succeeds; STARTING it is the separate question
    const rec = listPlugins()[0]!;
    expect(rec.running).toBe(false);
    expect(rec.lastBoxFailure).toContain("refused to run unboxed");
    expect(rec.boxPlan).toBe("refuse"); // what the approval screen reads, not the probe alone
  });

  test("starts when the machine-wide escape hatch is set", async () => {
    process.env.AGENTGLASS_PLUGINS_UNBOXED = "1";
    await installPlugin(fixture());
    await enablePlugin("watcher");
    expect(listPlugins()[0]!.running).toBe(true);
    expect(listPlugins()[0]!.boxPlan).toBe("unboxed-consented");
  });

  // On macOS/Windows, bwrap does not exist at all, so sandboxProbe() fails
  // for every single plugin unconditionally — refusing by default there
  // would stop every plugin at the first boot after this ships, defending
  // nothing (there was never a box on those platforms to widen past).
  test("still starts unboxed with no consent at all, on a platform with no bwrap to begin with", async () => {
    const orig = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    try {
      await installPlugin(fixture());
      await enablePlugin("watcher");
      expect(listPlugins()[0]!.running).toBe(true);
      expect(listPlugins()[0]!.sandboxProbe).toMatchObject({ ok: false }); // no box can be built here (a real macOS host reports "missing")
      expect(listPlugins()[0]!.boxPlan).toBe("unboxed-platform"); // and the screen must not read that as a refusal
    } finally {
      Object.defineProperty(process, "platform", { value: orig, configurable: true });
    }
  });

  test("starts when this specific plugin was granted consent", async () => {
    await installPlugin(fixture());
    await enablePlugin("watcher");
    expect(listPlugins()[0]!.running).toBe(false); // no consent yet

    const g = await setPluginUnboxedConsent("watcher", true);
    expect(g.ok).toBe(true);
    expect(listPlugins()[0]!.running).toBe(true); // the grant itself retries the start

    await disablePlugin("watcher");
  });

  test("revoking consent stops a plugin that was running only because of it", async () => {
    await installPlugin(fixture());
    await setPluginUnboxedConsent("watcher", true);
    await enablePlugin("watcher");
    expect(listPlugins()[0]!.running).toBe(true);

    const rvk = await setPluginUnboxedConsent("watcher", false);
    expect(rvk.ok).toBe(true);
    expect(listPlugins()[0]!.running).toBe(false);
  });

  test("granting consent for an unknown plugin is refused", async () => {
    const r = await setPluginUnboxedConsent("no-such-plugin", true);
    expect(r.ok).toBe(false);
  });

  // M2: consent is a permission to run WITHOUT a box, not a fourth way past
  // the gates that already decide whether a plugin may run AT ALL.
  test("does not start a plugin the master switch has turned off", async () => {
    await installPlugin(fixture());
    await enablePlugin("watcher");
    await setMaster(false);
    const g = await setPluginUnboxedConsent("watcher", true);
    expect(g.ok).toBe(true);
    expect(listPlugins()[0]!.running).toBe(false);
    await setMaster(true);
  });

  test("does not start a plugin nobody has approved (a legacy record, migrated with approvedFingerprint: null)", async () => {
    await installPlugin(fixture());
    await enablePlugin("watcher");
    const file = pluginsPath();
    const store = JSON.parse(readFileSync(file, "utf8"));
    for (const rec of store.plugins) rec.approvedFingerprint = null;
    writeFileSync(file, JSON.stringify(store));
    const g = await setPluginUnboxedConsent("watcher", true);
    expect(g.ok).toBe(true);
    expect(listPlugins()[0]!.running).toBe(false);
  });
});

// L1: a missing, null or falsy-but-not-`false` `allow` used to be read as
// GRANT (`b.allow !== false`) — the wrong failure direction for a switch
// that widens what a process may reach. The route must require the literal
// boolean.
describe("index.ts requires an explicit boolean for /plugins/allow-unboxed", () => {
  test("the route refuses a non-boolean allow rather than defaulting to grant", async () => {
    const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    const marker = 'if (pathname === "/plugins/allow-unboxed" && req.method === "POST") {';
    const start = src.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    let depth = 0;
    let end = -1;
    for (let i = start; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end);
    expect(block).toContain('typeof b.allow !== "boolean"');
    expect(block).not.toContain("b.allow !== false");
  });
});

// What the Settings card reads: the consent as stored, and the machine-wide
// hatch as the start path reads it. A card that showed a stale consent would
// offer "Allow" to a plugin that is already allowed, or "Revoke" to one that
// is not.
describe("what the Plugins settings read back", () => {
  test("the consent shows on the plugin after a grant and clears after a revoke, with the plan following it", async () => {
    await installPlugin(fixture());
    await enablePlugin("watcher");
    expect(listPlugins()[0]!.allowUnboxed).toBeUndefined();
    expect(listPlugins()[0]!.boxPlan).toBe("refuse");

    await setPluginUnboxedConsent("watcher", true);
    expect(listPlugins()[0]!.allowUnboxed).toBe(true);
    expect(listPlugins()[0]!.boxPlan).toBe("unboxed-consented");

    await setPluginUnboxedConsent("watcher", false);
    expect(listPlugins()[0]!.allowUnboxed).toBe(false);
    expect(listPlugins()[0]!.boxPlan).toBe("refuse");
    expect(listPlugins()[0]!.running).toBe(false);
  });

  test("the machine-wide hatch is read from the environment each time, and only \"1\" opens it", () => {
    expect(envAllowsUnboxed()).toBe(false);
    process.env.AGENTGLASS_PLUGINS_UNBOXED = "1";
    expect(envAllowsUnboxed()).toBe(true);
    process.env.AGENTGLASS_PLUGINS_UNBOXED = "true";
    expect(envAllowsUnboxed()).toBe(false);
  });
});

describe("index.ts answers for the consent route and its status", () => {
  async function routeBlock(marker: string): Promise<string> {
    const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    const start = src.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    let depth = 0;
    for (let i = start; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(start, i); }
    }
    throw new Error("route block never closes");
  }

  test("a throw while starting or stopping reaches the caller through failed(), never as the exception", async () => {
    const block = await routeBlock('if (pathname === "/plugins/allow-unboxed" && req.method === "POST") {');
    expect(block).toContain('failed("plugins/allow-unboxed"');
    expect(block).not.toMatch(/e\.message|String\(e\)|\$\{e\}/);
  });

  test("GET /plugins says whether the machine-wide hatch is open", async () => {
    const block = await routeBlock('if (pathname === "/plugins" && req.method === "GET") {');
    expect(block).toContain("envAllowsUnboxed: envAllowsUnboxed()");
  });
});
