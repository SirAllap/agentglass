/*
 * The `accounts` contribution, as data: what a plugin may say about the
 * accounts of a provider, what makes the whole list be refused, and that two
 * plugins cannot both keep the same provider's list. The routes and the events
 * are plugin-accounts-routes.test.ts.
 */
import { afterAll, beforeEach, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACCOUNT_COLOURS, MAX_ACCOUNTS, accountOut, type Account, validateAccountProviders, validateAccounts,
} from "../../shared/pluginAccounts.ts";
import { validateContributes } from "../../shared/pluginUi.ts";
import {
  MANIFEST_NAME, disablePlugin, enablePlugin, installPlugin, isRunning, manifestHash, pluginsConfigDir, resumeEnabledPlugins, validateManifest, __resetPlugins,
} from "../src/plugins.ts";
import { forgetAccounts, setAccounts } from "../src/accounts.ts";
import { __resetSandboxProbe } from "../src/plugin-sandbox.ts";

const account = (over: Record<string, unknown> = {}): Account => ({ id: "acme-a", label: "Acme A", plan: "max", colour: "blue", active: true, storage: "keyring", ...over } as Account);
const input = (accounts: unknown[] = [account()], over: Record<string, unknown> = {}) => ({ provider: "anthropic", accounts, ...over });

