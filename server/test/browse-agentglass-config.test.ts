/*
 * The agentglass config folder in the file palette.
 *
 * It holds the server's API token, credentials, paired devices and plugin
 * secrets, and was shut whole; its owner also keeps theme.json and config.json
 * there. A caller on this machine may now LIST it and read its ordinary files,
 * while every key stays closed by name AND by mode.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browseDir, fileBytes, fileFacts, openInDesktop } from "../src/browse.ts";

const was = { cfg: process.env.XDG_CONFIG_HOME, roots: process.env.AGENTGLASS_DISK_ROOTS };
const root = mkdtempSync(join(tmpdir(), "agx-cfgdoor-"));
const cfg = join(root, "cfg");
const ag = join(cfg, "agentglass");
const other = join(root, "docs");

beforeAll(() => {
  process.env.XDG_CONFIG_HOME = cfg;
  process.env.AGENTGLASS_DISK_ROOTS = root;
  mkdirSync(ag, { recursive: true });
  mkdirSync(other);
  const put = (n: string, mode: number) => { writeFileSync(join(ag, n), "fake-" + n); chmodSync(join(ag, n), mode); };
  put("theme.json", 0o644);
  put("config.json", 0o644);
  put("token", 0o600);
  put("credentials.json", 0o600);
  put("devices.json", 0o600);
  put("notify-prefs.json", 0o600);
  put("plugins.json", 0o600);
  put("secrets.json", 0o600);
  put("plugin-notes.json", 0o600);
  // Perms drifted: readable, but the NAME still keeps it shut.
  put("drifted", 0o644);
  mkdirSync(join(ag, "plugin-data"), { mode: 0o700 });
  chmodSync(join(ag, "plugin-data"), 0o700);
  writeFileSync(join(ag, "plugin-data", "notes.txt"), "secret");
  chmodSync(join(ag, "plugin-data", "notes.txt"), 0o644);
  symlinkSync(join(ag, "token"), join(other, "innocent.txt"));
  symlinkSync(join(ag, "token"), join(ag, "alias.txt"));
  // A world-readable file nobody vouched for, and the folders that are open.
  put("later-secret.json", 0o644);
  put("commands.json", 0o644);
  mkdirSync(join(ag, "policy"));
  writeFileSync(join(ag, "policy", "rules.json"), "{}");
  mkdirSync(join(ag, "plugins", "acme"), { recursive: true });
  writeFileSync(join(ag, "plugins", "acme", "plugin.json"), "{}");
  writeFileSync(join(ag, "plugins", "acme", "ledger.py"), "x");
  // Mode drift on a name that is on the list.
  writeFileSync(join(ag, "Devices.JSON"), "x");
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  for (const [k, v] of [["XDG_CONFIG_HOME", was.cfg], ["AGENTGLASS_DISK_ROOTS", was.roots]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

const SECRETS = ["token", "credentials.json", "devices.json", "notify-prefs.json", "plugins.json", "secrets.json", "plugin-notes.json"];

describe("a caller on this machine", () => {
  test("lists the folder, keys marked locked with a reason", () => {
    const r = browseDir(ag, false, true);
    expect(r.ok).toBe(true);
    const by = Object.fromEntries(r.entries.map((e) => [e.name, e]));
    expect(by["theme.json"]!.locked).toBe(false);
    expect(by["config.json"]!.locked).toBe(false);
    for (const n of [...SECRETS, "plugin-data", "Devices.JSON"]) {
      expect(by[n]!.locked).toBe(true);
      expect(by[n]!.why).toBe("holds agentglass keys — closed");
    }
    expect(by["theme.json"]!.why).toBeUndefined();
  });

  test("reads an ordinary file", () => {
    expect(fileFacts(join(ag, "theme.json"), true).text).toBe("fake-theme.json");
  });

  test("every key is refused by mode: facts, bytes, open", async () => {
    for (const n of SECRETS) {
      const p = join(ag, n);
      expect(fileFacts(p, true).ok).toBe(false);
      expect(fileFacts(p, true).error).toContain("agentglass's keys");
      expect((await fileBytes(p, true)).ok).toBe(false);
      expect(openInDesktop(p, true).ok).toBe(false);
    }
  });

  test("the private directory and what is inside it are refused", async () => {
    expect(browseDir(join(ag, "plugin-data"), false, true).ok).toBe(false);
    expect(fileFacts(join(ag, "plugin-data", "notes.txt"), true).ok).toBe(false);
  });

  test("the names stay shut even when the mode says readable", () => {
    chmodSync(join(ag, "token"), 0o644);
    chmodSync(join(ag, "credentials.json"), 0o644);
    chmodSync(join(ag, "devices.json"), 0o644);
    chmodSync(join(ag, "secrets.json"), 0o644);
    try {
      for (const n of ["token", "credentials.json", "devices.json", "Devices.JSON", "TOKEN", "secrets.json"]) {
        expect(fileFacts(join(ag, n), true).ok).toBe(false);
      }
      // A link with an innocent name to a drifted key: the resolved name decides.
      expect(fileFacts(join(ag, "alias.txt"), true).ok).toBe(false);
      expect(fileFacts(join(other, "innocent.txt"), true).ok).toBe(false);
      expect(browseDir(ag, false, true).entries.find((e) => e.name === "token")!.locked).toBe(true);
    } finally {
      for (const n of ["token", "credentials.json", "devices.json", "secrets.json"]) chmodSync(join(ag, n), 0o600);
    }
  });

  test("path tricks land on the same answer", async () => {
    for (const p of [
      join(ag, ".", "token"),
      join(ag, "sub", "..", "token"),
      join(other, "..", "cfg", "agentglass", "token"),
      join(other, "innocent.txt"),   // link from an allowed folder into the token
      join(ag, "alias.txt"),         // link inside the folder
      join(ag, "TOKEN"),
    ]) {
      expect(fileFacts(p, true).ok).toBe(false);
      expect((await fileBytes(p, true)).ok).toBe(false);
    }
  });

  test("the folder's siblings under the other XDG bases stay closed", () => {
    const data = join(root, "data", "agentglass");
    mkdirSync(data, { recursive: true });
    const was = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = join(root, "data");
    // Restored, not deleted: the isolation preload's value is what later files read.
    try { expect(browseDir(data, false, true).ok).toBe(false); } finally { if (was === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = was; }
  });
});

describe("reads are an allowlist, not a mode", () => {
  test("a file agentglass does not vouch for is closed however readable", () => {
    expect(fileFacts(join(ag, "later-secret.json"), true).ok).toBe(false);
    expect(browseDir(ag, false, true).entries.find((e) => e.name === "later-secret.json")!.locked).toBe(true);
  });
  test("the named files and folders open; plugins only to the manifest", () => {
    for (const f of ["commands.json", "policy/rules.json", "plugins/acme/plugin.json"]) expect(fileFacts(join(ag, f), true).ok).toBe(true);
    expect(fileFacts(join(ag, "plugins", "acme", "ledger.py"), true).ok).toBe(false);
  });
  test("the browse routes ask 'local' the way the tokenless sinks do: another OS user is not local", async () => {
    const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    const i = src.indexOf('if (pathname === "/browse" || pathname.startsWith("/preview/")) {');
    const blk = src.slice(i, src.indexOf("\n    }\n", i));
    expect(blk).toContain('sinkFrom === "loopback"');
    expect(blk).not.toContain("isLoopback(clientIp)))");
  });
});

describe("any other caller", () => {
  test("the folder and its files stay closed, with a reason", () => {
    const r = browseDir(ag, false, false);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("closed: this folder holds agentglass's keys");
    expect(fileFacts(join(ag, "theme.json"), false).ok).toBe(false);
  });
  test("an unrelated refusal keeps its own words", () => {
    delete process.env.AGENTGLASS_DISK_ROOTS;
    try { expect(browseDir("/etc", false, true).error).toContain("outside"); } finally { process.env.AGENTGLASS_DISK_ROOTS = root; }
  });
});
