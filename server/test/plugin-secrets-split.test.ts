/*
 * The keys a plugin was given live in `secrets.json`, apart from the file the
 * approvals and fingerprints are in. The point of the split is that a secret
 * has exactly one reader, so each test here is about a file: what it holds,
 * what the other one does not, and what happens to the old layout.
 *
 * The ceiling is stated in plugins.ts and in the commit: a plugin running
 * outside its box, or any program running as the same user, can still read
 * secrets.json. None of this is asserted away.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  MANIFEST_NAME, __resetPlugins, installPlugin, listPlugins, pluginInstallDir, pluginOwnSettings, pluginSettings, pluginsPath, removePlugin, secretsPath, setPluginSettings, validPluginName,
} from "../src/plugins.ts";
import { __resetSandboxProbe, resolveGrants } from "../src/plugin-sandbox.ts";
import type { PluginSandbox } from "../../shared/pluginSandbox.ts";

const KEY = "sk-orbit-test-0000";
const OTHER_KEY = "sk-orbit-test-1111";

const manifestOf = (name: string) => ({
  name, publisher: "acme", description: "Needs a key.", entrypoint: "true", scope: "read",
  contributes: { settings: [
    { key: "apiKey", type: "secret", label: "Key" },
    { key: "mode", type: "select", label: "Mode", options: ["off", "live"], default: "off" },
  ] },
});

function fixture(name = "orbit-scorer", m: unknown = manifestOf(name)): string {
  const dir = mkdtempSync(join(tmpdir(), "agx-secrets-split-src-"));
  writeFileSync(join(dir, MANIFEST_NAME), JSON.stringify(m));
  writeFileSync(join(dir, "run.sh"), "#!/bin/bash\ntrue\n");
  chmodSync(join(dir, "run.sh"), 0o755);
  return dir;
}

const savedXdg = process.env.XDG_CONFIG_HOME;
const savedNodeEnv = process.env.NODE_ENV;
afterAll(() => {
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedXdg;
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedNodeEnv;
});

beforeEach(async () => {
  process.env.NODE_ENV = "test";
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "agx-secrets-split-"));
  await __resetPlugins();
  expect((await installPlugin(fixture())).ok).toBe(true);
});
afterEach(async () => { await __resetPlugins(); });

const rawPlugins = () => JSON.parse(readFileSync(pluginsPath(), "utf8"));
const rawSecrets = () => JSON.parse(readFileSync(secretsPath(), "utf8"));

/** Runs `fn` with a directory where secrets.json goes, so every write of it
 *  fails, and puts the path back after. */
function withSecretsBlocked(fn: () => void): void {
  rmSync(secretsPath(), { force: true });
  mkdirSync(secretsPath());
  try { fn(); } finally { rmSync(secretsPath(), { recursive: true, force: true }); }
}

const tmpLeft = (p: string): string[] => readdirSync(dirname(p)).filter((f) => f.endsWith(".tmp"));

/** What an older build left behind: the key inside the plugin's own record. */
function plantKeyInPluginsFile(name: string, key: string, value: string): void {
  const store = rawPlugins();
  const rec = store.plugins.find((p: { name: string }) => p.name === name);
  rec.settings = { ...(rec.settings ?? {}), [key]: value, mode: "live" };
  writeFileSync(pluginsPath(), JSON.stringify(store, null, 2));
}