describe("validateAccounts", () => {
  test("a clean list comes back as written, with unknown fields dropped", () => {
    const r = validateAccounts(input([{ ...account(), token: "x", extra: { a: 1 } }, account({ id: "acme-b", label: "Acme B", active: false, storage: "file" })], { stray: 1 }));
    expect(r).toEqual({ ok: true, value: { provider: "anthropic", accounts: [account(), account({ id: "acme-b", label: "Acme B", active: false, storage: "file" })] } });
  });

  test("managedBy in the body is not read: the app sets it from the plugin's own name", () => {
    for (const managedBy of ["swapkin", "acme", 1, {}]) {
      const r = validateAccounts(input([account()], { managedBy }));
      expect(r.ok).toBe(true);
      expect(r.ok && "managedBy" in r.value).toBe(false);
    }
  });

  test("deferTo is a closed field: only \"swapkin\" is read, anything else is dropped like an unknown field", () => {
    const kept = validateAccounts(input([account()], { deferTo: "swapkin" }));
    expect(kept.ok && kept.value.deferTo).toBe("swapkin");
    for (const deferTo of ["acme", "SWAPKIN", "", 1, true, {}, ["swapkin"]]) {
      const r = validateAccounts(input([account()], { deferTo }));
      expect(r.ok).toBe(true);
      expect(r.ok && "deferTo" in r.value).toBe(false);
    }
  });

  test("a token split across id, label and plan refuses the whole list", () => {
    // 24+ characters in all, none of the three long enough to be caught alone.
    const split = [
      { id: "a1b2c3d4e5f6", label: "g7h8i9j0k1l2", plan: "m3n4o5p6" },
      { id: "qwe-rty-1234", label: "AsdFgh5678Zxc", plan: "Vbn9" },
      { id: "x9_y8_z7_w6", label: "kj3hd8s2lq0p", plan: "t5r4" },
    ];
    for (const f of split) {
      const r = validateAccounts(input([account(f)]));
      expect(r.ok, JSON.stringify(f)).toBe(false);
      expect(r.ok === false && r.error).not.toContain(f.label);
    }
  });

  test("ordinary long names are not taken for a split token", () => {
    const fine = [
      { id: "personal-work-account", label: "Personal work account", plan: "max" },
      { id: "acme-work-account-1", label: "AcmeWorkAccount1", plan: "enterprise" },
      { id: "acme-a", label: "Acme A", plan: "max 20x" },
      { id: "team-engineering", label: "Engineering", plan: "team premium" },
    ];
    for (const f of fine) expect(validateAccounts(input([account(f)])).ok, JSON.stringify(f)).toBe(true);
  });

  test("a token, a key, a JWT or an email in a visible string refuses the whole list", () => {
    const secrets = ["sk-" + "a".repeat(20), "eyJ" + "a".repeat(17), "A".repeat(24), "0123456789abcdef".repeat(2), "dev@example.org"];
    for (const s of secrets) {
      for (const field of ["label", "plan"] as const) {
        const r = validateAccounts(input([account({ [field]: s.slice(0, field === "plan" ? 24 : 32) })]));
        expect(r.ok, `${field}: ${s}`).toBe(false);
      }
    }
    // The id's own regex lets a long hex run through, and the same check catches it.
    expect(validateAccounts(input([account({ id: "0123456789abcdef01234567" })])).ok).toBe(false);
    // And the refusal does not repeat the secret back.
    const r = validateAccounts(input([account({ label: "sk-" + "a".repeat(20) })]));
    expect(r.ok === false && r.error).not.toContain("oat01");
  });

  test("ordinary words that merely contain the letters are kept", () => {
    expect(validateAccounts(input([account({ label: "task-force", plan: "team 5x" })])).ok).toBe(true);
  });

  test("over-long, empty, wrongly typed and unsafe fields are refused", () => {
    const bad: Record<string, unknown>[] = [
      { label: "x".repeat(33) }, { label: "" }, { label: "   " }, { label: 7 }, { label: "a<b>c" }, { label: "a\nb" },
      { plan: "x".repeat(25) }, { plan: 1 },
      { id: "Acme" }, { id: "-acme" }, { id: "a".repeat(33) }, { id: "a b" }, { id: 4 },
      { colour: "#ff0000" }, { colour: "red" }, { colour: 1 },
      { active: "yes" }, { storage: "disk" }, { storage: undefined },
    ];
    for (const o of bad) expect(validateAccounts(input([account(o)])).ok, JSON.stringify(o)).toBe(false);
  });

  test("the caps: eight accounts, one active, unique ids, a known provider and manager", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => account({ id: `acme-${i}`, label: `Acme ${i}`, active: i === 0 }));
    expect(validateAccounts(input(many(MAX_ACCOUNTS))).ok).toBe(true);
    expect(validateAccounts(input(many(MAX_ACCOUNTS + 1))).ok).toBe(false);
    expect(validateAccounts(input([account(), account({ id: "acme-b" })])).ok).toBe(false);
    expect(validateAccounts(input([account(), account({ active: false })])).ok).toBe(false);
    expect(validateAccounts(input([account({ active: false })])).ok).toBe(true);
    expect(validateAccounts({ provider: "gemini", accounts: [] }).ok).toBe(false);
    expect(validateAccounts(null).ok).toBe(false);
    expect(validateAccounts({ provider: "codex", accounts: "no" }).ok).toBe(false);
  });

  test("every colour the app draws is accepted, and only those", () => {
    for (const colour of ACCOUNT_COLOURS) expect(validateAccounts(input([account({ colour })])).ok, colour).toBe(true);
    expect(ACCOUNT_COLOURS).toContain("neutral");
  });

  test("a reading holds at most six windows, each a real window", () => {
    const w = { label: "5h", minutes: 300, usedPercent: 41.6, resetsAt: "2026-10-24T12:00:00Z" };
    const ok = validateAccounts(input([account({ reading: { windows: [w, { ...w, label: "7d", resetsAt: null }], extra: 1 } })]));
    expect(ok.ok && ok.value.accounts[0]!.reading).toEqual({ windows: [{ ...w, usedPercent: 42 }, { ...w, label: "7d", usedPercent: 42, resetsAt: null }] });
    expect(validateAccounts(input([account({ reading: { windows: Array(7).fill(w) } })])).ok).toBe(false);
    for (const o of [{ usedPercent: 101 }, { usedPercent: -1 }, { usedPercent: "5" }, { minutes: 0 }, { minutes: 1.5 }, { minutes: 10 ** 7 }, { label: "" }, { label: "A".repeat(24) }, { resetsAt: "soon" }, { resetsAt: 5 }]) {
      expect(validateAccounts(input([account({ reading: { windows: [{ ...w, ...o }] } })])).ok, JSON.stringify(o)).toBe(false);
    }
    expect(validateAccounts(input([account({ reading: { windows: "x" } })])).ok).toBe(false);
  });

  test("invisible, direction-control and look-alike characters are refused, and the check runs on the trimmed, normalised text", () => {
    // A right-to-left override or an isolate can make one chip read as another, or as the word "active".
    const bad = ["a\u202Eb", "a\u200Bb", "a\u2066b", "a\uE000b", "\uFEFFacme", "a\u00ADb"];
    for (const s of bad) {
      for (const field of ["label", "plan"] as const) expect(validateAccounts(input([account({ [field]: s })])).ok, `${field}: ${JSON.stringify(s)}`).toBe(false);
    }
    // A fullwidth at-sign is an email once the text is normalised.
    expect(validateAccounts(input([account({ label: "dev\uFF20example.org" })])).ok).toBe(false);
    // Fullwidth letters spell a key once normalised, and spaces round it do not hide it.
    expect(validateAccounts(input([account({ label: "\uFF53\uFF4B-ant-abc" })])).ok).toBe(false);
    expect(validateAccounts(input([account({ label: "  sk-" + "a".repeat(3) + "  " })])).ok).toBe(false);
    // A plain accent is still a name.
    expect(validateAccounts(input([account({ label: "Cuenta pr\u00F3xima" })])).ok).toBe(true);
  });

  test("labels are unique per provider ignoring case, and window labels per account", () => {
    expect(validateAccounts(input([account({ active: false }), account({ id: "acme-b", label: "ACME a ", active: false })])).ok).toBe(false);
    const w = { label: "5h", minutes: 300, usedPercent: 1, resetsAt: null };
    expect(validateAccounts(input([account({ reading: { windows: [w, { ...w, label: "5H" }] } })])).ok).toBe(false);
    expect(validateAccounts(input([account({ reading: { windows: [w, { ...w, label: "7d", minutes: 10080 }] } })])).ok).toBe(true);
  });

  test("accountOut drops the reading", () => {
    const r = validateAccounts(input([account({ reading: { windows: [] } })]));
    expect(r.ok && accountOut(r.value.accounts[0]!)).toEqual(account());
  });
});

