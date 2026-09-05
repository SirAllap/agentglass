/*
 * The mechanism docs/PLUGINS.md describes: install copies a folder,
 * a bad manifest loses the plugin rather than widening it, nothing runs
 * until a human enables the specific plugin, enabling mints a scoped token
 * and starts the entrypoint as its own process, and disabling actually
 * stops it — a plugin left running after it was disabled is the feature
 * failing.
 */
import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateManifest, validPluginName, manifestHash, installPlugin, updatePlugin, enablePlugin, disablePlugin,
  removePlugin, listPlugins, masterEnabled, setMaster, __resetPlugins,
  MANIFEST_NAME, pluginsConfigDir, pluginsPath,
  listCatalogues, addCatalogue, removeCatalogue,
} from "../src/plugins.ts";
import { callerFor, pluginTokenCount } from "../src/auth.ts";
import { blocklistPath } from "../src/plugin-blocklist.ts";

const okManifest = {
  name: "watcher", publisher: "someone in the community",
  description: "watches the gate", entrypoint: "true", scope: "read",
};

/** A local plugin folder on disk, ready to install. `run` is a shell body —
 *  by default one that exits immediately, because most tests only care that
 *  install copied and parsed the manifest. Tests that care about the
 *  process itself pass a body that keeps running. */
function fixture(manifest: Record<string, unknown> = okManifest, run = "true"): string {
  const dir = mkdtempSync(join(tmpdir(), "agx-plugin-src-"));
  writeFileSync(join(dir, MANIFEST_NAME), JSON.stringify(manifest));
  writeFileSync(join(dir, "run.sh"), `#!/bin/bash\n${run}\n`);
  chmodSync(join(dir, "run.sh"), 0o755);
  return dir;
}

beforeEach(async () => {
  process.env.NODE_ENV = "test";
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "agx-plugins-"));
  await __resetPlugins();
});

afterEach(async () => {
  await __resetPlugins();
});

describe("manifest validation", () => {
  test("a well-formed manifest passes", () => {
    const m = validateManifest(okManifest);
    expect(typeof m).toBe("object");
  });

  test("scope must be one of the three the code already enforces", () => {
    expect(validateManifest({ ...okManifest, scope: "admin" })).toContain("scope");
  });

  test("an empty or oversized entrypoint loses the plugin, not widens it", () => {
    expect(validateManifest({ ...okManifest, entrypoint: "" })).toContain("entrypoint");
    expect(validateManifest({ ...okManifest, entrypoint: "x".repeat(600) })).toContain("entrypoint");
  });

  test("a name outside the safe character set is refused", () => {
    expect(validateManifest({ ...okManifest, name: "../../etc" })).toContain("name");
  });

  test("not an object at all is refused, not coerced", () => {
    expect(validateManifest(null)).toContain("object");
    expect(validateManifest("watcher")).toContain("object");
    expect(validateManifest([1, 2])).toContain("object");
  });

  test("a missing field is refused rather than defaulted", () => {
    const { publisher: _drop, ...rest } = okManifest;
    expect(validateManifest(rest)).toContain("publisher");
  });

  // The character set admits `.` and `..`, and `pluginInstallDir("..")` is
  // the config directory itself — the one `finishInstall` wipes before the
  // copy. `projectadd.ts` kept this guard; the plugin copy had dropped it.
  test("dot, dot-dot and hidden names are refused — they name a directory this must never touch", () => {
    for (const bad of [".", "..", ".git", ".hidden"]) {
      expect(validPluginName(bad)).toBe(false);
      expect(validateManifest({ ...okManifest, name: bad })).toContain("name");
    }
    expect(validPluginName("watcher")).toBe(true);
    expect(validPluginName("my.plugin-2_x")).toBe(true);
    expect(validPluginName(42)).toBe(false);
  });
});