describe("where a key is kept", () => {
  test("in secrets.json under the plugin's id, never in plugins.json", () => {
    setPluginSettings("orbit-scorer", { apiKey: KEY, mode: "live" });
    expect(rawSecrets()).toEqual({ "orbit-scorer": { apiKey: KEY } });
    expect(JSON.stringify(rawPlugins()), "the key is in plugins.json").not.toContain(KEY);
    expect(rawPlugins().plugins[0].settings, "a plain setting went missing from plugins.json").toEqual({ mode: "live" });
  });

  test("two plugins keep their own, side by side, and each reads only its own", async () => {
    expect((await installPlugin(fixture("orbit-peer"))).ok).toBe(true);
    setPluginSettings("orbit-scorer", { apiKey: KEY });
    setPluginSettings("orbit-peer", { apiKey: OTHER_KEY });
    expect(rawSecrets()).toEqual({ "orbit-scorer": { apiKey: KEY }, "orbit-peer": { apiKey: OTHER_KEY } });
    expect(pluginOwnSettings("orbit-scorer").apiKey).toBe(KEY);
    expect(pluginOwnSettings("orbit-peer").apiKey).toBe(OTHER_KEY);
    expect(JSON.stringify(pluginOwnSettings("orbit-peer"))).not.toContain(KEY);
  });

  test("the window's read and the plugin list get null and a name, never the value", () => {
    setPluginSettings("orbit-scorer", { apiKey: KEY });
    const s = pluginSettings("orbit-scorer")!;
    expect(s.values.apiKey).toBeNull();
    expect(s.set).toEqual(["apiKey"]);
    expect(JSON.stringify(s)).not.toContain(KEY);
    expect(JSON.stringify(listPlugins())).not.toContain(KEY);
  });

  test("0600, replaced whole, no temp file left", () => {
    setPluginSettings("orbit-scorer", { apiKey: KEY });
    chmodSync(secretsPath(), 0o644);
    const before = statSync(secretsPath()).ino;
    setPluginSettings("orbit-scorer", { apiKey: OTHER_KEY });
    expect(statSync(secretsPath()).mode & 0o777).toBe(0o600);
    expect(statSync(secretsPath()).ino, "written in place").not.toBe(before);
    expect(tmpLeft(secretsPath())).toEqual([]);
  });
});

describe("plugins.json, which still holds the approvals and the plain settings", () => {
  test("0600, replaced whole, no temp file left: the guard that used to sit on it moved to secrets.json and this keeps one on each", () => {
    setPluginSettings("orbit-scorer", { mode: "live" });
    chmodSync(pluginsPath(), 0o644);
    const before = statSync(pluginsPath()).ino;
    setPluginSettings("orbit-scorer", { mode: "off" });
    expect(statSync(pluginsPath()).mode & 0o777, "a wider file stayed wider").toBe(0o600);
    expect(statSync(pluginsPath()).ino, "written in place").not.toBe(before);
    expect(() => JSON.parse(readFileSync(pluginsPath(), "utf8"))).not.toThrow();
    expect(tmpLeft(pluginsPath())).toEqual([]);
  });
});

describe("the temp file a write goes through", () => {
  test("a link or a stale file left at its name is replaced, never written through", () => {
    const decoy = join(mkdtempSync(join(tmpdir(), "agx-secrets-split-decoy-")), "elsewhere");
    writeFileSync(decoy, "untouched", { mode: 0o644 });
    symlinkSync(decoy, `${secretsPath()}.${process.pid}.tmp`);
    setPluginSettings("orbit-scorer", { apiKey: KEY });
    expect(readFileSync(decoy, "utf8"), "the key was written through the link").toBe("untouched");
    expect(lstatSync(secretsPath()).isFile(), "a link was renamed over secrets.json").toBe(true);
    expect(rawSecrets()).toEqual({ "orbit-scorer": { apiKey: KEY } });
    expect(statSync(secretsPath()).mode & 0o777).toBe(0o600);
    expect(tmpLeft(secretsPath())).toEqual([]);
  });
});

