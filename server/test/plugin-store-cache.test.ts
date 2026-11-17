// `contributesOf` used to call `read()` fresh — the whole store parsed back
// into objects — on every call. A live canvas calls it on every single
// operation (`/plugin/self/panel/<id>/ops`), which measured as the dominant
// disk cost behind that route. It is now kept by the file's mtime: a call
// with the same mtime as last time is served from the cache instead of
// reading and re-parsing the file.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetPlugins, contributesOf, installPlugin, MANIFEST_NAME, pluginsPath } from "../src/plugins.ts";

const saved = { xdg: process.env.XDG_CONFIG_HOME, node: process.env.NODE_ENV };
const restore = (k: string, v: string | undefined): void => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
afterAll(() => { restore("XDG_CONFIG_HOME", saved.xdg); restore("NODE_ENV", saved.node); });

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "agx-plugin-cache-src-"));
  writeFileSync(join(dir, MANIFEST_NAME), JSON.stringify({
    name: "orbit-canvas", publisher: "acme", description: "draws", entrypoint: "sleep 5", scope: "read",
    contributes: { panels: [{ id: "flow", title: "Flow", canvas: true }] },
  }));
  writeFileSync(join(dir, "run.sh"), "#!/bin/bash\nsleep 5\n");
  return dir;
}

beforeEach(async () => {
  process.env.NODE_ENV = "test";
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "agx-plugin-cache-"));
  await __resetPlugins();
  expect((await installPlugin(fixture())).ok).toBe(true);
});
afterEach(async () => { await __resetPlugins(); rmSync(process.env.XDG_CONFIG_HOME!, { recursive: true, force: true }); });

describe("a plugin's contributes is read once per mtime", () => {
  test("a rewrite that keeps the old mtime is not seen until the mtime moves", () => {
    const p = pluginsPath();
    // A whole-second mtime: restoring through a Date drops what a filesystem keeps below the millisecond, and the cache compares mtimeMs exactly.
    const pinned = new Date(1_700_000_000_000);
    utimesSync(p, pinned, pinned);
    expect(contributesOf("orbit-canvas").panels?.[0]?.id).toBe("flow"); // populates the cache for this mtime

    const before = statSync(p);
    const store = JSON.parse(readFileSync(p, "utf8"));
    store.plugins[0].contributes.panels[0].id = "renamed";
    // A write made outside this process's own `write()` (a hand edit, another
    // copy of the app) that happens to land on the same mtime — the one case
    // the cache cannot tell apart from "nothing changed" by design.
    writeFileSync(p, JSON.stringify(store));
    utimesSync(p, before.atime, before.mtime);

    expect(contributesOf("orbit-canvas").panels?.[0]?.id).toBe("flow"); // cached, stale on purpose

    // A write that DOES move the mtime is always picked up.
    utimesSync(p, new Date(before.mtime.getTime() + 1000), new Date(before.mtime.getTime() + 1000));
    expect(contributesOf("orbit-canvas").panels?.[0]?.id).toBe("renamed");
  });
});