describe("install = copy, no code runs", () => {
  test("a local folder is copied and its manifest recorded", async () => {
    const src = fixture();
    const r = await installPlugin(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plugin.name).toBe("watcher");
    expect(r.plugin.enabled).toBe(false);
    expect(existsSync(join(r.plugin.installDir, MANIFEST_NAME))).toBe(true);
    expect(r.plugin.approvedHash).toBeNull();
  });

  test("no manifest at the root is refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agx-plugin-src-"));
    const r = await installPlugin(dir);
    expect(r.ok).toBe(false);
  });

  test("a bad manifest is refused and nothing is installed", async () => {
    const src = fixture({ ...okManifest, scope: "root" });
    const r = await installPlugin(src);
    expect(r.ok).toBe(false);
    expect(listPlugins()).toHaveLength(0);
  });

  test("a relative path is refused — it would resolve against the server, not the caller", async () => {
    const r = await installPlugin("relative/path");
    expect(r.ok).toBe(false);
  });

  test("a manifest named `..` leaves the config directory exactly as it was", async () => {
    const cfg = pluginsConfigDir();
    mkdirSync(cfg, { recursive: true });
    const sentinel = join(cfg, "settings-i-care-about.json");
    writeFileSync(sentinel, "{}");
    const r = await installPlugin(fixture({ ...okManifest, name: ".." }));
    expect(r.ok).toBe(false);
    expect(existsSync(sentinel)).toBe(true);
    expect(listPlugins()).toHaveLength(0);
  });
});

describe("consent does not survive an update", () => {
  test("enabling stamps the approved hash", async () => {
    const src = fixture();
    await installPlugin(src);
    const before = listPlugins()[0]!;
    expect(before.approvedHash).toBeNull();
    const r = await enablePlugin("watcher");
    expect(r.ok).toBe(true);
    const after = listPlugins()[0]!;
    expect(after.approvedHash).toBe(after.manifestHash);
    expect(after.enabled).toBe(true);
    await disablePlugin("watcher");
  });

  test("a scope change on reinstall clears the old approval and disables it", async () => {
    await installPlugin(fixture());
    await enablePlugin("watcher");
    expect(listPlugins()[0]!.enabled).toBe(true);

    // Same name, wider scope — a reviewer approved `read`, not this.
    await installPlugin(fixture({ ...okManifest, scope: "full" }));
    const rec = listPlugins()[0]!;
    expect(rec.scope).toBe("full");
    expect(rec.enabled).toBe(false);
    expect(rec.approvedHash).toBeNull();
    expect(rec.manifestHash).not.toBe(manifestHash(okManifest as never));
  });

  test("hadApproval tells 'never reviewed' apart from 'changed since approved'", async () => {
    await installPlugin(fixture());
    // Never enabled: a fresh install nobody has looked at.
    expect(listPlugins()[0]!.hadApproval).toBe(false);

    await enablePlugin("watcher");
    expect(listPlugins()[0]!.hadApproval).toBe(true);

    // The scope widens — approvedHash clears exactly as above, but this one
    // WAS approved once, and that fact must survive the update for the
    // reviewer to see: "asking for something different now", not "new".
    await installPlugin(fixture({ ...okManifest, scope: "full" }));
    const rec = listPlugins()[0]!;
    expect(rec.approvedHash).toBeNull();
    expect(rec.hadApproval).toBe(true);
  });

  test("an unchanged manifest keeps its approval across a reinstall", async () => {
    await installPlugin(fixture());
    await enablePlugin("watcher");
    await installPlugin(fixture()); // identical manifest
    const rec = listPlugins()[0]!;
    expect(rec.approvedHash).toBe(rec.manifestHash);
    await disablePlugin("watcher");
  });
});