describe("a key an older build kept in plugins.json", () => {
  test("moves to secrets.json on the next read, and the plain settings stay", () => {
    plantKeyInPluginsFile("orbit-scorer", "apiKey", KEY);
    expect(pluginOwnSettings("orbit-scorer")).toEqual({ apiKey: KEY, mode: "live" });
    expect(rawSecrets()).toEqual({ "orbit-scorer": { apiKey: KEY } });
    expect(readFileSync(pluginsPath(), "utf8"), "the key was copied, not moved").not.toContain(KEY);
    expect(rawPlugins().plugins[0].settings).toEqual({ mode: "live" });
    expect(pluginSettings("orbit-scorer")!.set).toEqual(["apiKey"]);
  });

  test("is idempotent: a second read changes neither file", () => {
    plantKeyInPluginsFile("orbit-scorer", "apiKey", KEY);
    pluginOwnSettings("orbit-scorer");
    const [a, b] = [statSync(pluginsPath()).ino, statSync(secretsPath()).ino];
    const [pa, sa] = [readFileSync(pluginsPath(), "utf8"), readFileSync(secretsPath(), "utf8")];
    pluginOwnSettings("orbit-scorer");
    listPlugins();
    expect(statSync(pluginsPath()).ino, "plugins.json was rewritten with nothing to move").toBe(a);
    expect(statSync(secretsPath()).ino, "secrets.json was rewritten with nothing to move").toBe(b);
    expect(readFileSync(pluginsPath(), "utf8")).toBe(pa);
    expect(readFileSync(secretsPath(), "utf8")).toBe(sa);
  });

  // plugins.json can hold a key on this build in two ways. A crash between the
  // two writes of a migration leaves the same value in both files, so which
  // wins does not matter. An older build sharing the config folder (a
  // downgrade, or an installed app beside a dev server) writes what a person
  // typed AFTER the new build moved the first key, and that copy is the newer:
  // keeping secrets.json's would discard it.
  test("a copy in plugins.json wins over an older one in secrets.json: the key typed last is the one kept", () => {
    setPluginSettings("orbit-scorer", { apiKey: OTHER_KEY });
    plantKeyInPluginsFile("orbit-scorer", "apiKey", KEY);
    expect(pluginOwnSettings("orbit-scorer").apiKey).toBe(KEY);
    expect(rawSecrets()).toEqual({ "orbit-scorer": { apiKey: KEY } });
    expect(readFileSync(pluginsPath(), "utf8")).not.toContain(KEY);
  });

  test("a crash between the two writes leaves the same value in both, and one copy is kept", () => {
    setPluginSettings("orbit-scorer", { apiKey: KEY });
    plantKeyInPluginsFile("orbit-scorer", "apiKey", KEY);
    expect(pluginOwnSettings("orbit-scorer").apiKey).toBe(KEY);
    expect(rawSecrets()).toEqual({ "orbit-scorer": { apiKey: KEY } });
    expect(readFileSync(pluginsPath(), "utf8")).not.toContain(KEY);
  });

  test("when secrets.json cannot be written, the key stays in plugins.json and is still served", () => {
    withSecretsBlocked(() => { // a directory where the file goes: the rename fails
      plantKeyInPluginsFile("orbit-scorer", "apiKey", KEY);
      expect(pluginOwnSettings("orbit-scorer").apiKey, "the key was lost with the failed write").toBe(KEY);
      expect(readFileSync(pluginsPath(), "utf8"), "deleted from plugins.json before it was safe elsewhere").toContain(KEY);
      expect(JSON.stringify(pluginSettings("orbit-scorer")), "the window was handed the value").not.toContain(KEY);
      expect(JSON.stringify(listPlugins())).not.toContain(KEY);
    });
    // The disk is fine again: the next read moves it.
    expect(pluginOwnSettings("orbit-scorer").apiKey).toBe(KEY);
    expect(rawSecrets()).toEqual({ "orbit-scorer": { apiKey: KEY } });
    expect(readFileSync(pluginsPath(), "utf8")).not.toContain(KEY);
  });

  test("a record that makes no sense does not read as a corrupt file: the other plugins are still there after the next write", async () => {
    const store = rawPlugins();
    const base = store.plugins[0];
    store.plugins.push(
      { ...base, name: "orbit-odd-a", settings: "x", contributes: { settings: "nope" } },
      { ...base, name: "orbit-odd-b", settings: 5, contributes: { settings: [null, { key: "apiKey", type: "secret", label: "Key" }] } },
      { ...base, name: "orbit-odd-c", settings: { apiKey: KEY }, contributes: { settings: [{ key: "apiKey", type: "secret", label: "Key" }] } },
    );
    writeFileSync(pluginsPath(), JSON.stringify(store, null, 2));
    expect(listPlugins().map((p) => p.name), "the store read as empty").toEqual(["orbit-scorer", "orbit-odd-a", "orbit-odd-b", "orbit-odd-c"]);
    expect(setPluginSettings("orbit-scorer", { apiKey: OTHER_KEY }).ok).toBe(true);
    expect(rawPlugins().plugins.map((p: { name: string }) => p.name), "the next write emptied the store").toHaveLength(4);
    expect(pluginOwnSettings("orbit-odd-c").apiKey, "a sound entry beside broken ones was not migrated").toBe(KEY);
  });

  test("setting a key that cannot be saved says so, and writes nothing", () => {
    withSecretsBlocked(() => {
      const r = setPluginSettings("orbit-scorer", { apiKey: KEY, mode: "live" });
      expect(r.ok, "answered ok with the key unsaved").toBe(false);
      expect(rawPlugins().plugins[0].settings ?? {}, "a plain setting was saved around the failed key").toEqual({});
    });
  });

  test("says nothing: no log line carries the value", () => {
    const spies = (["log", "warn", "error", "info"] as const).map((m) => spyOn(console, m).mockImplementation(() => {}));
    try {
      plantKeyInPluginsFile("orbit-scorer", "apiKey", KEY);
      pluginOwnSettings("orbit-scorer");
      const said = spies.flatMap((s) => s.mock.calls).map((c) => c.join(" ")).join("\n");
      expect(said).not.toContain(KEY);
    } finally { for (const s of spies) s.mockRestore(); }
  });

  test("an empty or non-string value moves nothing", () => {
    plantKeyInPluginsFile("orbit-scorer", "apiKey", "");
    pluginOwnSettings("orbit-scorer");
    expect(existsSync(secretsPath()) ? rawSecrets() : {}).toEqual({});
    expect(pluginSettings("orbit-scorer")!.set).toEqual([]);
  });
});

