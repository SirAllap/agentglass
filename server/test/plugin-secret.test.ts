/*
 * A `secret` settings field: a key or a token a plugin asks for.
 *
 * Kept in the same 0600 file as the other settings, handed back to the plugin
 * that declared it, and to nothing else. The whole promise is in what the
 * OTHER reads return, so every one of them is asserted on the raw text, not on
 * a field that might be renamed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  MANIFEST_NAME, __resetPlugins, installPlugin, listPlugins, pluginOwnSettings, pluginSettings, pluginsPath, removePlugin, setPluginSettings,
} from "../src/plugins.ts";
import { coerceValue, validateFields, validateTree } from "../../shared/pluginUi.ts";

const KEY = "tk-orbit-1042-not-a-real-key";

const manifest = {
  name: "orbit-scorer", publisher: "acme", description: "Needs a key.", entrypoint: "true", scope: "read",
  contributes: { settings: [
    { key: "apiKey", type: "secret", label: "Key" },
    { key: "mode", type: "select", label: "Mode", options: ["off", "live"], default: "off" },
  ] },
};

function fixture(m: unknown = manifest): string {
  const dir = mkdtempSync(join(tmpdir(), "agx-secret-src-"));
  writeFileSync(join(dir, MANIFEST_NAME), JSON.stringify(m));
  writeFileSync(join(dir, "run.sh"), "#!/bin/bash\ntrue\n");
  chmodSync(join(dir, "run.sh"), 0o755);
  return dir;
}

beforeEach(async () => {
  process.env.NODE_ENV = "test";
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "agx-secret-"));
  await __resetPlugins();
  expect((await installPlugin(fixture())).ok).toBe(true);
});
afterEach(async () => { await __resetPlugins(); });

describe("a secret field", () => {
  test("reads as not set until a value is saved", () => {
    const s = pluginSettings("orbit-scorer")!;
    expect(s.values.apiKey).toBeNull();
    expect(s.set).toEqual([]);
  });

  test("saving answers with which are set and never with the value", () => {
    const r = setPluginSettings("orbit-scorer", { apiKey: KEY });
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(r.ok && r.set).toEqual(["apiKey"]);
  });

  test("no reader but the plugin's own gets the value", () => {
    setPluginSettings("orbit-scorer", { apiKey: KEY });
    expect(JSON.stringify(pluginSettings("orbit-scorer")), "the window's read leaked it").not.toContain(KEY);
    expect(JSON.stringify(listPlugins()), "the plugin list leaked it").not.toContain(KEY);
    expect(pluginOwnSettings("orbit-scorer").apiKey).toBe(KEY);
  });

  test("it is kept in the plugins file, mode 0600", () => {
    setPluginSettings("orbit-scorer", { apiKey: KEY });
    expect(readFileSync(pluginsPath(), "utf8")).toContain(KEY);
    expect(statSync(pluginsPath()).mode & 0o777).toBe(0o600);
  });

  test("another field's save, or a null from a window that never had the value, leaves it alone", () => {
    setPluginSettings("orbit-scorer", { apiKey: KEY });
    setPluginSettings("orbit-scorer", { mode: "live" });
    setPluginSettings("orbit-scorer", { apiKey: null, mode: "live" });
    expect(pluginOwnSettings("orbit-scorer").apiKey).toBe(KEY);
  });

  test("an empty string clears it", () => {
    setPluginSettings("orbit-scorer", { apiKey: KEY });
    const r = setPluginSettings("orbit-scorer", { apiKey: "" });
    expect(r.ok && r.set).toEqual([]);
    expect(pluginSettings("orbit-scorer")!.set).toEqual([]);
  });

  test("dropping the plugin's settings takes the secret off disk too", async () => {
    setPluginSettings("orbit-scorer", { apiKey: KEY });
    await removePlugin("orbit-scorer", { dropSettings: true });
    expect(readFileSync(pluginsPath(), "utf8"), "a dropped secret stayed on disk").not.toContain(KEY);
  });
});

describe("the file the secret lives in", () => {
  test("stays 0600 when it already existed wider, and is replaced whole rather than truncated", () => {
    chmodSync(pluginsPath(), 0o644);
    const before = statSync(pluginsPath()).ino;
    setPluginSettings("orbit-scorer", { apiKey: KEY });
    expect(statSync(pluginsPath()).mode & 0o777, "a wider file stayed wider after a key was stored").toBe(0o600);
    expect(statSync(pluginsPath()).ino, "written in place: a crash half way leaves invalid JSON").not.toBe(before);
    expect(() => JSON.parse(readFileSync(pluginsPath(), "utf8"))).not.toThrow();
    expect(readdirSync(dirname(pluginsPath())).filter((f) => f.endsWith(".tmp")), "a temp file was left behind").toEqual([]);
  });
});

describe("a secret does not outlive what it was given for", () => {
  test("an update that turns the field into a plain string does not show the stored value", async () => {
    const src = fixture();
    expect((await installPlugin(src)).ok).toBe(true);
    setPluginSettings("orbit-scorer", { apiKey: KEY });
    const retyped = { ...manifest, contributes: { settings: [{ key: "apiKey", type: "string", label: "Key" }, manifest.contributes.settings[1]] } };
    writeFileSync(join(src, MANIFEST_NAME), JSON.stringify(retyped));
    expect((await installPlugin(src)).ok).toBe(true);
    expect(JSON.stringify(pluginSettings("orbit-scorer")), "the old key came back as a plain field").not.toContain(KEY);
    expect(readFileSync(pluginsPath(), "utf8")).not.toContain(KEY);
  });

  test("an update that keeps it a secret keeps the value", async () => {
    const src = fixture();
    expect((await installPlugin(src)).ok).toBe(true);
    setPluginSettings("orbit-scorer", { apiKey: KEY, mode: "live" });
    expect((await installPlugin(src)).ok).toBe(true);
    expect(pluginOwnSettings("orbit-scorer").apiKey).toBe(KEY);
  });

  test("removing the plugin drops the key but keeps the other settings for a reinstall", async () => {
    const src = fixture();
    expect((await installPlugin(src)).ok).toBe(true);
    setPluginSettings("orbit-scorer", { apiKey: KEY, mode: "live" });
    await removePlugin("orbit-scorer");
    expect(readFileSync(pluginsPath(), "utf8"), "the key stayed on disk after an uninstall").not.toContain(KEY);
    expect((await installPlugin(src)).ok).toBe(true);
    expect(pluginOwnSettings("orbit-scorer").mode).toBe("live");
    expect(pluginSettings("orbit-scorer")!.set).toEqual([]);
  });

  test("replacing the plugin with one from another source does not park the key for it either", async () => {
    setPluginSettings("orbit-scorer", { apiKey: KEY });
    expect((await installPlugin(fixture())).ok).toBe(true);
    expect(readFileSync(pluginsPath(), "utf8")).not.toContain(KEY);
  });
});

describe("the field's shape", () => {
  test("it is one trimmed line of at most 512 characters, and a non-string is nothing", () => {
    const f = { key: "k", type: "secret" as const, label: "Key" };
    expect(coerceValue(f, `  ${KEY}\n`)).toBe(KEY);
    expect(coerceValue(f, "x".repeat(600))).toHaveLength(512);
    expect(coerceValue(f, 42)).toBeUndefined();
  });

  test("a manifest cannot ship one with a default", () => {
    expect(validateFields([{ key: "k", type: "secret", label: "Key" }]).ok).toBe(true);
    expect(validateFields([{ key: "k", type: "secret", label: "Key", default: KEY }]).ok).toBe(false);
  });

  test("a drawn form never carries a secret's value", () => {
    const t = validateTree({
      type: "form", id: "f", fields: [{ key: "k", type: "secret", label: "Key" }, { key: "n", type: "string", label: "Name" }],
      values: { k: KEY, n: "orbit" }, submit: { label: "Save", action: { id: "save" } },
    });
    expect(t.ok && JSON.stringify(t.value)).not.toContain(KEY);
    expect(t.ok && t.value.type === "form" && t.value.values).toEqual({ n: "orbit" });
  });
});
