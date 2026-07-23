// A hand-edited config.json must never stop the server from starting.
//
// `workspaceRoot()` runs at boot, before the server listens, and a non-string
// `root` used to reach expand()/startsWith() and throw an uncaught TypeError —
// the app was simply dead, with a stack trace and no port. These pin that a
// corrupt config degrades to "no scope" instead.
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const XDG0 = process.env.XDG_CONFIG_HOME;
const ROOT0 = process.env.AGENTGLASS_ROOT;
afterAll(() => {
  if (XDG0 === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = XDG0;
  if (ROOT0 === undefined) delete process.env.AGENTGLASS_ROOT; else process.env.AGENTGLASS_ROOT = ROOT0;
});

function loadWith(json: string) {
  const dir = mkdtempSync(join(tmpdir(), "agx-config-"));
  mkdirSync(join(dir, "agentglass"), { recursive: true });
  writeFileSync(join(dir, "agentglass", "config.json"), json);
  process.env.XDG_CONFIG_HOME = dir;
  delete process.env.AGENTGLASS_ROOT; // the env would shadow the file
  return { dir, load: () => import(`../src/config.ts?u=${Math.random()}`) };
}

describe("config load tolerates a corrupt config.json", () => {
  it("a non-string root does not throw at boot and scopes to nothing", async () => {
    const cfg = await loadWith('{"root": 12345}').load();
    expect(() => cfg.workspaceRoot()).not.toThrow();
    expect(cfg.workspaceRoot()).toBeNull();
  });

  it("a root that is an object is dropped, not crashed on", async () => {
    const cfg = await loadWith('{"root": {"nested": true}}').load();
    expect(() => cfg.workspaceRoot()).not.toThrow();
    expect(cfg.workspaceRoot()).toBeNull();
  });

  it("a top level that is not an object at all is ignored", async () => {
    const cfg = await loadWith('"just a string"').load();
    expect(() => cfg.workspaceRoot()).not.toThrow();
    expect(cfg.workspaceRoot()).toBeNull();
  });

  it("a valid string root is still honoured", async () => {
    const { dir, load } = loadWith("{}");
    // Rewrite with a real string root pointing at a real directory.
    writeFileSync(join(dir, "agentglass", "config.json"), JSON.stringify({ root: dir }));
    const cfg = await load();
    expect(cfg.workspaceRoot()).not.toBeNull();
  });

  it("a non-array repoDirs degrades to none instead of throwing (kept /git/repos alive)", async () => {
    delete process.env.AGENTGLASS_REPO_DIRS; // the env would shadow the file
    const cfg = await loadWith('{"repoDirs": "not-an-array"}').load();
    expect(() => cfg.configuredRepoDirs()).not.toThrow();
    expect(cfg.configuredRepoDirs()).toEqual([]);
  });

  it("a repoDirs array with a non-string entry drops only the bad entry", async () => {
    delete process.env.AGENTGLASS_REPO_DIRS;
    const cfg = await loadWith('{"repoDirs": ["/tmp/agx-ok", 123, null]}').load();
    expect(() => cfg.configuredRepoDirs()).not.toThrow();
    expect(cfg.configuredRepoDirs()).toEqual(["/tmp/agx-ok"]);
  });
});