/*
 * A plugin's name and a field's key are the property names of two plain
 * objects. `__proto__` among them is not a key but the object's prototype:
 * `secrets["__proto__"] ??= {}` found Object.prototype already there, so a
 * migrated value was written onto Object.prototype and every object in the
 * server read it as its own.
 */
describe("names that are properties of every object", () => {
  const RESERVED = ["__proto__", "constructor", "prototype"];
  const scrub = () => { for (const k of ["apiKey", "mode"]) delete (Object.prototype as Record<string, unknown>)[k]; };
  afterEach(scrub);

  test("are not a name a plugin can be installed under, nor a key a field can have", async () => {
    for (const n of RESERVED) {
      expect(validPluginName(n), `${n} passed as a plugin name`).toBe(false);
      expect((await installPlugin(fixture(n))).ok, `${n} installed`).toBe(false);
      const m = manifestOf("orbit-fields");
      m.contributes.settings[0] = { key: n, type: "secret", label: "Key" } as never;
      expect((await installPlugin(fixture("orbit-fields", m))).ok, `a field keyed ${n} installed`).toBe(false);
    }
  });

  test("a record already on disk under one is ignored: nothing lands on Object.prototype, the other plugins stay", async () => {
    for (const n of RESERVED) {
      expect(await removePlugin(n, { dropSettings: true }), `removing ${n} found something`).toBe(false);
      const store = rawPlugins();
      const ghost = { ...store.plugins[0], name: n, settings: { apiKey: KEY, mode: "live" } };
      store.plugins = [store.plugins[0], ghost];
      writeFileSync(pluginsPath(), JSON.stringify(store, null, 2));
      listPlugins();
      expect(({} as Record<string, unknown>).apiKey, `a value from a record named ${n} reached every object`).toBeUndefined();
      expect(({} as Record<string, unknown>).mode).toBeUndefined();
      expect(listPlugins().map((p) => p.name), `the store was emptied by a record named ${n}`).toEqual(["orbit-scorer"]);
      expect(pluginSettings("orbit-scorer"), "a bystander stopped answering").not.toBeNull();
      expect(existsSync(secretsPath()) ? JSON.stringify(rawSecrets()) : "").not.toContain(KEY);
    }
  });
});