describe("contributes.accounts", () => {
  test("a list of known providers, no repeats", () => {
    expect(validateAccountProviders(["anthropic"])).toEqual({ ok: true, value: ["anthropic"] });
    expect(validateContributes({ accounts: ["anthropic", "codex"] })).toEqual({ ok: true, value: { accounts: ["anthropic", "codex"] } });
    for (const bad of [[], ["anthropic", "anthropic"], ["gemini"], "anthropic", [1], ["anthropic", "codex", "antigravity", "x"]]) {
      expect(validateContributes({ accounts: bad }).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  test("the approval hash covers it, so adding a provider asks again", () => {
    const base = { name: "acme-keeper", publisher: "acme", description: "keeps accounts", entrypoint: "true", scope: "read" };
    const a = validateManifest({ ...base, contributes: { accounts: ["anthropic"] } });
    const b = validateManifest({ ...base, contributes: { accounts: ["anthropic", "codex"] } });
    const none = validateManifest(base);
    if (typeof a === "string" || typeof b === "string" || typeof none === "string") throw new Error("manifest refused");
    expect(new Set([manifestHash(a), manifestHash(b), manifestHash(none)]).size).toBe(3);
  });
});

describe("one holder per provider", () => {
  const saved = { b: process.env.AGENTGLASS_BWRAP, u: process.env.AGENTGLASS_PLUGINS_UNBOXED };
  afterAll(() => {
    if (saved.b === undefined) delete process.env.AGENTGLASS_BWRAP; else process.env.AGENTGLASS_BWRAP = saved.b;
    if (saved.u === undefined) delete process.env.AGENTGLASS_PLUGINS_UNBOXED; else process.env.AGENTGLASS_PLUGINS_UNBOXED = saved.u;
    __resetSandboxProbe();
  });
  beforeEach(async () => {
    process.env.NODE_ENV = "test";
    process.env.AGENTGLASS_BWRAP = "/nonexistent/bwrap";
    process.env.AGENTGLASS_PLUGINS_UNBOXED = "1";
    __resetSandboxProbe();
    process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "agx-accounts-"));
    await __resetPlugins();
  });
  afterEach(async () => { await __resetPlugins(); });

  const fixture = (name: string, accounts: string[]): string => {
    const dir = mkdtempSync(join(tmpdir(), "agx-accounts-src-"));
    writeFileSync(join(dir, MANIFEST_NAME), JSON.stringify({ name, publisher: "acme", description: "keeps accounts", entrypoint: "sleep 30", scope: "read", contributes: { accounts } }));
    return dir;
  };

  test("the second plugin to claim a provider is refused, naming the first; another provider is fine", async () => {
    await installPlugin(fixture("acme-keeper-a", ["anthropic"]));
    await installPlugin(fixture("acme-keeper-b", ["anthropic", "codex"]));
    await installPlugin(fixture("acme-keeper-c", ["codex"]));
    expect((await enablePlugin("acme-keeper-a")).ok).toBe(true);
    const second = await enablePlugin("acme-keeper-b");
    expect(second.ok).toBe(false);
    expect(!second.ok && second.error).toContain("acme-keeper-a");
    expect(!second.ok && second.error).toContain("anthropic");
    expect((await enablePlugin("acme-keeper-c")).ok).toBe(true);
  });

  test("a plugins.json edited by hand to switch on two holders starts the first only", async () => {
    await installPlugin(fixture("acme-keeper-a", ["anthropic"]));
    await installPlugin(fixture("acme-keeper-b", ["anthropic"]));
    expect((await enablePlugin("acme-keeper-a")).ok).toBe(true);
    await disablePlugin("acme-keeper-a");
    const file = join(pluginsConfigDir(), "plugins.json");
    const store = JSON.parse(readFileSync(file, "utf8"));
    for (const rec of store.plugins) { rec.enabled = true; rec.approvedFingerprint = rec.fingerprint; }
    writeFileSync(file, JSON.stringify(store));
    expect(await resumeEnabledPlugins()).toEqual(["acme-keeper-a"]);
    expect(isRunning("acme-keeper-a")).toBe(true);
    expect(isRunning("acme-keeper-b")).toBe(false);
  });
});

describe("one list per provider in memory", () => {
  const c = { accounts: ["anthropic" as const] };
  const list = (id: string) => ({ provider: "anthropic", accounts: [account({ id, label: id })] });

  test("a second plugin's post is refused while the first still keeps the list, whichever posted first", () => {
    expect(setAccounts("acme-keeper-a", c, list("acme-a")).ok).toBe(true);
    const r = setAccounts("acme-keeper-b", c, list("acme-b"));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("acme-keeper-a");
    expect(setAccounts("acme-keeper-a", c, list("acme-a")).ok).toBe(true);
    forgetAccounts("acme-keeper-a");
    expect(setAccounts("acme-keeper-b", c, list("acme-b")).ok).toBe(true);
    forgetAccounts("acme-keeper-b");
  });
});