describe("enable = scoped token + separate process; disable actually stops it", () => {
  test("enabling starts a real process and mints a token scoped as declared", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agx-plugin-src-"));
    const marker = join(dir, "marker");
    writeFileSync(join(dir, MANIFEST_NAME), JSON.stringify({ ...okManifest, scope: "answer" }));
    writeFileSync(join(dir, "run.sh"), `#!/bin/bash\necho -n "$AGENTGLASS_READ_TOKEN" > "${marker}"\nsleep 5\n`);
    chmodSync(join(dir, "run.sh"), 0o755);
    // entrypoint is a shell command, not a path — this is what a manifest declares.
    const manifest = { ...okManifest, scope: "answer", entrypoint: "bash run.sh" };
    writeFileSync(join(dir, MANIFEST_NAME), JSON.stringify(manifest));

    const before = pluginTokenCount();
    await installPlugin(dir);
    const r = await enablePlugin("watcher");
    expect(r.ok).toBe(true);
    expect(pluginTokenCount()).toBe(before + 1);

    // Give the child a moment to write its marker.
    for (let i = 0; i < 50 && !existsSync(marker); i++) await Bun.sleep(20);
    expect(existsSync(marker)).toBe(true);
    const token = readFileSync(marker, "utf8");
    expect(token.startsWith("pg_")).toBe(true);

    const caller = callerFor(new Request("http://x", { headers: { authorization: `Bearer ${token}` } }), new URL("http://x"), "unrelated-machine-token");
    expect(caller?.scope).toBe("answer");
    expect(caller?.plugin).toBe("watcher");

    const rec = listPlugins()[0]!;
    expect(rec.running).toBe(true);
    expect(rec.pid).toBeGreaterThan(0);

    await disablePlugin("watcher");
    expect(pluginTokenCount()).toBe(before);
    expect(listPlugins()[0]!.running).toBe(false);
    // The token is dead now, not just the process.
    const dead = callerFor(new Request("http://x", { headers: { authorization: `Bearer ${token}` } }), new URL("http://x"), "unrelated-machine-token");
    expect(dead).toBeNull();
  });

  test("enable refuses when the master switch is off", async () => {
    await installPlugin(fixture());
    await setMaster(false);
    const r = await enablePlugin("watcher");
    expect(r.ok).toBe(false);
    expect(listPlugins()[0]!.enabled).toBe(false);
  });

  test("turning the master switch off stops every running plugin", async () => {
    await installPlugin(fixture({ ...okManifest, entrypoint: "sleep 5" }));
    await enablePlugin("watcher");
    expect(listPlugins()[0]!.running).toBe(true);
    await setMaster(false);
    expect(listPlugins()[0]!.running).toBe(false);
  });
});

describe("remove", () => {
  test("stops the process, deletes the folder, drops the record", async () => {
    const r = await installPlugin(fixture({ ...okManifest, entrypoint: "sleep 5" }));
    if (!r.ok) throw new Error("install failed");
    await enablePlugin("watcher");
    const installDir = r.plugin.installDir;
    expect(existsSync(installDir)).toBe(true);
    const ok = await removePlugin("watcher");
    expect(ok).toBe(true);
    expect(existsSync(installDir)).toBe(false);
    expect(listPlugins()).toHaveLength(0);
  });

  // `plugins.json` is a file on disk; a record whose `installDir` points
  // outside the plugins folder is dropped without deleting anything.
  test("a tampered record pointing outside the plugins folder is dropped, the folder is not deleted", async () => {
    const outside = mkdtempSync(join(tmpdir(), "agx-not-a-plugin-"));
    writeFileSync(join(outside, "keep.txt"), "still here");
    const store = JSON.parse(readFileSync(pluginsPath(), "utf8"));
    store.plugins = [{
      ...okManifest, name: "rogue", source: { kind: "local-path", path: outside }, installDir: outside,
      manifestHash: "x", contentHash: "x", fingerprint: "x", resolvedCommit: null,
      approvedHash: null, approvedFingerprint: null, enabled: false, installedAt: 1, hadApproval: false,
    }];
    writeFileSync(pluginsPath(), JSON.stringify(store));
    expect(await removePlugin("rogue")).toBe(true);
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
    expect(listPlugins()).toHaveLength(0);
  });

  test("removing something that is not there is not a success", async () => {
    expect(await removePlugin("nobody")).toBe(false);
  });
});

