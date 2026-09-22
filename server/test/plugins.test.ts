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
  removePlugin, listPlugins, masterEnabled, setMaster, __resetPlugins, pluginSettings, setPluginSettings,
  MANIFEST_NAME, pluginsConfigDir, pluginsPath, appVersion, versionAtLeast,
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

describe("a plugin that needs a newer app", () => {
  test("is refused at install, with what it needs and what this is", async () => {
    /* Refused rather than installed and left off: half of what a plugin
       declares is where it draws, and a surface this app does not have is not
       a setting somebody can switch on — it is a panel that never appears
       with nothing saying why. */
    const src = fixture({ ...okManifest, minApp: "9.9.9" } as never);
    const r = await installPlugin(src);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("9.9.9");
      expect(r.error).toContain(appVersion());
    }
    expect(listPlugins()).toHaveLength(0);
  });

  test("installs when the app is that old or newer, and a version that is not one is refused", async () => {
    const src = fixture({ ...okManifest, minApp: "0.0.1" } as never);
    expect((await installPlugin(src)).ok).toBe(true);
    await removePlugin("watcher");
    expect(validateManifest({ ...okManifest, minApp: "0.18" })).not.toBe("minApp must be a version like 0.18.0");
    for (const bad of ["latest", "v1.2.3", "1.2.3.4", "", 3]) {
      expect(validateManifest({ ...okManifest, minApp: bad })).toContain("minApp");
    }
  });

  test("older, newer and equal are told apart, with the parts that are missing read as zero", () => {
    expect(versionAtLeast("0.18.0", "0.18.0")).toBe(true);
    expect(versionAtLeast("0.18", "0.18.0")).toBe(true);
    expect(versionAtLeast("0.18.1", "0.18.0")).toBe(true);
    expect(versionAtLeast("1.0.0", "0.99.99")).toBe(true);
    expect(versionAtLeast("0.17.9", "0.18.0")).toBe(false);
    // 0.9 is older than 0.10, whatever a string comparison would say.
    expect(versionAtLeast("0.9.0", "0.10.0")).toBe(false);
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

  test("a caller that cannot show the declaration may not approve it", async () => {
    /*
     * Switching a plugin on IS the approval, and the window earns the right
     * to do it by drawing the scope and every place the plugin draws first.
     * A terminal draws nothing, so `agentglass-plugin enable` was one line
     * that granted a new manifest's scope with nobody having read it.
     *
     * `approved` is the caller saying it showed the declaration. Passing
     * false is refused while there is something new to read, and accepted
     * once the approval on file matches what is installed — a plugin already
     * approved is not re-approved by being switched on again.
     */
    const src = fixture();
    await installPlugin(src);
    const cold = await enablePlugin("watcher", false);
    expect(cold.ok).toBe(false);
    if (!cold.ok) expect(cold.error).toContain("--approve");
    expect(listPlugins()[0]!.enabled).toBe(false);

    expect((await enablePlugin("watcher", true)).ok).toBe(true);
    await disablePlugin("watcher");
    // Nothing has changed since it was approved, so this one goes through.
    expect((await enablePlugin("watcher", false)).ok).toBe(true);
    await disablePlugin("watcher");

    // Now it asks for more than it did, and the terminal is turned away again.
    writeFileSync(join(src, MANIFEST_NAME), JSON.stringify({ ...okManifest, scope: "full" }));
    await installPlugin(src);
    const changed = await enablePlugin("watcher", false);
    expect(changed.ok).toBe(false);
    if (!changed.ok) expect(changed.error).toContain("has changed");
    expect(listPlugins()[0]!.enabled).toBe(false);
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

  /*
   * What a person typed into a plugin's settings page — a review prompt they
   * spent an afternoon on — is theirs, not the plugin's. Uninstalling to
   * reinstall a fresh copy used to take it along with the folder, and the
   * reinstall came back with the defaults.
   */
  test("uninstall keeps the plugin's settings for a reinstall unless asked to drop them", async () => {
    const withSettings = { ...okManifest, contributes: { settings: [{ key: "prompt", type: "text", label: "Review prompt" }] } };
    const src = fixture(withSettings);
    expect((await installPlugin(src)).ok).toBe(true);
    expect(setPluginSettings("watcher", { prompt: "flag anything touching orbit/billing" }).ok).toBe(true);

    expect(await removePlugin("watcher")).toBe(true);
    expect(listPlugins()).toHaveLength(0);
    expect(readFileSync(pluginsPath(), "utf8")).toContain("orbit/billing");
    expect((await installPlugin(src)).ok).toBe(true);
    expect(pluginSettings("watcher")?.values.prompt, "a reinstall came back with the defaults").toBe("flag anything touching orbit/billing");

    expect(await removePlugin("watcher", { dropSettings: true })).toBe(true);
    expect(readFileSync(pluginsPath(), "utf8"), "asked to drop them, and they stayed on disk").not.toContain("orbit/billing");
    expect((await installPlugin(src)).ok).toBe(true);
    expect(pluginSettings("watcher")?.values.prompt ?? "").toBe("");
  });

  test("kept settings go back only to a plugin from the same place, not to any plugin with that name", async () => {
    // A name is not an identity: a different plugin installed under it from
    // somewhere else would otherwise read what was typed for the first one.
    const withToken = { ...okManifest, contributes: { settings: [{ key: "token", type: "text", label: "Token" }] } };
    const src = fixture(withToken);
    expect((await installPlugin(src)).ok).toBe(true);
    expect(setPluginSettings("watcher", { token: "orbit-secret-1042" }).ok).toBe(true);
    expect(await removePlugin("watcher")).toBe(true);

    const stranger = fixture(withToken);
    expect((await installPlugin(stranger)).ok).toBe(true);
    expect(pluginSettings("watcher")?.values.token ?? "", "another source inherited the kept settings").toBe("");

    // Nor does the stranger throw them away — not even when it has settings of
    // its own to keep on its way out, which is when a store keyed by name
    // alone wrote the stranger's over the first plugin's.
    expect(setPluginSettings("watcher", { token: "acme-secret-7" }).ok).toBe(true);
    expect(await removePlugin("watcher")).toBe(true);
    expect((await installPlugin(src)).ok).toBe(true);
    expect(pluginSettings("watcher")?.values.token, "a plugin from elsewhere wiped the kept settings").toBe("orbit-secret-1042");

    // And each gets its own back, whichever came first.
    expect(await removePlugin("watcher")).toBe(true);
    expect((await installPlugin(stranger)).ok).toBe(true);
    expect(pluginSettings("watcher")?.values.token, "the stranger's own kept settings were lost").toBe("acme-secret-7");
  });

  test("installing over a plugin from another source neither hands over its settings nor loses them", async () => {
    // Not an update: the same name from somewhere else replaces the record,
    // and the settings used to ride along to the stranger.
    const withToken = { ...okManifest, contributes: { settings: [{ key: "token", type: "text", label: "Token" }] } };
    const src = fixture(withToken);
    expect((await installPlugin(src)).ok).toBe(true);
    expect(setPluginSettings("watcher", { token: "orbit-secret-1042" }).ok).toBe(true);
    expect((await installPlugin(src)).ok).toBe(true);
    expect(pluginSettings("watcher")?.values.token, "an update from the same place lost its settings").toBe("orbit-secret-1042");

    expect((await installPlugin(fixture(withToken))).ok).toBe(true);
    expect(pluginSettings("watcher")?.values.token ?? "", "a plugin from elsewhere took over the settings").toBe("");
    expect(await removePlugin("watcher")).toBe(true);
    expect((await installPlugin(src)).ok).toBe(true);
    expect(pluginSettings("watcher")?.values.token, "replacing it threw the first plugin's settings away").toBe("orbit-secret-1042");
  });

  test("kept settings can still be dropped after the plugin is gone", async () => {
    const withSettings = { ...okManifest, contributes: { settings: [{ key: "prompt", type: "text", label: "Review prompt" }] } };
    expect((await installPlugin(fixture(withSettings))).ok).toBe(true);
    expect(setPluginSettings("watcher", { prompt: "orbit-only" }).ok).toBe(true);
    expect(await removePlugin("watcher")).toBe(true);
    expect(await removePlugin("watcher"), "nothing installed and nothing asked: still not found").toBe(false);
    expect(await removePlugin("watcher", { dropSettings: true })).toBe(true);
    expect(readFileSync(pluginsPath(), "utf8")).not.toContain("orbit-only");
    expect(await removePlugin("watcher", { dropSettings: true }), "nothing left to drop").toBe(false);
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