describe("a key does not outlive what it was given for", () => {
  test("removing the plugin drops it from secrets.json, with or without dropSettings", async () => {
    setPluginSettings("orbit-scorer", { apiKey: KEY });
    await removePlugin("orbit-scorer");
    expect(rawSecrets()).toEqual({});
    expect((await installPlugin(fixture())).ok).toBe(true);
    setPluginSettings("orbit-scorer", { apiKey: KEY });
    await removePlugin("orbit-scorer", { dropSettings: true });
    expect(rawSecrets()).toEqual({});
  });

  test("an update that retypes the field drops it; one that keeps it a secret keeps it", async () => {
    const src = fixture();
    expect((await installPlugin(src)).ok).toBe(true);
    setPluginSettings("orbit-scorer", { apiKey: KEY });
    expect((await installPlugin(src)).ok).toBe(true);
    expect(pluginOwnSettings("orbit-scorer").apiKey, "a same-source update lost the key").toBe(KEY);
    const retyped = manifestOf("orbit-scorer");
    retyped.contributes.settings[0] = { key: "apiKey", type: "string", label: "Key" } as never;
    writeFileSync(join(src, MANIFEST_NAME), JSON.stringify(retyped));
    expect((await installPlugin(src)).ok).toBe(true);
    expect(rawSecrets(), "the old key is still on disk").toEqual({});
    expect(pluginOwnSettings("orbit-scorer").apiKey, "the old key came back as a plain field").toBeNull();
  });

  test("another plugin installed under the same name from elsewhere starts with none", async () => {
    setPluginSettings("orbit-scorer", { apiKey: KEY });
    expect((await installPlugin(fixture())).ok).toBe(true);
    expect(rawSecrets()).toEqual({});
    expect(pluginOwnSettings("orbit-scorer").apiKey).toBeNull();
  });

  test("clearing one with an empty string takes it out of the file, not just out of view", () => {
    setPluginSettings("orbit-scorer", { apiKey: KEY });
    setPluginSettings("orbit-scorer", { apiKey: "" });
    expect(rawSecrets()).toEqual({});
  });
});

describe("what a plugin that has no secrets of its own may not do", () => {
  const home = () => mkdtempSync(join(tmpdir(), "agx-secrets-split-home-"));
  const NO_GRANTS: PluginSandbox = { network: "agentglass", read: [], write: [], programs: [] };

  test("a box is never given the config folder, nor the file inside it", () => {
    const h = home();
    process.env.XDG_CONFIG_HOME = join(h, ".config");
    mkdirSync(join(h, ".config", "agentglass"), { recursive: true });
    writeFileSync(join(h, ".config", "agentglass", "secrets.json"), "{}");
    for (const grant of ["~/.config/agentglass", "~/.config/agentglass/secrets.json", "~/.config"]) {
      for (const kind of ["read", "write"] as const) {
        const r = resolveGrants({ ...NO_GRANTS, [kind]: [grant] }, h);
        expect(r[kind], `${kind} ${grant} was granted`).toEqual([]);
        expect(r.refused, `${kind} ${grant} was not refused`).toHaveLength(1);
      }
    }
  });
});

describe("the one reader", () => {
  test("no module but plugins.ts names the file", async () => {
    const dir = new URL("../src/", import.meta.url).pathname;
    const named: string[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".ts") || f === "plugins.ts") continue;
      const text = (await Bun.file(join(dir, f)).text()).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
      if (/secrets\.json|secretsPath|readSecrets/.test(text)) named.push(f);
    }
    // browse.ts closes it by name, which is naming it to keep it shut.
    expect(named.filter((f) => f !== "browse.ts")).toEqual([]);
  });
});