describe("update = re-fetch at the recorded source", () => {
  test("a local-path install has no upstream to re-fetch", async () => {
    const r = await installPlugin(fixture());
    if (!r.ok) throw new Error("install failed");
    expect(r.plugin.source.kind).toBe("local-path");
    const u = await updatePlugin("watcher");
    expect(u.ok).toBe(false);
    if (u.ok) return;
    expect(u.error).toContain("no upstream");
  });

  test("updating something that is not installed is refused", async () => {
    const u = await updatePlugin("nobody");
    expect(u.ok).toBe(false);
  });
});

describe("install sources are a typed shape, not a free string", () => {
  test("a local install records a local-path source", async () => {
    const r = await installPlugin(fixture());
    if (!r.ok) throw new Error("install failed");
    expect(r.plugin.source.kind).toBe("local-path");
  });

  test("a bare git URL with credentials is refused before any clone runs", async () => {
    const r = await installPlugin("https://user:pass@example.com/someone/plugin.git");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("credentials");
  });

  test("plain http as a git source is refused", async () => {
    const r = await installPlugin("http://example.com/someone/plugin.git");
    expect(r.ok).toBe(false);
  });
});

describe("consent fingerprint sees a content-only rewrite the manifest hash cannot", () => {
  test("rewriting the entrypoint script without touching the manifest clears approval", async () => {
    const src = fixture(okManifest, "true");
    await installPlugin(src);
    await enablePlugin("watcher");
    const before = listPlugins()[0]!;
    expect(before.enabled).toBe(true);
    expect(before.approvedFingerprint).toBe(before.fingerprint);
    // Same manifest, same hash — but the script the entrypoint runs changed.
    expect(manifestHash(okManifest as never)).toBe(before.manifestHash);

    const rewritten = fixture(okManifest, "echo pwned");
    await installPlugin(rewritten);
    const after = listPlugins()[0]!;
    expect(after.manifestHash).toBe(before.manifestHash);
    expect(after.contentHash).not.toBe(before.contentHash);
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(after.approvedFingerprint).toBeNull();
    expect(after.enabled).toBe(false);
  });
});

describe("kill list", () => {
  test("enable refuses a blocked plugin key, with the reason surfaced", async () => {
    await installPlugin(fixture());
    mkdirSync(pluginsConfigDir(), { recursive: true });
    writeFileSync(blocklistPath(), JSON.stringify([
      { pluginKey: "watcher", reason: "known to exfiltrate tokens", link: "https://example.com/advisory" },
    ]));
    const r = await enablePlugin("watcher");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("exfiltrate");
    expect(listPlugins()[0]!.enabled).toBe(false);
  });

  test("a plugin not on the list enables normally", async () => {
    mkdirSync(pluginsConfigDir(), { recursive: true });
    writeFileSync(blocklistPath(), JSON.stringify([{ pluginKey: "someone-else", reason: "x", link: null }]));
    await installPlugin(fixture());
    const r = await enablePlugin("watcher");
    expect(r.ok).toBe(true);
    await disablePlugin("watcher");
  });
});

describe("catalogues he has added", () => {
  test("starts empty", () => {
    expect(listCatalogues()).toEqual([]);
  });

  test("add keeps it, remove drops it", () => {
    const r = addCatalogue("https://example.com/catalogue.json");
    expect(r.ok).toBe(true);
    expect(listCatalogues()).toEqual(["https://example.com/catalogue.json"]);
    expect(removeCatalogue("https://example.com/catalogue.json")).toBe(true);
    expect(listCatalogues()).toEqual([]);
  });

  test("adding the same url twice does not duplicate it", () => {
    addCatalogue("https://example.com/catalogue.json");
    addCatalogue("https://example.com/catalogue.json");
    expect(listCatalogues()).toEqual(["https://example.com/catalogue.json"]);
  });

  test("a credentialed or non-https url is refused, same rule as fetchCatalogue", () => {
    const r = addCatalogue("https://u:p@example.com/catalogue.json");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("credentials");
    expect(listCatalogues()).toEqual([]);
  });

  test("removing one that was never added is a no-op, reported honestly", () => {
    expect(removeCatalogue("https://example.com/never-added.json")).toBe(false);
  });
});
