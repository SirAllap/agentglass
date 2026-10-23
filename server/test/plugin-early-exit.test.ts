// A plugin that starts and dies within seconds used to take its reason with
// it: the card said "Enabled, not running" and nothing else. The host now
// keeps the exit code and the last lines of stderr for the first moments of
// life, for any plugin, boxed or not, and nothing after that.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installPlugin, enablePlugin, disablePlugin, listPlugins, removePlugin, __resetPlugins, __setEarlyExitMs, MANIFEST_NAME,
} from "../src/plugins.ts";
import { __resetSandboxProbe } from "../src/plugin-sandbox.ts";

function fixture(name: string, entrypoint: string): string {
  const dir = mkdtempSync(join(tmpdir(), "agx-plugin-exit-"));
  writeFileSync(join(dir, MANIFEST_NAME), JSON.stringify({
    name, publisher: "acme", description: "stub that exits", entrypoint, scope: "read",
  }));
  return dir;
}

async function start(name: string, entrypoint: string) {
  await installPlugin(fixture(name, entrypoint));
  await enablePlugin(name);
}

/** Polls the public state until the plugin has stopped and said why. */
async function stopped(name: string, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const p = listPlugins().find((x) => x.name === name)!;
    if (!p.running) return p;
    await new Promise((r) => setTimeout(r, 50));
  }
  return listPlugins().find((x) => x.name === name)!;
}

// No box here (a stub bwrap that fails the probe, plus the machine-wide
// consent): the capture is for ANY plugin, and the box has its own tests.
const saved = {
  cfg: process.env.XDG_CONFIG_HOME, data: process.env.XDG_DATA_HOME, node: process.env.NODE_ENV,
  bwrap: process.env.AGENTGLASS_BWRAP, unboxed: process.env.AGENTGLASS_PLUGINS_UNBOXED,
};
afterAll(() => {
  __setEarlyExitMs(10_000);
  for (const [k, v] of [["XDG_CONFIG_HOME", saved.cfg], ["XDG_DATA_HOME", saved.data], ["NODE_ENV", saved.node], ["AGENTGLASS_BWRAP", saved.bwrap], ["AGENTGLASS_PLUGINS_UNBOXED", saved.unboxed]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  __resetSandboxProbe();
});

beforeEach(async () => {
  process.env.NODE_ENV = "test";
  process.env.AGENTGLASS_BWRAP = "/nonexistent/bwrap";
  process.env.AGENTGLASS_PLUGINS_UNBOXED = "1";
  __resetSandboxProbe();
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "agx-plugin-exit-cfg-"));
  process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), "agx-plugin-exit-data-"));
  __setEarlyExitMs(10_000);
  await __resetPlugins();
});
afterEach(async () => { await __resetPlugins(); });

describe("a plugin that dies within the window", () => {
  test("keeps the exit code and what it said on stderr", async () => {
    await start("acme-review", "echo 'ModuleNotFoundError: no module named widget' >&2; exit 3");
    const p = await stopped("acme-review");
    expect(p.running).toBe(false);
    expect(p.lastExit).toBeDefined();
    expect(p.lastExit!.code).toBe(3);
    expect(p.lastExit!.signal).toBeNull();
    expect(p.lastExit!.stderrTail).toContain("ModuleNotFoundError");
    expect(p.lastExit!.afterMs).toBeLessThan(2000);
  });

  test("a signal is reported as a signal, with no code", async () => {
    await start("acme-signal", "kill -TERM $$");
    const p = await stopped("acme-signal");
    expect(p.lastExit).toBeDefined();
    expect(p.lastExit!.signal).toBe("SIGTERM");
    expect(p.lastExit!.code).toBeNull();
  });

  test("a secret it printed is redacted", async () => {
    await start("acme-secret", "echo 'auth failed with ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' >&2; exit 1");
    const p = await stopped("acme-secret");
    expect(p.lastExit!.stderrTail).toContain("auth failed");
    expect(p.lastExit!.stderrTail).not.toContain("ghp_xxxxxxxxxxxx");
    expect(p.lastExit!.stderrTail).toContain("<redacted-secret>");
  });

  test("keeps at most 2 KB, the last lines", async () => {
    await start("acme-loud", "for i in $(seq 1 400); do echo \"line $i of the noisy failure\" >&2; done; exit 1");
    const p = await stopped("acme-loud");
    const tail = p.lastExit!.stderrTail;
    expect(tail.length).toBeLessThanOrEqual(2048);
    expect(tail).toContain("line 400 of the noisy failure");
    expect(tail).not.toContain("line 1 of the noisy failure");
    // whole lines only: the cut never leaves half of one at the top
    expect(tail.split("\n")[0]).toMatch(/^line \d+ of the noisy failure$/);
  });

  test("is cleared by the next start", async () => {
    await start("acme-twice", "echo boom >&2; exit 2");
    expect((await stopped("acme-twice")).lastExit).toBeDefined();
    await disablePlugin("acme-twice");
    expect(listPlugins().find((x) => x.name === "acme-twice")!.lastExit).toBeDefined();
    await installPlugin(fixture("acme-twice", "sleep 5")); // same name: the entrypoint changes
    await enablePlugin("acme-twice");
    const p = listPlugins().find((x) => x.name === "acme-twice")!;
    expect(p.running).toBe(true);
    expect(p.lastExit).toBeUndefined();
  });

  test("is gone when the plugin is removed", async () => {
    await start("acme-gone", "echo boom >&2; exit 2");
    await stopped("acme-gone");
    await removePlugin("acme-gone");
    await start("acme-gone", "sleep 5");
    expect(listPlugins().find((x) => x.name === "acme-gone")!.lastExit).toBeUndefined();
  });
});

describe("a plugin that outlives the window", () => {
  test("keeps nothing, even when it dies afterwards", async () => {
    __setEarlyExitMs(300);
    await start("acme-late", "echo early >&2; sleep 0.8; echo late >&2; exit 4");
    const p = await stopped("acme-late");
    expect(p.running).toBe(false);
    expect(p.lastExit).toBeUndefined();
  });

  test("is not killed for writing to stderr after the window closed", async () => {
    __setEarlyExitMs(200);
    // 1.2 s in, well past the window, it writes: a closed pipe would end it here.
    await start("acme-chatty", "sleep 1.2; echo still here >&2; echo ok > \"$AGENTGLASS_PLUGIN_DATA/alive\"; sleep 30");
    await new Promise((r) => setTimeout(r, 2000));
    const p = listPlugins().find((x) => x.name === "acme-chatty")!;
    expect(p.running).toBe(true);
    expect(p.lastExit).toBeUndefined();
  });
});