/** The name a write goes through before it is renamed over `p`. A directory
 *  there fails the write the way a full disk does, while every read still works. */
async function withWriteBlocked(p: string, fn: () => void | Promise<void>): Promise<void> {
  // `writeAtomic` writes through this name (`<file>.<pid>.tmp`); the guards on
  // the tests below go red if it is ever renamed, since nothing would be blocked.
  const tmp = `${p}.${process.pid}.tmp`;
  mkdirSync(tmp);
  try { await fn(); } finally { rmSync(tmp, { recursive: true, force: true }); }
}

describe("a key that could not be deleted is not handed to what comes next", () => {
  test("a different source under the same name is refused, and the key is not served to it", async () => {
    setPluginSettings("orbit-scorer", { apiKey: KEY });
    await withWriteBlocked(secretsPath(), async () => {
      const r = await installPlugin(fixture()); // another folder: another plugin
      expect(r.ok, "the install went on with the old key on disk").toBe(false);
    });
    expect(pluginOwnSettings("orbit-scorer").apiKey, "the plugin that was there lost its key to a failed install").toBe(KEY);
    // Disk is fine again: the same install now goes through and takes the key with it.
    expect((await installPlugin(fixture())).ok).toBe(true);
    expect(pluginOwnSettings("orbit-scorer").apiKey).toBeNull();
    expect(rawSecrets()).toEqual({});
  });

  test("a remove that cannot revoke the key fails and leaves the record, so nothing can inherit it", async () => {
    setPluginSettings("orbit-scorer", { apiKey: KEY });
    await withWriteBlocked(secretsPath(), async () => {
      await expect(removePlugin("orbit-scorer")).rejects.toThrow("could not drop");
      await expect(removePlugin("orbit-scorer", { dropSettings: true })).rejects.toThrow("could not drop");
    });
    expect(listPlugins().map((p) => p.name), "the record went while the key stayed").toEqual(["orbit-scorer"]);
    expect(await removePlugin("orbit-scorer")).toBe(true);
    expect(rawSecrets()).toEqual({});
    expect((await installPlugin(fixture())).ok).toBe(true);
    expect(pluginOwnSettings("orbit-scorer").apiKey).toBeNull();
  });

  test("a remove with only its kept settings left says so too, not that nothing was there", async () => {
    setPluginSettings("orbit-scorer", { apiKey: KEY, mode: "live" });
    expect(await removePlugin("orbit-scorer")).toBe(true); // keeps mode
    const f = secretsPath();
    writeFileSync(f, JSON.stringify({ "orbit-scorer": { apiKey: KEY } }), { mode: 0o600 }); // a key put back by hand
    await withWriteBlocked(f, async () => {
      await expect(removePlugin("orbit-scorer", { dropSettings: true })).rejects.toThrow("could not drop");
    });
  });
});

/** secrets.json present and unreadable (mode 000) in a folder that is still
 *  writable: a read fails the way an EIO does and a rewrite would go through. */
async function withSecretsUnreadable(fn: () => void | Promise<void>): Promise<void> {
  chmodSync(secretsPath(), 0o000);
  expect(() => readFileSync(secretsPath()), "the file is still readable, so nothing is being tested").toThrow();
  try { await fn(); } finally { chmodSync(secretsPath(), 0o600); }
}

describe("a key that could not be read is not taken for no key", () => {
  test("a different source is refused, and the key is not served to it afterwards", async () => {
    setPluginSettings("orbit-scorer", { apiKey: KEY });
    await withSecretsUnreadable(async () => {
      const r = await installPlugin(fixture());
      expect(r.ok, "the install went on as if the file held nothing").toBe(false);
      if (!r.ok) expect(r.error).toContain("could not drop the old key");
    });
    expect(pluginOwnSettings("orbit-scorer").apiKey, "the plugin that was there lost its key to a failed install").toBe(KEY);
    expect((await installPlugin(fixture())).ok).toBe(true);
    expect(pluginOwnSettings("orbit-scorer").apiKey).toBeNull();
  });

  test("a remove is refused and leaves the record and the key", async () => {
    setPluginSettings("orbit-scorer", { apiKey: KEY });
    await withSecretsUnreadable(async () => {
      await expect(removePlugin("orbit-scorer")).rejects.toThrow("could not drop");
    });
    expect(listPlugins().map((p) => p.name)).toEqual(["orbit-scorer"]);
    expect(rawSecrets()).toEqual({ "orbit-scorer": { apiKey: KEY } });
  });

  test("a key typed for one plugin does not rewrite the file without the others'", async () => {
    expect((await installPlugin(fixture("orbit-other"))).ok).toBe(true);
    setPluginSettings("orbit-other", { apiKey: OTHER_KEY });
    await withSecretsUnreadable(() => {
      expect(setPluginSettings("orbit-scorer", { apiKey: KEY }).ok, "answered ok over a file it could not read").toBe(false);
    });
    expect(rawSecrets(), "another plugin's key went with the rewrite").toEqual({ "orbit-other": { apiKey: OTHER_KEY } });
  });

  test("a key still in plugins.json is not moved over a file that could not be read", async () => {
    setPluginSettings("orbit-scorer", { apiKey: KEY });
    plantKeyInPluginsFile("orbit-scorer", "apiKey", OTHER_KEY);
    await withSecretsUnreadable(() => {
      pluginOwnSettings("orbit-scorer");
    });
    expect(rawSecrets(), "the file was rewritten from a read that failed").toEqual({ "orbit-scorer": { apiKey: KEY } });
  });
});

describe("an install whose record cannot be saved puts nothing in place", () => {
  test("the old folder is back, and the install says it failed", async () => {
    const dir = pluginInstallDir("orbit-scorer");
    const before = readFileSync(join(dir, "run.sh"), "utf8");
    const next = fixture();
    writeFileSync(join(next, "run.sh"), "#!/bin/bash\necho changed\n");
    await withWriteBlocked(pluginsPath(), async () => {
      const r = await installPlugin(next);
      expect(r.ok, "ok, with the record on disk still the old one").toBe(false);
    });
    expect(readFileSync(join(dir, "run.sh"), "utf8"), "new bytes under the old record").toBe(before);
    expect(readdirSync(dirname(dir)).filter((f) => f.includes(".old-")), "the folder put aside was left").toEqual([]);
    expect((await installPlugin(next)).ok).toBe(true);
    expect(readFileSync(join(dir, "run.sh"), "utf8")).toContain("changed");
  });
});

describe("a migration that cannot finish does not bring an old key back", () => {
  const stuck = (): void => {
    plantKeyInPluginsFile("orbit-scorer", "apiKey", KEY);
    expect(pluginOwnSettings("orbit-scorer").apiKey).toBe(KEY); // the read that moves it and cannot strip plugins.json
  };

  test("a newer key is refused while the old copy is still on disk, and wins once it is not", async () => {
    await withWriteBlocked(pluginsPath(), () => {
      stuck();
      expect(rawSecrets()).toEqual({ "orbit-scorer": { apiKey: KEY } });
      const r = setPluginSettings("orbit-scorer", { apiKey: OTHER_KEY });
      expect(r.ok, "answered ok with a key that the next start would overwrite").toBe(false);
      expect(pluginOwnSettings("orbit-scorer").apiKey).toBe(KEY);
    });
    expect(setPluginSettings("orbit-scorer", { apiKey: OTHER_KEY }).ok).toBe(true);
    expect(readFileSync(pluginsPath(), "utf8"), "the old copy is still in plugins.json").not.toContain(KEY);
    expect(pluginOwnSettings("orbit-scorer").apiKey).toBe(OTHER_KEY);
    expect(rawSecrets()).toEqual({ "orbit-scorer": { apiKey: OTHER_KEY } });
  });

  test("a deleted key does not come back: a clear and a remove are refused while it is still there", async () => {
    await withWriteBlocked(pluginsPath(), async () => {
      stuck();
      expect(setPluginSettings("orbit-scorer", { apiKey: "" }).ok).toBe(false);
      await expect(removePlugin("orbit-scorer")).rejects.toThrow("could not drop");
    });
    expect(setPluginSettings("orbit-scorer", { apiKey: "" }).ok).toBe(true);
    expect(pluginOwnSettings("orbit-scorer").apiKey).toBeNull();
    expect(rawSecrets()).toEqual({});
  });

  test("reads do not retry it: secrets.json is not rewritten on every look", async () => {
    await withWriteBlocked(pluginsPath(), () => {
      stuck();
      const before = statSync(secretsPath()).ino;
      for (let i = 0; i < 5; i++) pluginOwnSettings("orbit-scorer");
      expect(statSync(secretsPath()).ino, "rewritten by a read").toBe(before);
    });
  });

  test("a plain setting that cannot be saved says so", async () => {
    await withWriteBlocked(pluginsPath(), () => {
      const r = setPluginSettings("orbit-scorer", { mode: "live" });
      expect(r.ok, "answered ok with nothing saved").toBe(false);
    });
    expect(pluginOwnSettings("orbit-scorer").mode).toBe("off");
  });
});

describe("the red line also covers a plugin that is enabled and not running", () => {
  const saved = { bwrap: process.env.AGENTGLASS_BWRAP, unboxed: process.env.AGENTGLASS_PLUGINS_UNBOXED };
  const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  afterEach(() => {
    restore("AGENTGLASS_BWRAP", saved.bwrap);
    restore("AGENTGLASS_PLUGINS_UNBOXED", saved.unboxed);
    __resetSandboxProbe();
  });

  /** Two installed, both holding a key, as plugins.json says they are: enabled
   *  or not, and none of them running. */
  async function twoHolders(enabled: boolean): Promise<void> {
    expect((await installPlugin(fixture("orbit-peer"))).ok).toBe(true);
    setPluginSettings("orbit-scorer", { apiKey: KEY });
    setPluginSettings("orbit-peer", { apiKey: OTHER_KEY });
    const store = rawPlugins();
    for (const rec of store.plugins) rec.enabled = enabled;
    writeFileSync(pluginsPath(), JSON.stringify(store, null, 2), { mode: 0o600 });
  }
  const readable = () => Object.fromEntries(listPlugins({ keyExposure: true }).map((p) => [p.name, p.canReadKeysOf]));

  test("when it would start unboxed, it is told whose key it could read", async () => {
    process.env.AGENTGLASS_BWRAP = "/nonexistent/bwrap";
    process.env.AGENTGLASS_PLUGINS_UNBOXED = "1";
    __resetSandboxProbe();
    await twoHolders(true);
    expect(listPlugins().every((p) => !p.running)).toBe(true);
    expect(readable()).toEqual({ "orbit-scorer": ["orbit-peer"], "orbit-peer": ["orbit-scorer"] });
  });

  test("not when it is off, nor when the host would refuse to start it unboxed", async () => {
    process.env.AGENTGLASS_BWRAP = "/nonexistent/bwrap";
    process.env.AGENTGLASS_PLUGINS_UNBOXED = "1";
    __resetSandboxProbe();
    await twoHolders(false);
    expect(readable(), "an off plugin was warned about").toEqual({ "orbit-scorer": undefined, "orbit-peer": undefined });
    const store = rawPlugins();
    for (const rec of store.plugins) rec.enabled = true;
    writeFileSync(pluginsPath(), JSON.stringify(store, null, 2), { mode: 0o600 });
    delete process.env.AGENTGLASS_PLUGINS_UNBOXED;
    if (process.platform === "linux") expect(readable(), "a plugin the host refuses to start was warned about").toEqual({ "orbit-scorer": undefined, "orbit-peer": undefined });
  });
});
